/**
 * API bridge: Tauri 환경에서는 invoke, 브라우저(5173)에서는 HTTP REST API 사용.
 * HTTP 서버: racemo-server가 127.0.0.1:7399에서 서빙.
 */
import { invoke } from "@tauri-apps/api/core";
import type { GitRepoInfo, GitFileStatuses } from "../types/git";
import type { HookTreeNode } from "../types/hooklog";
import type { ClaudeHistoryEntry, ClaudeSessionMessage } from "../types/claudelog";
import { useSessionStore } from "../stores/sessionStore";
import { getBrowserRemoteClient } from "./webrtcClient";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function getHttpBase(): string {
  const params = new URLSearchParams(window.location.search);
  const candidate = params.get("server") || window.location.hostname;
  const serverHost = ALLOWED_HOSTS.has(candidate) ? candidate : "127.0.0.1";
  return `http://${serverHost}:7399/api`;
}
const HTTP_BASE = getHttpBase();

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

/** Normalize remote list_dir response: host may return flat array or { entries: [...] } */
function normalizeListDirResponse(raw: unknown): DirEntry[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : (raw != null && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).entries))
      ? (raw as Record<string, unknown>).entries as unknown[]
      : [];
  return arr.map((e) => {
    const obj = e as Record<string, unknown>;
    const name = String(obj.name ?? "");
    const isDir = obj.type === "dir" || obj.isDir === true;
    return { name, type: isDir ? "dir" as const : "file" as const };
  });
}

/** Tauri webview 환경인지 감지 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function httpGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${HTTP_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Check if the active session is a remote session. */
export function isRemoteSession(): boolean {
  const id = useSessionStore.getState().activeSessionId;
  return !!id && id.startsWith("remote:");
}

/** Send a notification API call to the remote host (response is ignored). */
export async function remoteApiNotify(method: string, params: Record<string, unknown> = {}): Promise<void> {
  await remoteApiCall(method, params);
}

/** Send an API request to the remote host via WebRTC data channel. */
async function remoteApiCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const paramsJson = JSON.stringify(params);
  // Resolve device_id from the active remote session
  const { useRemoteStore } = await import("../stores/remoteStore");
  const { sessionToDevice } = useRemoteStore.getState();
  const activeId = useSessionStore.getState().activeSessionId;
  const sessionId = activeId?.startsWith("remote:") ? activeId.slice("remote:".length) : undefined;
  const deviceId = (sessionId && sessionToDevice[sessionId]) || null;
  const resultJson = await invoke<string>("remote_api_call", { method, paramsJson, deviceId });
  return JSON.parse(resultJson) as T;
}

export async function apiGetHomeDir(): Promise<string> {
  if (isTauri() && isRemoteSession()) {
    const data = await remoteApiCall<{ path: string }>("home_dir");
    return data.path;
  }
  if (isTauri()) return invoke<string>("get_home_dir");
  const data = await httpGet<{ path: string }>("/home_dir");
  return data.path;
}

export async function apiListDirectory(path: string): Promise<DirEntry[]> {
  if (isTauri() && isRemoteSession()) {
    const raw = await remoteApiCall<unknown>("list_dir", { path });
    return normalizeListDirResponse(raw);
  }
  if (isTauri()) return invoke<DirEntry[]>("list_directory", { path });
  return httpGet<DirEntry[]>("/list_directory", { path });
}

export async function apiListDirectoryGitFiltered(path: string, gitRoot?: string | null): Promise<DirEntry[]> {
  if (isTauri() && isRemoteSession()) return apiListDirectory(path);
  if (isTauri()) return invoke<DirEntry[]>("list_directory_gitfiltered", { path, gitRoot: gitRoot ?? null });
  return apiListDirectory(path);
}

export async function apiDirHasDocs(path: string, extensions: string[]): Promise<boolean> {
  if (isTauri() && isRemoteSession()) return true;
  if (isTauri()) return invoke<boolean>("dir_has_docs", { path, extensions });
  return true;
}

