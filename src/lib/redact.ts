const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Provider API keys ("sk-…") and long opaque tokens such as Azure DevOps PATs. */
const SECRET_LIKE = /\bsk-[A-Za-z0-9_-]{6,}|[A-Za-z0-9_\-+/=]{32,}/g;

/**
 * Upstream error text is shown to users and stored. Providers do not echo keys
 * today, but if one ever did, the key must not travel further: anything that
 * looks like a key or token is replaced. GUIDs (project and repo ids) are kept.
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_LIKE, (match) => (GUID.test(match) ? match : "[redacted]"));
}
