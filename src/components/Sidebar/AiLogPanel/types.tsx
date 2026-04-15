/* eslint-disable react-refresh/only-export-components -- shared types/helpers file with components */
import {
  apiCheckCodexDirExists,
  apiCheckGeminiDirExists,
  apiCheckOpenCodeDirExists,
  apiReadClaudeLogSession,
  apiReadCodexLogSession,
  apiReadGeminiLogSession,
  apiReadOpenCodeLogSession,
} from "../../../lib/bridge";
import ClaudeLogPanel from "../ClaudeLogPanel";
import CodexLogPanel from "../CodexLogPanel";
import GeminiLogPanel from "../GeminiLogPanel";
import OpenCodeLogPanel from "../OpenCodeLogPanel";
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from "./ProviderIcons";

/* ─── Provider registry ─── */

export interface AiProvider {
  id: string;
  label: string;
  icon: React.ReactNode;
  checkExists?: () => Promise<boolean>;
  panel: React.ComponentType;
}

export const AI_PROVIDERS: AiProvider[] = [
  { id: "claude", label: "Claude", icon: <ClaudeIcon />, panel: ClaudeLogPanel },
  { id: "codex", label: "Codex", icon: <CodexIcon />, checkExists: apiCheckCodexDirExists, panel: CodexLogPanel },
  { id: "gemini", label: "Gemini", icon: <GeminiIcon />, checkExists: apiCheckGeminiDirExists, panel: GeminiLogPanel },
  { id: "opencode", label: "OpenCode", icon: <OpenCodeIcon />, checkExists: apiCheckOpenCodeDirExists, panel: OpenCodeLogPanel },
];

export const PROVIDER_ICON_MAP: Record<string, React.ReactNode> = Object.fromEntries(
  AI_PROVIDERS.map((p) => [p.id, p.icon]),
);

/* ─── Unified entry for All tab ─── */

export interface UnifiedEntry {
  providerId: string;
  display: string;
  timestamp: number;
  /** Opaque key for loading session detail */
  sessionKey: string;
  /** Project/cwd path for folder filtering */
  cwd: string;
  /** Gemini project hash (SHA256 of project path) for folder filtering */
  geminiHash?: string;
}

export interface UnifiedMessage {
  role: string;
  content: string;
  tool_name?: string;
  input_tokens: number;
  output_tokens: number;
}

export type SessionLoader = (key: string) => Promise<UnifiedMessage[]>;

export function buildSessionLoader(): SessionLoader {
  return async (key: string) => {
    const [provider, ...rest] = key.split("|");
    if (provider === "claude") {
      const [project, sessionId] = rest;
      const msgs = await apiReadClaudeLogSession(project, sessionId);
      return msgs.map((m) => ({ role: m.role, content: m.content, tool_name: m.tool_uses?.[0]?.name, input_tokens: m.input_tokens, output_tokens: m.output_tokens }));
    }
    if (provider === "codex") {
      const sessionId = rest[0];
      const [, msgs] = await apiReadCodexLogSession(sessionId);
      return msgs.map((m) => ({ role: m.role, content: m.content, tool_name: m.tool_name, input_tokens: m.input_tokens, output_tokens: m.output_tokens }));
    }
    if (provider === "gemini") {
      const [projectHash, tag] = rest;
      const msgs = await apiReadGeminiLogSession(projectHash, tag);
      return msgs.map((m) => ({ role: m.role, content: m.content, tool_name: m.tool_name, input_tokens: m.input_tokens, output_tokens: m.output_tokens }));
    }
    if (provider === "opencode") {
      const sessionId = rest[0];
      const msgs = await apiReadOpenCodeLogSession(sessionId);
      return msgs.map((m) => ({ role: m.role, content: m.content, tool_name: m.tool_name, input_tokens: m.input_tokens, output_tokens: m.output_tokens }));
    }
    return [];
  };
}

export const sessionCache = new Map<string, UnifiedMessage[]>();
