/** Decimal integers below the frame count, with O(log(frame count)) branches. */
export function nominalFramePattern(seconds: number): string {
  const count = seconds * 30;
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError("Нужна положительная целая длина композиции в кадрах.");
  const bound = String(count);
  const branches = ["0"];
  if (bound.length > 1) branches.push(`[1-9][0-9]{0,${bound.length - 2}}`);
  for (let index = 0; index < bound.length; index++) {
    const first = index === 0 ? 1 : 0;
    const last = Number(bound[index]) - 1;
    if (last < first) continue;
    const digit = first === last ? String(first) : `[${first}-${last}]`;
    const remaining = bound.length - index - 1;
    branches.push(`${bound.slice(0, index)}${digit}${remaining ? `[0-9]{${remaining}}` : ""}`);
  }
  return `(?:${branches.join("|")})`;
}
