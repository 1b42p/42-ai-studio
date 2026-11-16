export function rewriteEndpointEvent(event: string, serverUrl: URL, id: string): string {
  const lines = event.split(/\r?\n/);
  if (!lines.some((line) => /^event:\s*endpoint\s*$/.test(line))) return event;
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  let endpoint: URL;
  try { endpoint = new URL(data, serverUrl); }
  catch { throw new Error("invalid endpoint"); }
  if (endpoint.origin !== serverUrl.origin || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("invalid endpoint");
  }
  const replacement = `/api/mcp-proxy/${id}/o${endpoint.pathname}${endpoint.search}`;
  let inserted = false;
  return lines.flatMap((line) => {
    if (!line.startsWith("data:")) return [line];
    if (inserted) return [];
    inserted = true;
    return [`data: ${replacement}`];
  }).join("\n");
}
