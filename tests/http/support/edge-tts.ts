/** Управление тестовым сервером Edge TTS из процесса теста. */
import { loadConfig } from "../../../lib/config";
import { EDGE_TTS_PORT, type EdgeTtsCalls, type EdgeTtsMode } from "./edge-tts-server";

function controlUrl(path: string): URL {
  return new URL(path, loadConfig().edgeTtsVoicesUrl ?? `http://127.0.0.1:${EDGE_TTS_PORT}`);
}

async function control(mode: EdgeTtsMode, count?: number | null): Promise<void> {
  const response = await fetch(controlUrl("/__control"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, count: count ?? null }),
  });
  if (!response.ok) throw new Error(`edge tts control ${response.status}`);
}

export const edgeTtsStub = {
  setMode(mode: EdgeTtsMode, count?: number | null): Promise<void> {
    return control(mode, count);
  },
  async calls(): Promise<EdgeTtsCalls> {
    const response = await fetch(controlUrl("/__calls"));
    if (!response.ok) throw new Error(`edge tts calls ${response.status}`);
    return (await response.json()) as EdgeTtsCalls;
  },
  reset(): Promise<void> {
    return control("ok", null);
  },
};
