import { describe, expect, test } from "vitest";

import {
  classifyYtDlpError,
  formatSelector,
  frameSeek,
  isYoutubeHost,
} from "../../lib/download/policy";

const SELECTOR_720 =
  "bv[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/bv[height<=720][vcodec!~='^(hev1|hvc1|hevc|h265|dvh1|dvhe)']+ba/b[height<=720][vcodec!~='^(hev1|hvc1|hevc|h265|dvh1|dvhe)']/b[height<=720]/w";

describe("адрес YouTube", () => {
  test("узнаёт ролики YouTube и не путает их с чужими хостами", () => {
    for (const host of [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ]) {
      expect(isYoutubeHost(host), host).toBe(true);
    }
    for (const host of ["youtube.com.evil.example", "notyoutube.com", "fakeyoutu.be", "evil.youtube.com.example"]) {
      expect(isYoutubeHost(host), host).toBe(false);
    }
  });
});

describe("селектор формата", () => {
  test("для 720, 360 и 1080 собирает одну и ту же лестницу кодеков", () => {
    expect(formatSelector(720)).toBe(SELECTOR_720);
    expect(formatSelector(360)).toBe(SELECTOR_720.replaceAll("720", "360"));
    expect(formatSelector(1080)).toBe(SELECTOR_720.replaceAll("720", "1080"));
  });
});

describe("момент кадра", () => {
  test("внутри ролика, у конца, после конца и с дробной секундой", () => {
    expect(frameSeek(5, 19.01, 15)).toEqual({ ok: true, seconds: 5 });
    expect(frameSeek(19.01, 19.01, 15).ok && (frameSeek(19.01, 19.01, 15) as { seconds: number }).seconds)
      .toBeCloseTo(18.8766666667, 6);
    expect(frameSeek(99, 19.01, 15)).toEqual({ ok: false, reason: "after_end" });
    expect(frameSeek(5.25, 19.01, 15)).toEqual({ ok: true, seconds: 5.25 });
  });
});

describe("текст ошибки yt-dlp", () => {
  test("различает образцы stderr", () => {
    const samples: [string, string][] = [
      ["ERROR: Private video", "download_unavailable"],
      ["ERROR: Video unavailable", "download_unavailable"],
      ["ERROR: This video is unavailable", "download_unavailable"],
      ["ERROR: No suitable extractor found", "download_unsupported_site"],
      ["ERROR: Unsupported URL: https://example.com/x", "download_unsupported_site"],
      ["ERROR: This video is not available due to geo restriction", "download_geo_blocked"],
      ["ERROR: Sign in to confirm you’re not a bot", "download_login_required"],
      ["ERROR: This video is age-restricted", "download_login_required"],
      ["ERROR: HTTP Error 429: Too Many Requests", "download_rate_limited"],
      ["ERROR: Please try again later", "download_rate_limited"],
      ["ERROR: This video is DRM protected", "download_drm"],
      ["ERROR: HTTP Error 403: Forbidden", "download_failed"],
      ["ERROR: The file must be a Netscape cookies file", "download_failed"],
      ["ERROR: Requested format is not available", "download_failed"],
      ["ERROR: Unable to download webpage: Name or service not known", "download_network"],
    ];
    for (const [stderr, code] of samples) {
      expect(classifyYtDlpError(stderr), stderr).toBe(code);
    }
  });
});
