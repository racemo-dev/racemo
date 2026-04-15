import { useRemoteStore } from "../../stores/remoteStore";
import { useAuthStore } from "../../stores/authStore";
import { useGitT } from "../../lib/i18n/git";
import { ConnectIcon, ShareIcon } from "./Icons";

export function ConnectBadge() {
  const clientStatus = useRemoteStore((s) => s.clientStatus);
  const openDialog = useRemoteStore((s) => s.openDialog);
  const setDialogMode = useRemoteStore((s) => s.setDialogMode);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const startLogin = useAuthStore((s) => s.startLogin);
  const t = useGitT();

  const isClientActive = clientStatus === "connecting" || clientStatus === "connected";
  const isConnecting = clientStatus === "connecting";

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isAuthenticated) { startLogin(); return; }
    setDialogMode("client");
    openDialog();
  };

  return (
    <button
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={isClientActive ? t("tabbar.connectedTitle") : t("tabbar.connectTitle")}
      className="titlebar-btn status-badge gap-1.5 uppercase"
    >
      <ConnectIcon
        isActive={isClientActive}
        isConnecting={isConnecting}
      />
      {t("tabbar.connect")}
    </button>
  );
}

export function ShareAliveBadge() {
  const hostStatus = useRemoteStore((s) => s.hostStatus);
  const openDialog = useRemoteStore((s) => s.openDialog);
  const setDialogMode = useRemoteStore((s) => s.setDialogMode);
  const setPendingHostAfterLogin = useRemoteStore((s) => s.setPendingHostAfterLogin);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const startLogin = useAuthStore((s) => s.startLogin);
  const t = useGitT();

  const isHostActive = hostStatus === "connecting" || hostStatus === "reconnecting" || hostStatus === "waiting" || hostStatus === "connected";

  const startAccountHosting = useRemoteStore((s) => s.startAccountHosting);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isAuthenticated) {
      // User's intent is to share, not just log in. Remember the intent so the
      // ShareDialog's auto-resume effect kicks in once auth completes.
      setPendingHostAfterLogin(true);
      startLogin();
      return;
    }
    // disconnected 또는 failed 상태에서는 바로 공유 시도
    if (hostStatus === "disconnected" || hostStatus === "failed") {
      startAccountHosting();
      return;
    }
    setDialogMode("host");
    openDialog();
  };

  return (
    <button
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={isHostActive ? t("tabbar.sharingTitle") : t("tabbar.shareTitle")}
      className="titlebar-btn status-badge gap-1.5 uppercase"
    >
      <ShareIcon
        isActive={isHostActive}
        isConnecting={hostStatus === "connecting"}
      />
      {t("tabbar.share")}
    </button>
  );
}
