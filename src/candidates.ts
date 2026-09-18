/**
 * candidates.ts — closed candidate sets extracted from the prompt.
 *
 * The agent may only type strings from `typeCandidates` and navigate to
 * URLs from `urlCandidates`. Nothing else is ever typed or navigated to:
 * when Jev picks `type`/`navigate` with the `none` choice, the agent
 * finishes instead of inventing text or a URL.
 *
 * Extraction sources (and nothing else):
 * - double- or single-quoted strings in the prompt
 * - unquoted phrases after "search for" / "type" / "enter"
 * - explicit `https?://` URLs in the prompt
 * - the optional `--url` value passed alongside the prompt
 */

export interface ExtractedCandidates {
  /** Strings the agent is allowed to type (deduped, order of appearance). */
  typeCandidates: string[];
  /** URLs the agent is allowed to navigate to (deduped, order of appearance). */
  urlCandidates: string[];
}

const MAX_CANDIDATES = 20;
const MAX_CANDIDATE_LEN = 200;

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const QUOTED_RE = /"([^"]+)"|'([^']+)'/g;
const TRIGGER_RE = /(?:search\s+for|type|enter)\s+(?:"([^"]+)"|'([^']+)'|([^.,;!?\n]+))/gi;

/** Trailing sentence punctuation that URL regexes tend to swallow. */
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;!?)\]]+$/g, "").trim();
}

function cleanCandidate(raw: string): string {
  return raw.replace(/^[\s"'“”‘’([{<>]+/, "").replace(/[\s"'“”‘’)\]}>]+$/, "").trim();
}

/** Cut an unquoted trigger capture at a clause boundary ("and …", "then …"). */
function truncateClause(raw: string): string {
  const parts = raw.split(
    /\s+(?:and|then|on|in|at|to|into|from|for|with|using|via)\b/i,
  );
  return (parts[0] ?? raw).trim();
}

function pushUnique(out: string[], value: string): void {
  const v = value.trim();
  if (!v || v.length > MAX_CANDIDATE_LEN) return;
  // Keep the "none" sentinel unambiguous in every Choice criteria.
  if (v.toLowerCase() === "none") return;
  if (!out.includes(v)) out.push(v);
}

/** Quoted strings + phrases after search for / type / enter (never URLs). */
export function extractTypeCandidates(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(QUOTED_RE)) {
    const raw = cleanCandidate(m[1] ?? m[2] ?? "");
    if (!raw || URL_RE.test(raw)) {
      URL_RE.lastIndex = 0;
      continue;
    }
    URL_RE.lastIndex = 0;
    pushUnique(out, raw);
  }
  for (const m of prompt.matchAll(TRIGGER_RE)) {
    const quoted = m[1] ?? m[2];
    if (quoted !== undefined) {
      pushUnique(out, cleanCandidate(quoted));
      continue;
    }
    const unquoted = truncateClause(cleanCandidate(m[3] ?? ""));
    if (!unquoted || /^https?:\/\//i.test(unquoted)) continue;
    pushUnique(out, unquoted);
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Explicit `https?://` URLs in the prompt plus the optional `--url`. */
export function extractUrlCandidates(prompt: string, url?: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(URL_RE)) {
    const cleaned = cleanUrl(m[0] ?? "");
    if (cleaned) pushUnique(out, cleaned);
  }
  const extra = (url ?? "").trim();
  if (extra) pushUnique(out, cleanUrl(extra));
  return out.slice(0, MAX_CANDIDATES);
}

/** Closed candidate sets for one prompt (and optional `--url`). */
export function extractCandidates(
  prompt: string,
  url?: string,
): ExtractedCandidates {
  return {
    typeCandidates: extractTypeCandidates(prompt),
    urlCandidates: extractUrlCandidates(prompt, url),
  };
}
