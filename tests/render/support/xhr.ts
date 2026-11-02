/**
 * Управляемая заглушка `XMLHttpRequest` для тестов отрисовки (#9): тест сам
 * включает события прогресса, успех и ошибку.
 */
import { vi } from "vitest";

export interface FakeXhrInstance {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly aborted: boolean;
  readonly sent: boolean;
  progress(loaded: number, total: number): void;
  succeed(status?: number): void;
  fail(): void;
}

export interface FakeXhrController {
  readonly instances: FakeXhrInstance[];
  last(): FakeXhrInstance;
  restore(): void;
}

class FakeXMLHttpRequest {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = undefined;
  status = 0;
  sent = false;
  aborted = false;

  readonly upload: {
    onprogress?: (event: ProgressEvent) => void;
  } = {};

  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
    this.sent = true;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }

  succeed(status = 200): void {
    this.status = status;
    this.onload?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

/**
 * Подменяет `XMLHttpRequest` в window. Заглушка живёт до `restore()` или до
 * `vi.unstubAllGlobals()` в afterEach.
 */
export function fakeXhr(): FakeXhrController {
  const original = window.XMLHttpRequest;
  const instances: FakeXMLHttpRequest[] = [];

  class ControlledXMLHttpRequest extends FakeXMLHttpRequest {
    constructor() {
      super();
      instances.push(this);
    }
  }

  vi.stubGlobal("XMLHttpRequest", ControlledXMLHttpRequest);

  return {
    get instances() {
      return instances as unknown as FakeXhrInstance[];
    },
    last() {
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("ни одного запроса ещё не было");
      return instance as unknown as FakeXhrInstance;
    },
    restore() {
      vi.stubGlobal("XMLHttpRequest", original);
    },
  };
}
