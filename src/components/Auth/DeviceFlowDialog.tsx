import { useAuthStore } from "../../stores/authStore";
import { open } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useGitT } from "../../lib/i18n/git";

export default function DeviceFlowDialog() {
  const { deviceFlow, error, cancelLogin, dismissLoginDialog } = useAuthStore();
  const { userCode, verificationUri, isDialogOpen } = deviceFlow;
  const t = useGitT();

  if (!isDialogOpen || !userCode || !verificationUri) return null;

  const handleCopy = async () => {
    if (userCode) {
      await writeText(userCode);
    }
  };

  const handleOpenBrowser = async () => {
    if (verificationUri) {
      await open(verificationUri);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={(e) => {
        // Backdrop click hides the dialog but keeps polling alive — if the user
        // already entered the code in the browser, the flow still completes.
        if (e.target === e.currentTarget) dismissLoginDialog();
      }}
    >
      <div
        className="flex flex-col gap-4 rounded-lg p-6"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          width: 360,
        }}
      >
        <h2
          className="font-semibold"
          style={{ fontSize: "var(--fs-14)", color: "var(--text-primary)" }}
        >
          {t("auth.githubLogin")}
        </h2>

        <p style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
          {t("auth.enterCode")}
        </p>

        <div className="flex items-center gap-2">
          <code
            className="flex-1 text-center font-mono font-bold tracking-widest rounded px-3 py-2"
            style={{
              fontSize: "var(--fs-18, 18px)",
              background: "var(--bg-surface)",
              color: "var(--text-primary)",
              letterSpacing: "0.15em",
              border: "1px solid var(--border-subtle)",
            }}
          >
            {userCode}
          </code>
          <button
            onClick={handleCopy}
            className="rounded px-3 py-2 transition-colors hover:brightness-125"
            style={{
              fontSize: "var(--fs-11)",
              background: "var(--bg-surface)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
            title={t("auth.copy")}
          >
            {t("auth.copy")}
          </button>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleOpenBrowser}
            className="flex-1 rounded py-2 font-medium transition-colors hover:brightness-125"
            style={{
              fontSize: "var(--fs-12)",
              background: "transparent",
              color: "var(--accent-blue, #3b82f6)",
              border: "1px solid var(--accent-blue, #3b82f6)",
              cursor: "pointer",
            }}
          >
            {t("auth.openGithub")}
          </button>
          <button
            onClick={cancelLogin}
            className="rounded px-3 py-2 transition-colors hover:brightness-125"
            style={{
              fontSize: "var(--fs-11)",
              background: "var(--bg-surface)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-subtle)",
              cursor: "pointer",
            }}
          >
            {t("auth.cancel")}
          </button>
        </div>


        {error && (
          <p
            className="text-center"
            style={{ fontSize: "var(--fs-11)", color: "var(--accent-red, #ef4444)" }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
