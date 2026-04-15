/**
 * AI CLI error pattern → actionable user guidance mapping.
 * When an AI command fails, match stderr/error output against known patterns
 * and return a helpful suggestion the user can act on.
 */

interface ErrorGuide {
  /** Regex to test against the combined error output */
  pattern: RegExp;
  /** Which AI CLI this applies to (null = any) */
  command?: string;
  /** i18n key for the guidance message */
  key: string;
  /** Fallback English message */
  en: string;
  /** Fallback Korean message */
  ko: string;
}

const GUIDES: ErrorGuide[] = [
  // ── Gemini ──
  {
    pattern: /Please set an Auth method|GEMINI_API_KEY|settings\.json/i,
    command: "gemini",
    key: "aiGuide.geminiAuth",
    en: "Run `gemini auth login` in your terminal to authenticate, or set GEMINI_API_KEY environment variable.",
    ko: "터미널에서 `gemini auth login`을 실행하여 인증하거나, GEMINI_API_KEY 환경변수를 설정하세요.",
  },
  {
    pattern: /quota|rate.?limit|resource.?exhausted/i,
    command: "gemini",
    key: "aiGuide.geminiQuota",
    en: "Gemini API quota exceeded. Wait a moment and try again, or check your API plan.",
    ko: "Gemini API 할당량 초과. 잠시 후 다시 시도하거나, API 플랜을 확인하세요.",
  },

  // ── Claude ──
  {
    pattern: /not logged in|please log in|invalid.*api.?key|ANTHROPIC_API_KEY|unauthorized/i,
    command: "claude",
    key: "aiGuide.claudeAuth",
    en: "Run `claude login` in your terminal to authenticate, or set ANTHROPIC_API_KEY environment variable.",
    ko: "터미널에서 `claude login`을 실행하여 인증하거나, ANTHROPIC_API_KEY 환경변수를 설정하세요.",
  },
  {
    pattern: /quota|rate.?limit|overloaded/i,
    command: "claude",
    key: "aiGuide.claudeQuota",
    en: "Claude API rate limited. Wait a moment and try again.",
    ko: "Claude API 속도 제한. 잠시 후 다시 시도하세요.",
  },

  // ── Codex ──
  {
    pattern: /OPENAI_API_KEY|api.?key.*required|authentication/i,
    command: "codex",
    key: "aiGuide.codexAuth",
    en: "Set the OPENAI_API_KEY environment variable to use Codex CLI.",
    ko: "Codex CLI를 사용하려면 OPENAI_API_KEY 환경변수를 설정하세요.",
  },

  // ── Generic (any AI CLI) ──
  {
    pattern: /is not installed|not found|No such file/i,
    key: "aiGuide.notInstalled",
    en: "The AI CLI tool is not installed. Install it first and make sure it's available in your PATH.",
    ko: "AI CLI 도구가 설치되지 않았습니다. 먼저 설치하고 PATH에 추가되어 있는지 확인하세요.",
  },
  {
    pattern: /ECONNREFUSED|network|connection.*refused|timeout/i,
    key: "aiGuide.network",
    en: "Network error. Check your internet connection and try again.",
    ko: "네트워크 오류. 인터넷 연결을 확인한 후 다시 시도하세요.",
  },
];

/**
 * Match error output against known AI CLI error patterns.
 * Returns a user-friendly guidance string, or null if no match.
 */
export function getAiErrorGuide(
  errorOutput: string,
  command?: string,
  language: string = "en",
): string | null {
  for (const guide of GUIDES) {
    if (guide.command && command && !command.includes(guide.command)) continue;
    if (guide.pattern.test(errorOutput)) {
      return language === "ko" ? guide.ko : guide.en;
    }
  }
  return null;
}
