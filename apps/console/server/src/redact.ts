import type { ConsoleConfig } from './console-config.js';

const REDACTED = '«redacted»';

// Values shorter than this are excluded: a short secret (e.g. a 2-3 char
// token) risks colliding with ordinary log text and redacting things that
// aren't actually the secret, while providing little real protection anyway.
const MIN_SECRET_LENGTH = 5;

/**
 * Collects the known config secrets worth redacting from run logs/reports:
 * the Jenkins API token and the ES password. Both are optional on
 * `ConsoleConfig`, and either may be short/placeholder-y in a dev config —
 * only values at least `MIN_SECRET_LENGTH` characters long are included.
 */
export function buildRedactList(cfg: ConsoleConfig | null): string[] {
  if (!cfg) return [];
  const candidates = [cfg.jenkins?.apiToken, cfg.es?.password, cfg.srp?.cookie];
  return candidates.filter(
    (s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH
  );
}

/**
 * Builds a redactor closure that replaces every occurrence of any secret in
 * `list` with a fixed placeholder. Sorted longest-first so that when one
 * secret is a substring of another, the longer one is matched whole rather
 * than being partially replaced (which would leak the non-overlapping
 * remainder into the log). Uses split/join rather than a regex — secrets are
 * arbitrary strings that may contain regex metacharacters and must be
 * matched literally.
 */
export function makeRedactor(list: string[]): (s: string | undefined) => string | undefined {
  const ordered = [...list].sort((a, b) => b.length - a.length);
  return (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    let out = s;
    for (const secret of ordered) {
      if (secret) out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}
