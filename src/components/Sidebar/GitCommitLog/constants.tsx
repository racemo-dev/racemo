export const FILE_STATUS_STYLE: Record<string, { label: string; color: string }> = {
    M: { label: "Modified", color: "var(--accent-yellow)" },
    A: { label: "Added", color: "var(--status-active)" },
    D: { label: "Deleted", color: "var(--accent-red)" },
    R: { label: "Renamed", color: "var(--accent-blue)" },
};

// ── Graph constants ────────────────────────────────────────
export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 26;
export const DOT_R = 3.5;
export const DOT_R_HEAD = 5;
export const GRAPH_PADDING = 8;

// ── Context menu styles ────────────────────────────────────
export const menuBtnClass = "sb-ctx-item text-left hover:bg-[var(--bg-overlay)] transition-colors";
export const menuSep = <div className="my-1" style={{ borderTop: "1px solid var(--border-default)" }} />;

export function parseGitHubUrl(remoteUrl: string): string | null {
    const sshMatch = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;
    const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;
    return null;
}
