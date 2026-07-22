/**
 * A tiny, safe markdown-ish renderer for the agent's final report text — no
 * markdown library, no `dangerouslySetInnerHTML`. Parses into a small typed
 * structure (blocks of inline tokens); ReportTab.tsx turns that into real
 * React elements, so anything that isn't recognized markup stays literal
 * text (React escapes string children automatically — there is no HTML
 * injection surface here).
 *
 * Supported: **bold**, `inline code`, bullet lines starting with "- ", and
 * paragraph breaks on a blank line. Everything else is left as plain text.
 */

export type InlineToken = { kind: 'text' | 'bold' | 'code'; value: string };

export type Block =
  | { kind: 'paragraph'; tokens: InlineToken[] }
  | { kind: 'bullets'; items: InlineToken[][] };

// Matches **bold** (non-greedy, no nested `**`) or `code` (no nested backtick).
const INLINE_MARKER = /\*\*([^*]+)\*\*|`([^`]+)`/g;

/** Splits one line of text into bold/code/plain-text tokens, in order. */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  INLINE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_MARKER.exec(text))) {
    if (m.index > lastIndex) tokens.push({ kind: 'text', value: text.slice(lastIndex, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'bold', value: m[1] });
    else tokens.push({ kind: 'code', value: m[2] });
    lastIndex = INLINE_MARKER.lastIndex;
  }
  if (lastIndex < text.length) tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  return tokens;
}

const BULLET_LINE = /^- (.*)$/;

/** Parses the report text into paragraph/bullets blocks, in source order. */
export function parseReportMarkdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const bulletMatch = BULLET_LINE.exec(lines[i]);
    if (bulletMatch) {
      const items: InlineToken[][] = [];
      while (i < lines.length) {
        const m = BULLET_LINE.exec(lines[i]);
        if (!m) break;
        items.push(tokenizeInline(m[1]));
        i++;
      }
      blocks.push({ kind: 'bullets', items });
      continue;
    }
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !BULLET_LINE.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'paragraph', tokens: tokenizeInline(paraLines.join(' ')) });
  }
  return blocks;
}
