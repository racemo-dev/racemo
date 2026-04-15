import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, DEFAULT_AI_TEMPLATE } from "../stores/settingsStore";

const DEFAULT_LANG: Record<string, string> = {
  en: "Write in English.",
  ko: "반드시 한국어로 작성하세요.",
  ja: "日本語で書いてください。",
  zh: "请用中文撰写。",
};

const COMMIT_LANG: Record<string, string> = {
  en: "Write the commit message in English.",
  ko: "커밋 메시지를 반드시 한국어로 작성하세요. 영어로 작성하지 마세요.",
  ja: "コミットメッセージは必ず日本語で書いてください。英語で書かないでください。",
  zh: "请务必用中文撰写提交信息。不要用英语写。",
};

const LANG_PROMPTS: Record<string, Record<string, string>> = {
  review: {
    en: "Write the review in English.",
    ko: "리뷰를 반드시 한국어로 작성하세요.",
    ja: "レビューは必ず日本語で書いてください。",
    zh: "请务必用中文撰写审查。",
  },
  commit: COMMIT_LANG,
  pr: DEFAULT_LANG,
  "auto-commit": COMMIT_LANG,
  fix: {
    en: "Fix the code. No explanations needed.",
    ko: "코드를 수정하세요. 설명은 필요 없습니다.",
    ja: "コードを修正してください。説明は不要です。",
    zh: "修复代码。不需要解释。",
  },
};

/**
 * Load a prompt by name (e.g. "review", "commit", "pr", "auto-commit").
 * Reads from ~/.racemo/prompts/{name}.md if it exists.
 * Substitutes variables: {lang}, {branch}, {base}, {review}
 */
let ensurePromise: Promise<void> | null = null;

function ensurePromptsDir(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = invoke<string>("get_prompts_dir")
      .then(() => {})
      .catch((e) => { ensurePromise = null; throw e; });
  }
  return ensurePromise;
}

export async function loadPrompt(
  name: string,
  vars?: { branch?: string; base?: string; review?: string },
): Promise<string | null> {
  await ensurePromptsDir();
  const content = await invoke<string | null>("read_prompt_file", { name: `${name}.md` });
  if (!content) return null;

  const { language } = useSettingsStore.getState();
  const langMap = LANG_PROMPTS[name] || DEFAULT_LANG;
  const langPrompt = langMap[language] || langMap.en;

  return content
    .replace(/\{lang\}/g, langPrompt)
    .replace(/\{branch\}/g, vars?.branch || "")
    .replace(/\{base\}/g, vars?.base || "main")
    .replace(/\{review\}/g, vars?.review || "");
}

/**
 * Build AI command args from the configured template + prompt.
 */
export function buildAiCommand(prompt: string): { command: string; args: string[]; promptIndex: number } {
  const { aiTemplate } = useSettingsStore.getState();
  const template = aiTemplate || DEFAULT_AI_TEMPLATE;
  const parts = template.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const command = parts[0] || "claude";
  let promptIndex = -1;
  const args = parts.slice(1).map((arg, i) => {
    const cleaned = arg.replace(/^"|"$/g, "");
    if (cleaned === "{prompt}") {
      promptIndex = i;
      return prompt;
    }
    return cleaned;
  });
  return { command, args, promptIndex };
}

/**
 * Load prompt + build AI command in one step.
 * Prompt is always loaded from ~/.racemo/prompts/{name}.md (auto-created on first use).
 */
export async function loadPromptAndBuildCommand(
  name: string,
  vars?: { branch?: string; base?: string; review?: string },
): Promise<{ command: string; args: string[]; promptIndex: number }> {
  const prompt = await loadPrompt(name, vars);
  if (!prompt) {
    throw new Error(`No prompt available for '${name}'`);
  }
  return buildAiCommand(prompt);
}