export async function apiGetGitRepoInfo(path: string): Promise<GitRepoInfo> {
  if (isTauri() && isRemoteSession()) {
    return remoteApiCall<GitRepoInfo>("git_info", { path });
  }
  if (isTauri()) return invoke<GitRepoInfo>("git_repo_info", { path });
  return httpGet<GitRepoInfo>("/git/info", { path });
}

export async function apiGetGitFileStatuses(path: string): Promise<GitFileStatuses> {
  if (isTauri() && isRemoteSession()) {
    return remoteApiCall<GitFileStatuses>("git_status", { path });
  }
  if (isTauri()) return invoke<GitFileStatuses>("git_file_statuses", { path });
  return httpGet<GitFileStatuses>("/git/status", { path });
}

export async function apiGitAction(path: string, action: string, filePath?: string, message?: string): Promise<void> {
  if (isTauri() && isRemoteSession()) {
    await remoteApiCall("git_action", { path, action, filePath, message });
    return;
  }
  // Local: use specific invoke commands
  switch (action) {
    case "stage": await invoke("git_stage_file", { path, filePath }); break;
    case "unstage": await invoke("git_unstage_file", { path, filePath }); break;
    case "stage_all": await invoke("git_stage_all", { path }); break;
    case "unstage_all": await invoke("git_unstage_all", { path }); break;
    case "commit": await invoke("git_commit", { path, message }); break;
    case "discard": await invoke("git_discard_file", { path, filePath }); break;
    case "push": await invoke("git_push", { path }); break;
    case "pull": await invoke("git_pull", { path }); break;
    case "gitignore": await invoke("git_add_to_gitignore", { path, pattern: filePath }); break;
    default: throw new Error(`Unknown git action: ${action}`);
  }
}

export async function apiGitDiffFile(path: string, filePath: string, staged: boolean, contextLines?: number): Promise<string> {
  if (isTauri() && isRemoteSession()) {
    const data = await remoteApiCall<{ diff: string }>("git_diff", { path, filePath, staged, contextLines });
    return data.diff;
  }
  if (isTauri()) return invoke<string>("git_diff_file", { path, filePath, staged, contextLines });
  return httpGet<string>("/git/diff", { path, filePath, staged: String(staged), contextLines: String(contextLines ?? 3) });
}

export async function apiGitCommitLog(path: string, count: number, all = false): Promise<import("../types/git").GitCommitEntry[]> {
  if (isTauri() && isRemoteSession()) {
    return remoteApiCall("git_log", { path, count, all });
  }
  if (isTauri()) return invoke("git_commit_log", { path, count, all });
  return httpGet("/git/commit_log", { path, count: String(count), all: String(all) });
}

export async function apiReadTextFile(path: string): Promise<string> {
  if (isTauri() && isRemoteSession()) {
    const data = await remoteApiCall<{ content: string }>("read_file", { path });
    return data.content;
  }
  if (isTauri()) return invoke<string>("read_text_file", { path });
  const data = await httpGet<{ content: string }>("/read_file", { path });
  return data.content;
}

export async function apiWriteTextFile(path: string, content: string): Promise<void> {
  if (isTauri() && isRemoteSession()) {
    await remoteApiCall("write_file", { path, content });
    return;
  }
  if (isTauri()) {
    await invoke("write_text_file", { path, content });
    return;
  }
  // Browser mode write not yet supported
  throw new Error("Write not supported in browser mode");
}

export async function apiGetRecentDirs(): Promise<string[]> {
  if (isTauri()) return invoke<string[]>("get_recent_dirs");
  return httpGet<string[]>("/recent_dirs");
}

