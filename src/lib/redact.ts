const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Provider API keys ("sk-…") and long opaque tokens such as Azure DevOps PATs. No "/": URL paths stay readable. */
const SECRET_LIKE = /\bsk-[A-Za-z0-9_-]{6,}|[A-Za-z0-9_\-+=]{32,}/g;
/** Base64 keys can contain "/" and "+"; a run with "/" is still a path when one of its segments is a plain word. */
const BASE64_LIKE = /[A-Za-z0-9+/]{32,}={0,2}/g;
const WORD = /^[a-z]{3,}$/;

/**
 * Upstream error text is shown to users and stored. Providers do not echo keys
 * today, but if one ever did, the key must not travel further: anything that
 * looks like a key or token is replaced. GUIDs (project and repo ids) are kept.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BASE64_LIKE, (match) =>
      !/[+/]/.test(match) || (!match.includes("+") && match.split("/").some((segment) => WORD.test(segment))) ? match : "[redacted]"
    )
    .replace(SECRET_LIKE, (match) => (GUID.test(match) ? match : "[redacted]"));
}
