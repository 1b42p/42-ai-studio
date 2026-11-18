import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { examples } from "../../lib/examples";
import { loadConfig } from "../../lib/config";
import { fetchApp } from "./support/app";

const expected = [
  {
    id: "explainer",
    title: "Как устроен светофор",
    features: ["Озвучка", "Субтитры", "Схемы"],
    format: "16:9",
    min: 25,
    max: 45,
    request: "Сделай объясняющий ролик на 30 секунд «Как устроен светофор»: три сцены, русская озвучка женским голосом, субтитры по словам, спокойная схематичная графика.",
  },
  {
    id: "promo-vertical",
    title: "Акция кофейни",
    features: ["Вертикальный формат", "Озвучка", "Субтитры"],
    format: "9:16",
    min: 15,
    max: 30,
    request: "Сделай вертикальный рекламный ролик на 20 секунд для кофейни на углу: акция «Второй кофе в подарок по будням до 11:00», крупный текст, русская озвучка мужским голосом, субтитры.",
  },
  {
    id: "data-chart",
    title: "Выручка кофейни за полгода",
    features: ["Графики", "Озвучка", "Субтитры"],
    format: "16:9",
    min: 25,
    max: 45,
    request: "Сделай ролик на 30 секунд с анимированными графиками: выручка кофейни по месяцам 2025 года (янв 120, фев 135, мар 150, апр 142, май 168, июн 190 тыс. рублей) и доля напитков (кофе 54 %, чай 21 %, десерты 25 %). Русская озвучка, субтитры.",
  },
] as const;

function probe(file: string) {
  return JSON.parse(execFileSync(loadConfig().ffprobePath, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file,
  ], { encoding: "utf8" })) as {
    streams: {
      codec_type: string;
      codec_name: string;
      profile?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string;
    }[];
    format: { duration: string };
  };
}

function atomNames(bytes: Buffer) {
  const names: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(offset);
    names.push(bytes.toString("ascii", offset + 4, offset + 8));
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size === 0) break;
    if (size < 8 || offset + size > bytes.length) throw new Error("Повреждённый MP4");
    offset += size;
  }
  return names;
}

describe("публичная главная", () => {
  test("гость видит страницу, метаданные и все возможности без входа и JavaScript", async () => {
    const response = await fetchApp("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    const html = await response.text();
    expect(html).toContain('lang="ru"');
    expect(html).toContain("<title>42 AI Studio — видео из одной просьбы</title>");
    expect(html).toContain('content="Опишите ролик словами — агент сам напишет анимацию, озвучит, добавит субтитры и пришлёт готовое видео."');
    for (const title of [
      "Озвучка", "Субтитры по словам", "Анимация без шаблонов", "Графики из ваших данных",
      "Презентации и статьи", "Видео по ссылкам", "Фоновая музыка", "Правки репликами",
    ]) expect(html).toContain(title);
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain("/api/auth/telegram/login?next=%2Fs");
  });

  test("готовое видео доступно целиком и диапазоном с длительным кэшированием", async () => {
    const example = examples.find(({ id }) => id === "explainer");
    expect(example).toBeDefined();
    const full = await fetchApp(example!.video);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("video/mp4");
    expect(full.headers.get("cache-control")).toContain("max-age=31536000");
    expect(full.headers.get("cache-control")).toContain("immutable");
    expect(full.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    const fullBytes = Buffer.from(await full.arrayBuffer());

    const range = await fetchApp(example!.video, {
      headers: { Range: "bytes=0-1023" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-type")).toContain("video/mp4");
    expect(range.headers.get("content-range")).toBe(`bytes 0-1023/${fullBytes.length}`);
    expect(range.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await range.arrayBuffer())).toEqual(fullBytes.subarray(0, 1024));
  });

  test("манифест описывает три настоящих ролика и постеры в допустимых пределах", async () => {
    expect(examples.map(({ id }) => id).sort()).toEqual(expected.map(({ id }) => id).sort());
    let total = 0;
    for (const requirement of expected) {
      const example = examples.find(({ id }) => id === requirement.id)!;
      expect(example.title).toBe(requirement.title);
      expect(example.features).toEqual(requirement.features);
      expect(example.request).toBe(requirement.request);
      expect(example.format).toBe(requirement.format);
      expect(example.video).toMatch(new RegExp(`^/examples/${requirement.id}-v\\d+\\.mp4$`));
      expect(example.poster).toMatch(new RegExp(`^/examples/${requirement.id}-v\\d+\\.jpg$`));
      const videoPath = path.join("public", example.video);
      const posterPath = path.join("public", example.poster);
      const bytes = await readFile(videoPath);
      expect(example.bytes).toBe(bytes.length);
      expect(bytes.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      total += bytes.length;
      expect((await stat(posterPath)).size).toBeLessThanOrEqual(150 * 1024);

      const media = probe(videoPath);
      const video = media.streams.find(({ codec_type }) => codec_type === "video")!;
      const audio = media.streams.find(({ codec_type }) => codec_type === "audio")!;
      const dimensions = requirement.format === "16:9" ? [1280, 720] : [720, 1280];
      expect([video.width, video.height]).toEqual(dimensions);
      expect([example.width, example.height]).toEqual(dimensions);
      expect(video.codec_name).toBe("h264");
      expect(video.profile).toBe("High");
      expect(video.pix_fmt).toBe("yuv420p");
      expect(video.avg_frame_rate).toBe("30/1");
      expect(audio.codec_name).toBe("aac");
      const duration = Number(media.format.duration);
      expect(duration).toBeGreaterThanOrEqual(requirement.min);
      expect(duration).toBeLessThanOrEqual(requirement.max);
      expect(example.durationSec).toBeCloseTo(duration, 2);
      const poster = probe(posterPath).streams[0];
      expect(poster.codec_name).toBe("mjpeg");
      expect([poster.width, poster.height]).toEqual(dimensions);
      const atoms = atomNames(bytes);
      expect(atoms).toContain("moov");
      expect(atoms).toContain("mdat");
      expect(atoms.indexOf("moov")).toBeLessThan(atoms.indexOf("mdat"));
    }
    expect(total).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
