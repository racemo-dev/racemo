import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../stores/historyStore";
import { useSettingsStore } from "../stores/settingsStore";
import { isRemoteSession } from "./bridge";
import type { CompletionItem, CompletionSpec, CompletionSubcommand } from "../types/autocomplete";

let specs: Record<string, CompletionSpec> | null = null;

async function loadSpecs(): Promise<Record<string, CompletionSpec>> {
  if (specs) return specs;
  const [gitSpec, dockerSpec, npmSpec, kubectlSpec] = await Promise.all([
    import("./completionSpecs/git.json").then((m) => m.default),
    import("./completionSpecs/docker.json").then((m) => m.default),
    import("./completionSpecs/npm.json").then((m) => m.default),
    import("./completionSpecs/kubectl.json").then((m) => m.default),
  ]);
  specs = {
    git: gitSpec as CompletionSpec,
    docker: dockerSpec as CompletionSpec,
    npm: npmSpec as CompletionSpec,
    kubectl: kubectlSpec as CompletionSpec,
  };
  return specs;
}

interface DirEntry {
  name: string;
  type: string;
}

/**
 * Tokenize a shell command line (basic: space-split, quote-aware).
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " ") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return tokens;
}

/**
 * Get completions for current input.
 */
export async function getCompletions(
  input: string,
  cwd: string,
): Promise<CompletionItem[]> {
  const trimmed = input.trimStart();
  if (!trimmed) return [];

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return [];

  const results: CompletionItem[] = [];
  const toolName = tokens[0];
  const lastToken = tokens[tokens.length - 1] || "";
  const isTypingFirstToken = tokens.length === 1 && !input.endsWith(" ");
  const hasTrailingSpace = input.endsWith(" ");

  // 1. CLI tool completions
  const loadedSpecs = await loadSpecs();
  const spec = loadedSpecs[toolName];
  if (spec && !isTypingFirstToken) {
    const cliItems = matchSpec(spec, tokens.slice(1), hasTrailingSpace);
    results.push(...cliItems);
  }

  // 2. History completions — match full input against history
  if (trimmed.length >= 2) {
    const historyItems = getHistoryCompletions(trimmed);
    results.push(...historyItems);
  }

  // 3. Path completions — skip if user hasn't started typing a parameter yet
  //    (i.e. only trailing space with no partial → show history only if available)
  const pathToken = hasTrailingSpace ? "" : lastToken;
  const skipPathForHistory = hasTrailingSpace && pathToken === "" && results.length > 0;
  if (!skipPathForHistory && shouldDoPathCompletion(tokens, pathToken, spec, hasTrailingSpace)) {
    const pathItems = await getPathCompletions(pathToken, cwd);
    results.push(...pathItems);
  }

  // Deduplicate by label (case-insensitive, trimmed), sort case-exact matches first, then limit
  const seen = new Set<string>();
  const deduped = results.filter((item) => {
    const key = `${item.kind}:${item.label.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => {
    const aExact = a.label.startsWith(lastToken) ? 0 : 1;
    const bExact = b.label.startsWith(lastToken) ? 0 : 1;
    return aExact - bExact;
  });
  return deduped.slice(0, 8);
}

// Commands that commonly take file/directory path arguments.
const PATH_COMMANDS = new Set([
  "cd", "ls", "ll", "cat", "less", "more", "head", "tail",
  "vim", "vi", "nvim", "nano", "code", "subl", "open",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown",
  "source", ".", "bat", "find", "tree", "du", "df",
  "tar", "zip", "unzip", "gzip", "gunzip",
  "scp", "rsync",
]);

function shouldDoPathCompletion(
  tokens: string[],
  pathToken: string,
  spec: CompletionSpec | undefined,
  hasTrailingSpace: boolean,
): boolean {
  const cmd = tokens[0];

  // Single token with trailing space → command typed, now expecting argument
  if (tokens.length === 1 && hasTrailingSpace) {
    if (PATH_COMMANDS.has(cmd)) return true;
    // Known spec commands with filepath args (e.g. "git " → not yet, need subcommand first)
    return false;
  }

  // Still typing the first token — no path completions
  if (tokens.length === 1) return false;

  // Show paths if token starts with ./ or / or ~
  if (pathToken.startsWith("./") || pathToken.startsWith("/") || pathToken.startsWith("~")) {
    return true;
  }
  // Show paths for whitelisted commands that take file/dir args
  if (!spec && PATH_COMMANDS.has(cmd)) return true;
  // Show paths for known commands that take file args (e.g. git add <path>)
  if (spec) {
    const sub = spec.subcommands?.[tokens[1]];
    if (sub?.args?.template === "filepaths") return true;
  }
  return false;
}

function matchSpec(
  spec: CompletionSpec,
  args: string[],
  hasTrailingSpace: boolean,
): CompletionItem[] {
  const subs = spec.subcommands;
  if (!subs) return [];

  // Resolve nested subcommands
  let current: CompletionSubcommand | undefined;
  let remainingArgs = [...args];

  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];
    const parent = current ? current.subcommands : subs;
    if (parent && parent[arg]) {
      current = parent[arg];
      remainingArgs = remainingArgs.slice(i + 1);
      i = -1; // restart loop with remaining args
    } else {
      break;
    }
  }

  const results: CompletionItem[] = [];
  const partial = hasTrailingSpace ? "" : (remainingArgs[remainingArgs.length - 1] || "");
  const lowerPartial = partial.toLowerCase();

  // If we have a resolved subcommand, suggest its options/subcommands
  if (current) {
    // Sub-subcommands
    if (current.subcommands) {
      for (const [name, sub] of Object.entries(current.subcommands)) {
        if (lowerPartial && !name.toLowerCase().startsWith(lowerPartial)) continue;
        results.push({
          label: name,
          insertText: name,
          kind: "subcommand",
          description: sub.description,
        });
      }
    }
    // Options
    if (current.options && partial.startsWith("-")) {
      for (const opt of current.options) {
        if (opt.name.startsWith(lowerPartial) || (opt.alias && opt.alias.startsWith(lowerPartial))) {
          results.push({
            label: opt.name,
            insertText: opt.name,
            kind: "option",
            description: opt.description,
          });
        }
      }
    }
  } else {
    // No resolved subcommand — suggest top-level subcommands
    for (const [name, sub] of Object.entries(subs)) {
      if (lowerPartial && !name.toLowerCase().startsWith(lowerPartial)) continue;
      results.push({
        label: name,
        insertText: name,
        kind: "subcommand",
        description: sub.description,
      });
    }
  }

  return results;
}

async function getPathCompletions(
  partial: string,
  cwd: string,
): Promise<CompletionItem[]> {
  let dir = cwd;
  let filePartial = partial;

  if (partial.includes("/")) {
    const lastSlash = partial.lastIndexOf("/");
    const dirPart = partial.slice(0, lastSlash + 1);
    filePartial = partial.slice(lastSlash + 1);

    if (dirPart.startsWith("/")) {
      dir = dirPart;
    } else if (dirPart.startsWith("~/")) {
      // Will be resolved in Rust
      dir = dirPart;
    } else {
      dir = cwd + "/" + dirPart;
    }
  }

  try {
    let entries: DirEntry[];
    if (isRemoteSession()) {
      const resultJson = await invoke<string>("remote_api_call", {
        method: "list_directory_filtered",
        paramsJson: JSON.stringify({ dir, partial: filePartial }),
      });
      entries = JSON.parse(resultJson) as DirEntry[];
    } else {
      entries = await invoke<DirEntry[]>("list_directory_filtered", {
        dir,
        partial: filePartial,
      });
    }
    return entries.map((e) => ({
      label: e.type === "dir" ? e.name + "/" : e.name,
      insertText: e.type === "dir" ? e.name + "/" : e.name,
      kind: e.type === "dir" ? "directory" as const : "file" as const,
    }));
  } catch {
    return [];
  }
}

function getHistoryCompletions(inputSoFar: string): CompletionItem[] {
  const entries = useHistoryStore.getState().entries;
  const maxCount = useSettingsStore.getState().historyCompletionCount;
  const lowerInput = inputSoFar.toLowerCase();

  // Sort: favorites first, then by timestamp (newest first)
  const sorted = [...entries].sort((a, b) => {
    const favA = a.favorite ? 0 : 1;
    const favB = b.favorite ? 0 : 1;
    if (favA !== favB) return favA - favB;
    const tsA = a.timestamp ?? 0;
    const tsB = b.timestamp ?? 0;
    return tsB - tsA;
  });

  const seen = new Set<string>();
  const results: CompletionItem[] = [];

  for (const entry of sorted) {
    if (results.length >= maxCount) break;
    const cmd = entry.command;
    const lowerCmd = cmd.toLowerCase();
    const normalizedCmd = lowerCmd.replace(/\s+/g, " ").trim();
    if (lowerCmd.startsWith(lowerInput) && cmd !== inputSoFar && !seen.has(normalizedCmd)) {
      seen.add(normalizedCmd);
      // insertText = the remaining part after what's already typed
      const remaining = cmd.slice(inputSoFar.length);
      results.push({
        label: cmd,
        insertText: remaining,
        kind: "history",
        description: entry.favorite ? "★ favorite" : "history",
        favorite: entry.favorite,
      });
    }
  }

  return results;
}
