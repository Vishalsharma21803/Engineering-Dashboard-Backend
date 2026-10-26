/** A gap an AI draft leaves for facts only the developer knows: [[fill in: root cause]]. */
const PLACEHOLDER = /\[\[\s*fill in[^\]]*\]\]/i;

export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}
