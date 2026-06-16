import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowClockwise, X, WifiHigh } from "@phosphor-icons/react";

interface PaneProcessInfo {
  pane_id: string;
  session_id: string;
  session_name: string | null;
  pid: number;
  command: string;
  ports: number[];
}

const POLL_INTERVAL_MS = 3000;
const KILLED_HIDE_MS = 3000;

export default function ServersPanel() {
  const [processes, setProcesses] = useState<PaneProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const fetchingRef = useRef(false);
  const killedPidsRef = useRef<Map<number, number>>(new Map());

  const refresh = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PaneProcessInfo[]>("list_pane_processes");
      const now = Date.now();
      const killed = killedPidsRef.current;
      // Drop expired entries
      for (const [pid, ts] of killed) {
        if (now - ts > KILLED_HIDE_MS) killed.delete(pid);
      }
      setProcesses(result.filter((p) => !killed.has(p.pid)));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id == null) id = setInterval(refresh, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    if (document.visibilityState !== "hidden") start();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        refresh();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const killProcess = useCallback(async (pid: number) => {
    setKilling((prev) => new Set(prev).add(pid));
    try {
      await invoke("kill_pane_process", { pid });
      // Hide for a short window so the next poll doesn't flicker the row back in.
      killedPidsRef.current.set(pid, Date.now());
      setProcesses((prev) => prev.filter((p) => p.pid !== pid));
    } catch (e) {
      setError(String(e));
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ fontSize: 'calc(12px * var(--ui-scale))' }}>
      <div
        className="flex items-center justify-between px-2 shrink-0"
        style={{ height: 'calc(28px * var(--ui-scale))', borderBottom: '1px solid var(--border-default)' }}
      >
        <span style={{ color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.05em', fontSize: 'calc(11px * var(--ui-scale))' }}>
          SERVERS
        </span>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            background: 'none',
            border: 'none',
            cursor: loading ? 'default' : 'pointer',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            padding: 2,
          }}
          title="Refresh"
        >
          <ArrowClockwise
            size={14}
            style={{
              width: 'calc(14px * var(--ui-scale))',
              height: 'calc(14px * var(--ui-scale))',
              animation: loading ? 'spin 0.8s linear infinite' : undefined,
            }}
          />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div style={{ color: 'var(--accent-red)', padding: 'calc(8px * var(--ui-scale))' }}>
            {error}
          </div>
        )}

        {!error && processes.length === 0 && !loading && (
          <div
            className="flex flex-col items-center justify-center h-full"
            style={{ color: 'var(--text-muted)', gap: 'calc(8px * var(--ui-scale))' }}
          >
            <WifiHigh size={32} style={{ width: 'calc(32px * var(--ui-scale))', height: 'calc(32px * var(--ui-scale))' }} weight="thin" />
            <span style={{ fontSize: 'calc(11px * var(--ui-scale))' }}>
              No servers detected
            </span>
          </div>
        )}

        {processes.map((proc) => (
          <div
            key={proc.pid}
            style={{
              padding: 'calc(6px * var(--ui-scale)) calc(10px * var(--ui-scale))',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'calc(8px * var(--ui-scale))',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {proc.command}
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                {proc.session_name && (
                  <span style={{ marginRight: 6 }}>{proc.session_name}</span>
                )}
                <span style={{ color: 'var(--text-disabled)', fontSize: 'calc(10px * var(--ui-scale))' }}>
                  pid {proc.pid}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {proc.ports.map((port) => (
                  <span
                    key={port}
                    style={{
                      background: 'var(--bg-input)',
                      color: 'var(--accent-blue)',
                      borderRadius: 3,
                      padding: '1px 5px',
                      fontFamily: 'monospace',
                      fontSize: 'calc(11px * var(--ui-scale))',
                    }}
                  >
                    :{port}
                  </span>
                ))}
              </div>
            </div>
            <button
              onClick={() => killProcess(proc.pid)}
              disabled={killing.has(proc.pid)}
              style={{
                background: 'none',
                border: 'none',
                cursor: killing.has(proc.pid) ? 'default' : 'pointer',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                padding: 2,
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--accent-red)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; }}
              title={`Kill process ${proc.pid}`}
            >
              <X size={14} style={{ width: 'calc(14px * var(--ui-scale))', height: 'calc(14px * var(--ui-scale))' }} />
            </button>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
