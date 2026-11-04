/**
 * Тестовый сервер Edge TTS: список голосов и WebSocket синтеза в формате
 * `@andresaya/edge-tts` 1.9.1. Состояние меняется по HTTP с loopback.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const EDGE_TTS_PORT = 59101;

export type EdgeTtsMode =
  | "ok"
  | "rate_limit"
  | "fail"
  | "no_boundaries"
  | "close_1007"
  | "forbidden";

export interface EdgeTtsCalls {
  handshakes: number;
  requests: string[];
  voiceRequests: number;
}

export interface EdgeTtsServer {
  url: string;
  close(): Promise<void>;
}

/** 12 000 байт → ровно 1000 мс при 96 кбит/с. */
export const SAMPLE_MP3 = new Uint8Array(12_000);
for (let index = 0; index < SAMPLE_MP3.length; index++) SAMPLE_MP3[index] = index % 251;

const VOICES = [
  { Name: "Microsoft Svetlana", ShortName: "ru-RU-SvetlanaNeural", Gender: "Female", Locale: "ru-RU" },
  { Name: "Microsoft Dmitry", ShortName: "ru-RU-DmitryNeural", Gender: "Male", Locale: "ru-RU" },
  { Name: "Microsoft Ava", ShortName: "en-US-AvaNeural", Gender: "Female", Locale: "en-US" },
  { Name: "Microsoft Andrew", ShortName: "en-US-AndrewNeural", Gender: "Male", Locale: "en-US" },
  {
    Name: "Microsoft Ava Multilingual",
    ShortName: "en-US-AvaMultilingualNeural",
    Gender: "Female",
    Locale: "en-US",
  },
];

interface ServerState {
  mode: EdgeTtsMode;
  remaining: number | null;
  handshakes: number;
  requests: string[];
  voiceRequests: number;
}

function freshState(): ServerState {
  return { mode: "ok", remaining: null, handshakes: 0, requests: [], voiceRequests: 0 };
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function headerPath(head: string): string {
  return /Path:([^\r\n]*)/i.exec(head)?.[1]?.trim() ?? "";
}

function parseTextFrame(text: string): { path: string; body: string } {
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) return { path: headerPath(text), body: "" };
  return { path: headerPath(text.slice(0, split)), body: text.slice(split + 4) };
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractSpokenText(ssml: string): string {
  const match = /<prosody\b[^>]*>([\s\S]*?)<\/prosody>/.exec(ssml);
  return unescapeXml(match?.[1] ?? "").trim();
}

function textFrame(path: string, body = ""): string {
  return `Path:${path}\r\n\r\n${body}`;
}

function audioFrame(body: Uint8Array): Buffer {
  const header = Buffer.from("Path:audio\r\n", "utf8");
  const frame = Buffer.alloc(2 + header.length + body.length);
  frame.writeUInt16BE(header.length, 0);
  header.copy(frame, 2);
  Buffer.from(body).copy(frame, 2 + header.length);
  return frame;
}

function metadataFor(text: string): string {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const metadata = [
    ...words.map((word, index) => ({
      Type: "WordBoundary",
      Data: {
        Offset: index * 2_000_000,
        Duration: 1_500_000,
        text: { Text: word },
      },
    })),
    {
      Type: "SentenceBoundary",
      Data: {
        Offset: 0,
        Duration: 10_000_000,
        text: { Text: text },
      },
    },
  ];
  return JSON.stringify({ Metadata: metadata });
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void {
  const body = reason;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  socket.destroy();
}

function takeMode(state: ServerState): EdgeTtsMode {
  const current = state.mode;
  if (state.remaining !== null) {
    state.remaining -= 1;
    if (state.remaining <= 0) {
      state.mode = "ok";
      state.remaining = null;
    }
  }
  return current;
}

function speak(socket: WebSocket, mode: EdgeTtsMode, text: string): void {
  if (mode === "close_1007") {
    socket.close(1007, "Unsupported voice");
    return;
  }
  socket.send(textFrame("turn.start"));
  if (mode !== "no_boundaries") socket.send(textFrame("audio.metadata", metadataFor(text)));
  socket.send(audioFrame(SAMPLE_MP3));
  socket.send(textFrame("turn.end"));
}

export function startEdgeTtsServer(port = EDGE_TTS_PORT): Promise<EdgeTtsServer> {
  const state = freshState();
  const sockets = new WebSocketServer({ noServer: true });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "HEAD") {
      response.writeHead(200, { Date: new Date().toUTCString(), "Content-Length": "0" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/voices") {
      state.voiceRequests += 1;
      sendJson(response, 200, VOICES);
      return;
    }
    if (request.method === "GET" && url.pathname === "/__calls") {
      if (!isLoopback(request)) {
        response.writeHead(403).end();
        return;
      }
      sendJson(response, 200, {
        handshakes: state.handshakes,
        requests: state.requests,
        voiceRequests: state.voiceRequests,
      } satisfies EdgeTtsCalls);
      return;
    }
    if (request.method === "POST" && url.pathname === "/__control") {
      if (!isLoopback(request)) {
        response.writeHead(403).end();
        return;
      }
      void readBody(request)
        .then((raw) => {
          const body = JSON.parse(raw) as { mode?: EdgeTtsMode; count?: number | null };
          const mode = body.mode ?? "ok";
          state.mode = mode;
          state.remaining = body.count === undefined || body.count === null ? null : body.count;
          state.handshakes = 0;
          state.requests = [];
          state.voiceRequests = 0;
          sendJson(response, 200, { ok: true });
        })
        .catch(() => {
          if (!response.headersSent) sendJson(response, 400, { ok: false });
        });
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/tts") {
      socket.destroy();
      return;
    }
    state.handshakes += 1;
    const mode = takeMode(state);
    if (mode === "rate_limit") {
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    if (mode === "forbidden") {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (mode === "fail") {
      rejectUpgrade(socket, 500, "Internal Server Error");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = parseTextFrame(data.toString());
        if (frame.path !== "ssml") return;
        const text = extractSpokenText(frame.body);
        state.requests.push(text);
        speak(ws, mode, text);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        async close() {
          sockets.close();
          await new Promise<void>((done, fail) => {
            server.close((error) => (error === undefined ? done() : fail(error)));
          });
        },
      });
    });
  });
}
