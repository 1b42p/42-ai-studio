import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("читает документы и сохраняет точные данные без сети", async () => {
  const { stdout, stderr } = await promisify(execFile)("uv", [
    "run", "--python", "3.12",
    "--with", "pdfplumber==0.11.10", "--with", "python-pptx==1.0.2",
    "--with", "openpyxl==3.1.5", "--with", "charset-normalizer==3.5.2",
    "--with", "reportlab==4.4.10",
    "python", "tests/python/inspect_document_test.py",
  ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(`${stdout}\n${stderr}`).toMatch(/\bOK\b/u);
}, 180_000);
