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

// ANSI escape sequence pattern
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

/**
 * Mask secrets in terminal output text.
 * Preserves ANSI escape sequences to prevent terminal rendering breakage.
 */
export function maskSecrets(raw: string): string {
  // Collect ANSI sequences and their positions
  const ansiSegments: { start: number; end: number; text: string }[] = [];
  let match: RegExpExecArray | null;

  // Reset and collect ANSI sequences
  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(raw)) !== null) {
    ansiSegments.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }

  if (ansiSegments.length === 0) {
    // No ANSI sequences — simple path
    return applyPatterns(raw);
  }

  // Replace ANSI sequences with NUL placeholders of same length
  let sanitized = raw;
  for (const seg of ansiSegments) {
    const placeholder = "\x00".repeat(seg.text.length);
    sanitized =
      sanitized.slice(0, seg.start) + placeholder + sanitized.slice(seg.end);
  }

  // Apply secret patterns on sanitized text
  sanitized = applyPatterns(sanitized);

  // Restore ANSI sequences
  for (const seg of ansiSegments) {
    const before = sanitized.slice(0, seg.start);
    const after = sanitized.slice(seg.start + seg.text.length);
    sanitized = before + seg.text + after;
  }

  return sanitized;
}

function applyPatterns(text: string): string {
  const patterns = getPatterns();
  let result = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, MASK);
  }
  return result;
}
