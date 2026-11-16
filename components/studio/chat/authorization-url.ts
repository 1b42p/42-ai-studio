/** HTTP exceptions must come from trusted server configuration, never message data. */
export function safeAuthorizationUrl(
  value: string | undefined,
  allowHosts: readonly string[] = [],
): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url;
    return url.protocol === "http:" && allowHosts.includes(url.host) ? url : null;
  } catch {
    return null;
  }
}
