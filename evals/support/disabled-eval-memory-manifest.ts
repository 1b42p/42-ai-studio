/**
 * Only agent/memory.ts's framework resolver, not a provider tool or arbitrary
 * dynamic module. That slot rejects non-studio/user callers before any database
 * access; eve skips provider recall, capture and tools when scope is null.
 * This exception relies on eval sessions using the studio-eval principal.
 */
export function isDisabledEvalMemoryResolverManifest(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (entry.owner === null || typeof entry.owner !== "object") return false;
  const owner = entry.owner as Record<string, unknown>;
  return owner.kind === "framework" && owner.feature === "memory" &&
    entry.slug === "memory" &&
    entry.logicalPath === "tools/memory.ts" &&
    entry.sourceId === "eve:memory-wrapper:tools/memory.ts:from:memory.ts" &&
    entry.sourceKind === "module" &&
    Array.isArray(entry.eventNames) && entry.eventNames.length === 1 &&
    entry.eventNames[0] === "turn.started";
}
