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

// 청크 경계 보호용 최대 tail 크기.
// - 일반 시크릿(JWT ~500, AWS secret 80, GitHub PAT 90)은 소폭으로 충분.
// - Private Key PEM 한 줄은 ~65자이고 전체 헤더는 짧지만, 멀티라인 키 전체를 한번에
//   잡고 싶지는 않음(패턴은 BEGIN 헤더만 탐지). 따라서 4KB면 현실적인 상한.
// - 더 큰 값은 메모리/지연↑, 더 작은 값은 긴 시크릿 분할 누락↑.
const TAIL_BUFFER_BYTES = 4096;

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
 * Mask secrets in terminal output text (stateless / per-chunk).
 *
 * Known limitation: masking operates per PTY write chunk. A secret split
 * across two chunks (e.g. `sk-abc` + `def...`) won't be detected here.
 * For stream-aware detection that handles split secrets, use
 * `createSecretStreamMasker()`.
 */
export function maskSecrets(raw: string): string {
  return maskSecretsWithPatterns(raw, getPatterns());
}

/**
 * Stream-aware secret masker that carries a small tail buffer between chunks
 * to detect secrets that span PTY write boundaries.
 *
 * Usage:
 *   const mask = createSecretStreamMasker();
 *   const safe1 = mask.push("sk-abc");       // holds content pending
 *   const safe2 = mask.push("defghijk...");   // flushes masked combined
 *   const tail = mask.flush();                // emit any remaining buffer
 *
 * Guarantees:
 * - 전체 출력의 byte-for-byte 보존(이상 없는 부분은 그대로 통과).
 * - ANSI 시퀀스는 마스킹 대상이 아니며 원형 유지.
 * - 최대 TAIL_BUFFER_BYTES 만큼의 데이터가 한 턴 뒤로 지연될 수 있음.
 *
 * 사용처: 원격 피어에게 보내기 직전, 또는 로컬 터미널 표시 직전.
 */
export interface SecretStreamMasker {
  /** 새 chunk를 주입하고, 이번 턴에 flush 가능한 마스킹된 문자열을 반환. */
  push(chunk: string): string;
  /** 내부 버퍼를 비우고(보류 중인 꼬리 포함) 마스킹된 나머지를 반환. */
  flush(): string;
}

export function createSecretStreamMasker(
  patterns: RegExp[] = getPatterns(),
  tailBytes: number = TAIL_BUFFER_BYTES,
): SecretStreamMasker {
  let buffer = "";

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      buffer += chunk;
      // ANSI 시퀀스 경계를 절대 깨지 않도록 tail 길이를 안전하게 계산.
      // 전체 버퍼가 tail 이하면 모두 보류.
      if (buffer.length <= tailBytes) {
        return "";
      }
      // tail 시작 인덱스 — 이 이후(tail)는 보류, 이전은 flush.
      let splitAt = buffer.length - tailBytes;
      // ANSI 이스케이프(ESC=0x1b) 중간에서 자르지 않도록 조정.
      // ESC 이후 종료자(알파벳, BEL, ST)까지 유예.
      const escIdx = findUnterminatedAnsiStart(buffer, splitAt);
      if (escIdx !== -1 && escIdx < splitAt) {
        splitAt = escIdx;
      }
      const emitted = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt);
      return maskSecretsWithPatterns(emitted, patterns);
    },
    flush(): string {
      const rest = buffer;
      buffer = "";
      return maskSecretsWithPatterns(rest, patterns);
    },
  };
}

/**
 * `from` 이후에 종결되지 않은 ANSI 이스케이프의 시작 인덱스를 찾음.
 * 없으면 -1. 있으면 그 ESC 앞까지만 flush해야 안전.
 */
function findUnterminatedAnsiStart(buf: string, from: number): number {
  // buf[from..] 범위에서 ESC(0x1b) 등장 후 종결자가 없는 경우 true.
  // 단순화를 위해 from 이후 ESC가 하나라도 있고 끝까지 종결되지 않으면 그 위치 반환.
  const escCode = 0x1b;
  for (let i = from; i < buf.length; i++) {
    if (buf.charCodeAt(i) !== escCode) continue;
    // 이 ESC가 tail 안에서 종결되는지 확인.
    const rest = buf.slice(i);
    ANSI_RE.lastIndex = 0;
    const m = ANSI_RE.exec(rest);
    if (m && m.index === 0) {
      // 종결됨 — 다음 byte로.
      i += m[0].length - 1;
      continue;
    }
    // 미종결 ESC.
    return i;
  }
  return -1;
}
