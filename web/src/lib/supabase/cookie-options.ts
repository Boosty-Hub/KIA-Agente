/**
 * Embed-friendly cookie attributes (CHIPS) for when this agent is framed
 * cross-site by the Boosty Hub workspace. A default SameSite=Lax session cookie
 * is NOT sent inside a cross-site iframe, so the brokered magic-link logs in but
 * the session evaporates. SameSite=None; Secure; Partitioned keeps it, scoped to
 * the embedding top-level site. Applied ONLY in an embedded context so normal
 * top-level use and local http dev keep the safer SameSite=Lax default.
 */
export const EMBED_COOKIE_OPTIONS = {
  sameSite: "none",
  secure: true,
  partitioned: true,
} as const;

export function isEmbeddedContext(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
