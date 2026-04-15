import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/bridge";
import { logger } from "../../lib/logger";

type Stage = "available" | "downloading" | "ready";

interface UpdateInfo {
  version: string;
  url: string;
  signature: string;
}

export default function UpdateToast() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [stage, setStage] = useState<Stage>("available");
  const [progress, setProgress] = useState(0);
  const [totalBytesKnown, setTotalBytesKnown] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    const checkForUpdate = async () => {
      try {
        const info = await invoke<UpdateInfo | null>("check_app_update");
        if (info && !cancelled) setUpdateInfo(info);
      } catch (e) {
        logger.warn("[updater] Check failed:", e);
      }
    };

    const timer = setTimeout(checkForUpdate, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Auto-restart when update is ready
  useEffect(() => {
    if (stage !== "ready") return;
    logger.info("[updater] Update ready, auto-relaunching...");
    invoke("relaunch_app").catch(() => relaunch());
  }, [stage]);

  if (!updateInfo) return null;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (stage === "ready") {
      // No need to stop_server — app.exit(0) in relaunch_app kills everything.
      // Calling stop_server here can hang if the IPC channel is broken after install.
      await invoke("relaunch_app").catch(() => relaunch());
      return;
    }
    if (stage === "downloading") return;

    setStage("downloading");
    setTotalBytesKnown(false);
    setProgress(0);

    try {
      await invoke("prepare_update").catch((e) => logger.warn("[updater] prepare_update:", e));

      const unlisten = await listen<{
        event: string;
        downloaded?: number;
        total?: number;
      }>("app-update-progress", (ev) => {
        const { event, downloaded = 0, total = 0 } = ev.payload;
        if (event === "Started" && total > 0) {
          setTotalBytesKnown(true);
        } else if (event === "Progress") {
          if (total > 0) {
            setProgress(Math.round((downloaded / total) * 100));
          } else {
            setProgress(downloaded);
          }
        }
      });

      await invoke("install_app_update", {
        url: updateInfo.url,
        signature: updateInfo.signature,
        version: updateInfo.version,
      });

      unlisten();
      setStage("ready");
    } catch (e) {
      logger.error("[updater] Update failed:", e);
      setStage("available");
    }
  };

  const progressLabel = totalBytesKnown
    ? `${progress}%`
    : progress >= 1024 * 1024
      ? `${(progress / (1024 * 1024)).toFixed(1)}MB`
      : `${Math.round(progress / 1024)}KB`;

  const label =
    stage === "downloading"
      ? `Updating… ${progressLabel}`
      : stage === "ready"
        ? "Restart to Update \u2192"
        : `Update v${updateInfo.version} \u2192`;

  return (
    <button
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      className="titlebar-btn update-pill"
      style={{
        padding: "2px 10px",
        fontSize: "var(--fs-11)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        cursor: stage === "downloading" ? "default" : "pointer",
        opacity: stage === "downloading" ? 0.7 : 1,
        lineHeight: 1.6,
      }}
    >
      {label}
    </button>
  );
}
