import { useEffect } from "react";
import { useRemoteStore } from "../../stores/remoteStore";
import { useAuthStore } from "../../stores/authStore";
import { X } from "@phosphor-icons/react";
import { useGitT } from "../../lib/i18n/git";
import { BrowserHideGuard } from "../Editor/BrowserViewer";

export default function ShareDialog() {
  const t = useGitT();
  const isOpen = useRemoteStore((s) => s.isDialogOpen);
  const dialogMode = useRemoteStore((s) => s.dialogMode);
  const status = useRemoteStore((s) => s.hostStatus);
  const error = useRemoteStore((s) => s.hostError);
  const close = useRemoteStore((s) => s.closeDialog);
  const startAccountHosting = useRemoteStore((s) => s.startAccountHosting);
  const stopHosting = useRemoteStore((s) => s.stopHosting);
  const connectedClients = useRemoteStore((s) => s.connectedClients);
  const hostToast = useRemoteStore((s) => s.hostToast);
  const pendingHostAfterLogin = useRemoteStore((s) => s.pendingHostAfterLogin);
  const setPendingHostAfterLogin = useRemoteStore((s) => s.setPendingHostAfterLogin);

  const { isAuthenticated, isStartingLogin, startLogin } = useAuthStore();

  const isVisible = isOpen && dialogMode === "host";

  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, close]);

  // Auto-resume hosting once the user finishes GitHub login. The intent flag
  // lives in the store so it survives any component remount (HMR, route
  // changes, etc.) and is guaranteed to be observable when isAuthenticated
  // flips to true.
  useEffect(() => {
    if (isAuthenticated && pendingHostAfterLogin) {
      setPendingHostAfterLogin(false);
      startAccountHosting();
      close();
    }
  }, [isAuthenticated, pendingHostAfterLogin, setPendingHostAfterLogin, startAccountHosting, close]);

  const isActive = status === "connecting" || status === "reconnecting" || status === "waiting" || status === "connected";

  const handleStop = () => {
    stopHosting();
    close();
  };

  return (
    <>
      {isVisible && <BrowserHideGuard />}
      {/* Share started toast */}
      {hostToast && (
        <div
          className="fixed z-50 rounded-lg shadow-xl px-4 py-3"
          style={{
            bottom: 24,
            right: 24,
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            fontSize: "var(--fs-13)",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 8,
            animation: "fadeIn 0.2s ease",
          }}
        >
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--status-active)", boxShadow: "0 0 6px color-mix(in srgb, var(--status-active) 50%, transparent)" }} />
          {hostToast}
        </div>
      )}

      {isVisible && <div

        className="fixed inset-0 flex items-center justify-center z-50"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div
          className="rounded-xl shadow-2xl p-6 w-96 overflow-hidden relative"
          style={{
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            backdropFilter: "blur(12px)",
          }}
        >
          {/* Dynamic Glow Effect Background */}
          <div className="absolute -top-32 -right-32 w-64 h-64 rounded-full blur-[100px] pointer-events-none transition-colors duration-1000"
            style={{
              backgroundColor: status === "connected" ? "color-mix(in srgb, var(--status-active) 20%, transparent)" :
                status === "waiting" ? "color-mix(in srgb, var(--status-active) 15%, transparent)" :
                  status === "connecting" ? "color-mix(in srgb, var(--accent-blue) 20%, transparent)" : "transparent",
              animation: isActive ? 'share-glow-move 8s infinite alternate ease-in-out' : 'none'
            }}
          />

          {/* ShareDialog animations are defined in index.css */}

          {/* Header */}
          <div className="flex items-center justify-between mb-6 relative z-10">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full"
                style={{ backgroundColor: isActive ? 'var(--status-active)' : 'var(--text-muted)', boxShadow: isActive ? '0 0 8px var(--status-active)' : 'none' }}
              />
              <h2 style={{ fontSize: "var(--fs-14)", fontWeight: 600, letterSpacing: '-0.01em' }}>
                Share Terminal
              </h2>
            </div>
            <button
              onClick={close}
              className="p-1.5 rounded-full hover:bg-white/10 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="space-y-2 relative z-10">
            {/* Disconnected */}
            {status === "disconnected" && (
              <div className="py-2">
                {!isAuthenticated ? (
                  <>
                    <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }} className="mb-4 leading-relaxed">
                      Sign in with GitHub to share your terminal sessions securely with other devices.
                    </p>
                    <button
                      onClick={() => {
                        setPendingHostAfterLogin(true);
                        startLogin();
                      }}
                      disabled={isStartingLogin}
                      className={`w-full py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 hover:bg-[var(--bg-hover)] active:scale-[0.98] ${isStartingLogin ? 'opacity-70' : ''}`}
                      style={{
                        border: "1px solid var(--accent-blue)",
                        color: "var(--accent-blue)",
                        fontSize: "var(--fs-13)",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {isStartingLogin ? "Connecting..." : "Sign in with GitHub"}
                    </button>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)" }} className="mb-4 leading-relaxed">
                      Start a secure session to share your terminal output with another device.
                    </p>
                    <button
                      onClick={() => { startAccountHosting(); close(); }}
                      className="w-full py-2.5 rounded-lg transition-all hover:bg-[var(--bg-hover)] active:scale-[0.98]"
                      style={{
                        border: "1px solid var(--accent-blue)",
                        color: "var(--accent-blue)",
                        fontSize: "var(--fs-13)",
                        fontWeight: 500,
                      }}
                    >
                      Start Sharing
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Connecting */}
            {status === "connecting" && (
              <div className="text-center pt-6 pb-2">
                <div className="relative w-16 h-16 mx-auto mb-14">
                  {/* Dual Ring Spinner */}
                  <div className="absolute inset-0 border-[3px] border-blue-500/10 rounded-full" />
                  <div className="absolute inset-0 border-[3px] border-t-blue-500 border-r-blue-500/30 rounded-full animate-share-spin-main" />
                  <div className="absolute inset-2 border-[2px] border-b-blue-400/60 border-l-transparent rounded-full animate-share-spin-sub" />
                  <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/0 via-blue-500/5 to-blue-500/20 rounded-full animate-share-beam" />
                </div>
                <p style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", fontWeight: 500, letterSpacing: '0.02em' }}>
                  Establishing Secure Link
                </p>
                <p style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", opacity: 0.8 }} className="mt-1">
                  Routing through signaling mesh...
                </p>
              </div>
            )}

            {/* Reconnecting */}
            {status === "reconnecting" && (
              <div className="text-center pt-6 pb-2">
                <div className="relative w-16 h-16 mx-auto mb-14">
                  <div className="absolute inset-0 border-[3px] border-amber-500/10 rounded-full" />
                  <div className="absolute inset-0 border-[3px] border-t-amber-500 border-r-amber-500/30 rounded-full animate-share-spin-main" />
                  <div className="absolute inset-2 border-[2px] border-b-amber-400/60 border-l-transparent rounded-full animate-share-spin-sub" />
                </div>
                <p style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", fontWeight: 500, letterSpacing: '0.02em' }}>
                  {t("share.reconnecting")}
                </p>
                <p style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", opacity: 0.8 }} className="mt-1">
                  Reconnecting to signaling server
                </p>
              </div>
            )}

            {/* Waiting */}
            {status === "waiting" && (
              <div className="text-center pt-6 pb-2">
                <div className="relative w-16 h-16 mx-auto mb-14 flex items-center justify-center">
                  {/* Triple Staggered Sonar */}
                  <div className="absolute w-full h-full border-[2px] border-[var(--status-active)] rounded-full animate-share-sonar" />
                  <div className="absolute w-full h-full border-[2px] border-[var(--status-active)] rounded-full animate-share-sonar" style={{ animationDelay: '1s' }} />
                  <div className="absolute w-full h-full border-[2px] border-[var(--status-active)] rounded-full animate-share-sonar" style={{ animationDelay: '2s' }} />

                  {/* Core with inner glow */}
                  <div className="w-5 h-5 bg-[var(--status-active)] rounded-full relative z-10 flex items-center justify-center">
                    <div className="w-full h-full bg-[var(--status-active)] rounded-full blur-[2px] opacity-60 animate-ping" style={{ animationDuration: '3s' }} />
                    <div className="absolute w-2 h-2 bg-white/40 rounded-full" />
                  </div>
                </div>
                <p style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--text-primary)", letterSpacing: '-0.01em' }}>
                  Waiting for Peer
                </p>
                <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)", opacity: 0.8 }} className="mt-1">
                  Ready for encrypted connection
                </p>
              </div>
            )}

            {/* Connected */}
            {status === "connected" && (
              <div className="text-center pt-6 pb-2">
                <div className="relative w-16 h-16 mx-auto mb-14 flex items-center justify-center">
                  {/* Ambient breathing circles */}
                  <div className="w-16 h-16 rounded-full absolute animate-share-pulse" style={{ backgroundColor: "color-mix(in srgb, var(--status-active) 5%, transparent)" }} />
                  <div className="w-12 h-12 rounded-full absolute animate-share-pulse" style={{ backgroundColor: "color-mix(in srgb, var(--status-active) 10%, transparent)", animationDelay: '0.5s' }} />

                  {/* Solid core with beam spin */}
                  <div className="relative w-10 h-10 flex items-center justify-center">
                    <div className="absolute inset-0 rounded-full animate-share-spin-sub" style={{ border: "1px solid color-mix(in srgb, var(--status-active) 30%, transparent)" }} />
                    <div className="w-4 h-4 rounded-full z-10" style={{ backgroundColor: "var(--status-active)", boxShadow: "0 0 20px color-mix(in srgb, var(--status-active) 70%, transparent)" }} />
                    <div className="absolute w-full h-full bg-gradient-to-b from-[color-mix(in_srgb,var(--status-active)_20%,transparent)] to-transparent rounded-full animate-share-beam opacity-40" />
                  </div>
                </div>
                <p style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--text-primary)", letterSpacing: '0.01em' }}>
                  Secure Channel Open
                </p>
                <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)", opacity: 0.8 }} className="mt-1">
                  Real-time data streaming active
                </p>
              </div>
            )}

            {/* Connected clients list */}
            {(status === "connected" || status === "waiting") && connectedClients.length > 0 && (
              <div className="rounded-lg p-3" style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-default)" }}>
                <div className="flex items-center gap-1.5 mb-2">
                  <span style={{ fontSize: "var(--fs-12)", fontWeight: 500, color: "var(--text-primary)" }}>
                    Connected
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-full text-xs font-medium"
                    style={{ backgroundColor: "color-mix(in srgb, var(--status-active) 15%, transparent)", color: "var(--status-active)", fontSize: "var(--fs-10)" }}
                  >
                    {connectedClients.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {connectedClients.map((client) => (
                    <div key={client.id} className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-[var(--status-active)]" style={{ boxShadow: "0 0 4px color-mix(in srgb, var(--status-active) 50%, transparent)" }} />
                      <span style={{ fontSize: "var(--fs-11)", color: "var(--text-primary)" }}>{client.name}</span>
                      <span style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)", marginLeft: "auto" }}>
                        {new Date(client.connectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Failed */}
            {status === "failed" && (
              <div className="text-center pt-6 pb-2">
                <div className="w-12 h-12 rounded-full mx-auto mb-12 flex items-center justify-center" style={{ backgroundColor: "color-mix(in srgb, var(--accent-red) 10%, transparent)" }}>
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "var(--accent-red)", boxShadow: "0 0 10px color-mix(in srgb, var(--accent-red) 60%, transparent)" }} />
                </div>
                {error && (
                  <p style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.7 }} className="mb-5 px-3">
                    {error.split(/(\bFree\b|\bPro\b|업그레이드|최대|[0-9]+개)/g).map((part, i) =>
                      /^(Free|Pro|업그레이드|최대|[0-9]+개)$/.test(part)
                        ? <span key={i} style={{ color: "var(--accent-blue)", fontWeight: 600 }}>{part}</span>
                        : part
                    )}
                  </p>
                )}
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => { startAccountHosting(); close(); }}
                    className="px-6 py-1.5 rounded-lg transition-all hover:bg-[var(--bg-hover)] active:scale-[0.95]"
                    style={{
                      border: "1px solid var(--accent-blue)",
                      fontSize: "var(--fs-12)",
                      color: "var(--accent-blue)",
                      fontWeight: 500,
                    }}
                  >
                    Try Again
                  </button>
                  <a
                    href="https://racemo.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-6 py-1.5 rounded-lg transition-all hover:bg-white/5 active:scale-[0.95]"
                    style={{
                      border: "1px solid var(--border)",
                      fontSize: "var(--fs-12)",
                      color: "var(--text-muted)",
                      fontWeight: 500,
                      textDecoration: "none",
                    }}
                    onClick={() => { close(); useRemoteStore.setState({ hostStatus: "disconnected", hostError: null }); }}
                  >
                    racemo.dev
                  </a>
                </div>
              </div>
            )}

            {/* Stop button */}
            {isActive && (
              <div>
                <button
                  onClick={handleStop}
                  className="w-full py-2.5 rounded-lg transition-all"
                  style={{
                    backgroundColor: "color-mix(in srgb, var(--accent-red) 5%, transparent)",
                    color: "var(--accent-red)",
                    fontSize: "var(--fs-12)",
                    fontWeight: 500,
                    border: "1px solid color-mix(in srgb, var(--accent-red) 20%, transparent)",
                  }}
                >
                  Stop Sharing
                </button>
              </div>
            )}

          </div>
        </div>
      </div>}
    </>
  );
}