export async function apiSaveRecentDir(path: string): Promise<void> {
  if (isTauri()) {
    await invoke("add_recent_dir", { path });
    return;
  }
  const url = new URL(`${HTTP_BASE}/recent_dirs`);
  await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function apiDeleteRecentDir(path: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_recent_dir", { path });
    return;
  }
  const url = new URL(`${HTTP_BASE}/recent_dirs`);
  await fetch(url.toString(), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** Write data/command to a PTY, supporting both local and remote sessions. */
export async function apiWriteToPty(paneId: string, data: Uint8Array | number[]): Promise<void> {
  const bytes = Array.isArray(data) ? new Uint8Array(data) : data;

  if (!isTauri()) {
    // Browser mode: always remote
    getBrowserRemoteClient().sendInput(paneId, bytes);
    return;
  }

  if (isRemoteSession()) {
    // Tauri mode + Remote session
    await invoke("write_to_remote_pty", { paneId, data: Array.from(bytes) });
    return;
  }

  // Local session
  await invoke("write_to_pty", { paneId, data: Array.from(bytes) });
}

/** Read hook log as tree. Remote session → DataChannel RPC, local → Tauri invoke. */
export async function apiReadHookLog(): Promise<HookTreeNode[]> {
  if (isTauri() && isRemoteSession()) {
    return remoteApiCall<HookTreeNode[]>("hook_log", { max: 20 });
  }
  return invoke<HookTreeNode[]>("read_hook_log");
}

/** Clear hook log file (Tauri-only) */
export async function apiClearHookLog(): Promise<void> {
  await invoke("clear_hook_log");
}

/** Read Claude Code history (Tauri-only, local) */
export async function apiReadClaudeLogHistory(max?: number): Promise<ClaudeHistoryEntry[]> {
  return invoke<ClaudeHistoryEntry[]>("read_claude_log_history", { max: max ?? null });
}

/** Read Claude Code session messages (Tauri-only, local) */
export async function apiReadClaudeLogSession(project: string, sessionId: string): Promise<ClaudeSessionMessage[]> {
  return invoke<ClaudeSessionMessage[]>("read_claude_log_session", { project, sessionId });
}

/** Check if ~/.codex directory exists (Tauri-only, local) */
export async function apiCheckCodexDirExists(): Promise<boolean> {
  return invoke<boolean>("check_codex_dir_exists");
}

/** Read Codex CLI history entries (Tauri-only, local) */
export async function apiReadCodexLogHistory(max?: number): Promise<import("../types/codexlog").CodexHistoryEntry[]> {
  return invoke("read_codex_log_history", { max: max ?? null });
}

/** Read Codex CLI session messages (Tauri-only, local) */
export async function apiReadCodexLogSession(sessionId: string): Promise<[import("../types/codexlog").CodexSessionMeta | null, import("../types/codexlog").CodexSessionMessage[]]> {
  return invoke("read_codex_log_session", { sessionId });
}

/** Check if ~/.gemini/tmp directory exists (Tauri-only, local) */
export async function apiCheckGeminiDirExists(): Promise<boolean> {
  return invoke<boolean>("check_gemini_dir_exists");
}

/** Read Gemini CLI history entries (Tauri-only, local) */
export async function apiReadGeminiLogHistory(max?: number): Promise<import("../types/geminilog").GeminiHistoryEntry[]> {
  return invoke("read_gemini_log_history", { max: max ?? null });
}

/** Read Gemini CLI session messages (Tauri-only, local) */
export async function apiReadGeminiLogSession(projectHash: string, tag: string): Promise<import("../types/geminilog").GeminiSessionMessage[]> {
  return invoke("read_gemini_log_session", { projectHash, tag });
}

/** Check if OpenCode data directory exists (Tauri-only, local) */
export async function apiCheckOpenCodeDirExists(): Promise<boolean> {
  return invoke<boolean>("check_opencode_dir_exists");
}

/** Read OpenCode history entries (Tauri-only, local) */
export async function apiReadOpenCodeLogHistory(max?: number): Promise<import("../types/opencodelog").OpenCodeHistoryEntry[]> {
  return invoke("read_opencode_log_history", { max: max ?? null });
}

/** Read OpenCode session messages (Tauri-only, local) */
export async function apiReadOpenCodeLogSession(sessionId: string): Promise<import("../types/opencodelog").OpenCodeSessionMessage[]> {
  return invoke("read_opencode_log_session", { sessionId });
}
