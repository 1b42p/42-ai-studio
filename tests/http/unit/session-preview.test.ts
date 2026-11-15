import { describe, expect, test } from "vitest";

import {
  previewContentType,
  previewPath,
  previewSizeAllowed,
} from "../../../lib/session-preview/validation";

describe("проверка превью", () => {
  test("предел включает ровно 1 МиБ", () => {
    expect(previewSizeAllowed(1_048_576)).toBe(true);
    expect(previewSizeAllowed(1_048_577)).toBe(false);
    expect(previewSizeAllowed(-1)).toBe(false);
    expect(previewSizeAllowed(Number.NaN)).toBe(false);
  });

  test("только путь внутри workspace без любого компонента ..", () => {
    expect(previewPath("out/p.jpg")).toBe("/workspace/out/p.jpg");
    expect(previewPath("/workspace/out/p.jpg")).toBe("/workspace/out/p.jpg");
    for (const path of ["../../etc/passwd", "/etc/passwd", "out/../p.jpg", "out/%2e%2e/p.jpg", "/workspace", "", "out\\p.jpg", "out/\np.jpg"]) {
      expect(previewPath(path), path).toBeNull();
    }
  });
  test("тип определяется по байтам PNG, JPEG и WebP, а не имени", () => {
    expect(previewContentType(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(previewContentType(Uint8Array.from([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(previewContentType(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(previewContentType(new TextEncoder().encode("not a jpg"))).toBeNull();
    expect(previewContentType(new Uint8Array())).toBeNull();
  });
});
