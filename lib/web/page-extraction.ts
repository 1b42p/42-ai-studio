import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

export interface PageExtraction {
  title: string;
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
  lang: string | null;
  extraction: "article" | "page";
  content: string;
  textLength: number;
}

// Строка намеренно самодостаточна: eve переносит authored-модули в каталог
// сборки, поэтому путь к отдельному файлу воркера там не существует.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
try {
  const { JSDOM, VirtualConsole } = require(workerData.modules.jsdom);
  const { Readability } = require(workerData.modules.readability);
  const Turndown = require(workerData.modules.turndown);
  const { gfm } = require(workerData.modules.gfm);
  // runScripts и resources не включаются: ни кода страницы, ни сетевых загрузок.
  // VirtualConsole без forwardTo не раскрывает HTML/URL в ошибках CSS и DOM.
  const dom = new JSDOM(workerData.html, {
    url: workerData.finalUrl, virtualConsole: new VirtualConsole()
  });
  try {
    const doc = dom.window.document;
    const value = (text) => typeof text === "string" && text.trim() ? text.trim() : null;
    const meta = (selectors) => value(doc.querySelector(selectors)?.getAttribute("content"));
    const metadata = {
      title: meta('meta[property="og:title"], meta[name="twitter:title"]') || doc.title || "",
      byline: meta('meta[name="author"], meta[property="article:author"]'),
      siteName: meta('meta[property="og:site_name"]'),
      publishedTime: meta('meta[property="article:published_time"], meta[name="date"], meta[itemprop="datePublished"]'),
      lang: value(doc.documentElement.getAttribute("lang"))
    };
    // Не используем непроверенный <base>: адреса вычисляются от finalUrl.
    for (const base of doc.querySelectorAll("base")) base.remove();
    const sanitize = (root) => {
      for (const node of root.querySelectorAll("script,style,noscript,template,svg,iframe,object,embed")) node.remove();
      for (const node of root.querySelectorAll("a[href],img[src]")) {
        const attr = node.tagName === "IMG" ? "src" : "href";
        try {
          const url = new URL(node.getAttribute(attr), workerData.finalUrl);
          const schemes = attr === "src" ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"];
          if (!schemes.includes(url.protocol)) {
            if (attr === "src") node.remove(); else node.removeAttribute(attr);
          } else node.setAttribute(attr, url.href);
        } catch {
          if (attr === "src") node.remove(); else node.removeAttribute(attr);
        }
      }
    };
    let article = null;
    if (workerData.extract === "auto") {
      // Readability изменяет документ. Оригинал нужен для fallback всей страницы.
      // Слишком много узлов — page, без дорогого клонирования/анализа статьи.
      if (doc.getElementsByTagName("*").length <= 20000) {
        try { article = new Readability(doc.cloneNode(true), { maxElemsToParse: 20000 }).parse(); }
        catch { article = null; }
      }
    }
    let root = doc.body;
    let extraction = "page";
    if (article && (article.textContent || "").trim().length >= 500) {
      root = doc.createElement("div");
      root.innerHTML = article.content;
      extraction = "article";
      for (const key of Object.keys(metadata)) metadata[key] = value(article[key]) || metadata[key];
    }
    sanitize(root);
    const textLength = (root.textContent || "").trim().length;
    const converter = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced", preformattedCode: true });
    converter.use(gfm);
    // Штатное правило turndown распознаёт только PRE с первым ребёнком CODE.
    // Подсветка через span или пробел перед code не должны схлопывать строки.
    converter.addRule("preformattedBlock", {
      filter: "pre",
      replacement: (_content, node) => {
        const code = node.querySelector("code") || node;
        const language = (code.getAttribute("class") || "").match(/language-([a-zA-Z0-9_+-]+)/)?.[1] || "";
        const text = node.textContent || "";
        const marker = String.fromCharCode(96);
        let size = 3;
        for (const run of text.matchAll(new RegExp("^" + marker + "{3,}", "gm"))) size = Math.max(size, run[0].length + 1);
        const fence = marker.repeat(size);
        return "\n\n" + fence + language + "\n" + text.replace(/\n$/, "") + "\n" + fence + "\n\n";
      }
    });
    const content = converter.turndown(root)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    parentPort.postMessage({ ok: true, result: { ...metadata, extraction, content, textLength } });
  } finally { dom.window.close(); }
} catch {
  // Ни стек, ни сообщение библиотеки не передаются: они могут содержать страницу.
  parentPort.postMessage({ ok: false });
}
`;

/** Отмена прекращает синхронный разбор, не блокируя общий процесс eve. */
export async function extractPage(
  html: string,
  finalUrl: string,
  extract: "auto" | "page",
  signal: AbortSignal,
): Promise<PageExtraction> {
  signal.throwIfAborted();
  const requireFromApp = createRequire(resolve(process.cwd(), "package.json"));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      html, finalUrl, extract,
      modules: {
        jsdom: requireFromApp.resolve("jsdom"),
        readability: requireFromApp.resolve("@mozilla/readability"),
        turndown: requireFromApp.resolve("turndown"),
        gfm: requireFromApp.resolve("@joplin/turndown-plugin-gfm"),
      },
    },
  });
  let onAbort: () => void = () => {};
  try {
    return await new Promise<PageExtraction>((resolveResult, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message: { ok: boolean; result: PageExtraction }) => {
        if (message.ok) resolveResult(message.result);
        else reject(new Error("page_extraction_failed"));
      });
      worker.once("error", () => reject(new Error("page_extraction_failed")));
      worker.once("exit", () => reject(new Error("page_extraction_failed")));
      if (signal.aborted) onAbort();
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await worker.terminate();
  }
}
