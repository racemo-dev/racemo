import { usePrivacyStore } from "../stores/privacyStore";

const DEFAULT_PATTERNS: RegExp[] = [
  // API Keys (generic prefixes)
  /(?:sk-|pk-|api[_-]?key[_-]?)[a-zA-Z0-9]{20,}/g,

  // AWS Access Key ID
  /AKIA[0-9A-Z]{16}/g,

  // AWS Secret Access Key in context
  /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/g,

  // GitHub tokens
  /(?:ghp_|gho_|github_pat_|ghu_|ghs_)[a-zA-Z0-9_]{30,}/g,

  // Slack tokens
  /xox[bpras]-[a-zA-Z0-9-]{10,}/g,

  // JWT
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,

  // Generic password/secret in assignments
  /(?:password|passwd|pwd|secret|token|api_key|apikey|access_token)\s*[=:]\s*['"]?[^\s'"]{8,}/gi,

  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,

  // Env var with sensitive name = long value
  /(?:^|[\s;])(?:[A-Z_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL))\s*=\s*['"]?[a-zA-Z0-9/+=._-]{16,}/gm,
];

const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

// ANSI escape sequence pattern (CSI / OSC-BEL / OSC-ST)
// eslint-disable-next-line no-control-regex -- ANSI escape sequences require control characters
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\][^\x1b]*\x1b\\/g;

let compiledPatterns: RegExp[] | null = null;

function getPatterns(): RegExp[] {
  if (compiledPatterns) return compiledPatterns;
  const custom = usePrivacyStore
    .getState()
    .customPatterns.map((p) => {
      try {
        return new RegExp(p, "g");
      } catch {
        return null;
      }
    })
    .filter((p): p is RegExp => p !== null);
  compiledPatterns = [...DEFAULT_PATTERNS, ...custom];
  return compiledPatterns;
}

/** Call when custom patterns change. */
export function invalidatePatternCache() {
  compiledPatterns = null;
}

type Token = { kind: "ansi" | "plain"; text: string };

// Split raw into alternating ANSI and plain-text tokens.
// Keeps ANSI sequences untouched so they never enter secret regex and length changes don't misalign them.
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_RE.exec(raw)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: "plain", text: raw.slice(last, m.index) });
    }
    tokens.push({ kind: "ansi", text: m[0] });
    last = m.index + m[0].length;
    // Guard against zero-width matches (shouldn't happen with ANSI_RE, but defensive).
    if (m[0].length === 0) ANSI_RE.lastIndex++;
  }
  if (last < raw.length) {
    tokens.push({ kind: "plain", text: raw.slice(last) });
  }
  return tokens;
}

function applyPatterns(text: string, patterns: RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, MASK);
  }
  return result;
}

/**
 * Pure, dependency-free core. Exported for testing/reuse.
 * Applies `patterns` only to plain-text tokens; ANSI sequences are passed through unchanged.
 */
export function maskSecretsWithPatterns(raw: string, patterns: RegExp[]): string {
  if (raw.length === 0) return raw;
  const tokens = tokenize(raw);
  let out = "";
  for (const t of tokens) {
    out += t.kind === "plain" ? applyPatterns(t.text, patterns) : t.text;
  }
  return out;
}

/**
 * Mask secrets in terminal output text.
 *
 * Known limitation (v0.0.8): masking operates per PTY write chunk. A secret
 * split across two chunks (e.g. `sk-abc` + `def...`) won't be detected.
 * A per-pane tail buffer is planned for v0.0.9.
 */
export function maskSecrets(raw: string): string {
  return maskSecretsWithPatterns(raw, getPatterns());
}
