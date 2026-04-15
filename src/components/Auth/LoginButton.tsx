import { useAuthStore } from "../../stores/authStore";
import { GithubLogo } from "@phosphor-icons/react";
import DeviceFlowDialog from "./DeviceFlowDialog";

export default function LoginButton() {
  const { error, deviceFlow, isStartingLogin, startLogin } = useAuthStore();
  const isLoading = isStartingLogin || (deviceFlow.isPolling && !deviceFlow.userCode);

  return (
    <>
      <button
        onClick={() => startLogin()}
        disabled={isLoading}
        className={`flex items-center justify-center rounded transition-colors relative ${isLoading ? 'opacity-70' : ''}`}
        style={{
          width: "calc(28px * var(--ui-scale))",
          height: "calc(28px * var(--ui-scale))",
          color: error ? "var(--accent-red)" : "var(--text-muted)",
          cursor: "default",
        }}
        title={error ? `Error: ${error}` : isLoading ? "Connecting..." : "Sign in with GitHub"}
      >
        <div className="relative flex items-center justify-center">
          <GithubLogo
            size={20}
            weight="regular"
            style={{
              width: "calc(20px * var(--ui-scale))",
              height: "calc(20px * var(--ui-scale))",
              pointerEvents: "none",
            }}
          />
        </div>
        {error && !isLoading && (
          <span
            className="absolute"
            style={{
              top: -1,
              right: -1,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--accent-red)",
              border: "1px solid var(--bg-surface)",
            }}
          />
        )}
      </button>

      {deviceFlow.userCode && <DeviceFlowDialog />}
    </>
  );
}
