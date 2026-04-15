import { useRemoteStore } from "../../stores/remoteStore";

export default function ConnectionRequestToast() {
  const pendingRequests = useRemoteStore((s) => s.pendingConnectionRequests);
  const approveClient = useRemoteStore((s) => s.approveClient);
  const rejectClient = useRemoteStore((s) => s.rejectClient);

  const pending = pendingRequests[0];
  if (!pending) return null;

  const roomCode = pending.roomCode;
  const fromLogin = (pending.fromLogin ?? "unknown").slice(0, 50);
  const fromDevice = (pending.fromDevice ?? "unknown").slice(0, 50);

  const handleApprove = async () => {
    await approveClient(roomCode);
  };

  const handleReject = async () => {
    await rejectClient(roomCode);
  };

  return (
    <div
      className="fixed bottom-6 right-6 z-50 rounded-lg shadow-xl p-4 w-72"
      style={{
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        color: "var(--text-primary)",
      }}
    >
      <p style={{ fontSize: "var(--fs-13)", fontWeight: 600, marginBottom: 4 }}>
        Connection Request
        {pendingRequests.length > 1 && (
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-muted)", fontWeight: 400, marginLeft: 6 }}>
            +{pendingRequests.length - 1} more
          </span>
        )}
      </p>
      <p style={{ fontSize: "var(--fs-12)", color: "var(--text-muted)", marginBottom: 12 }}>
        {fromLogin !== "unknown" ? `@${fromLogin}` : "Someone"} wants to connect
        {fromDevice !== "unknown" ? ` from ${fromDevice}` : ""}.
      </p>
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 py-1.5 rounded-md text-xs font-medium transition-colors"
          style={{ backgroundColor: "var(--accent-blue)", color: "var(--bg-base)" }}
        >
          Approve
        </button>
        <button
          onClick={handleReject}
          className="flex-1 py-1.5 rounded-md text-xs font-medium transition-colors"
          style={{
            backgroundColor: "color-mix(in srgb, var(--accent-red) 10%, transparent)",
            color: "var(--accent-red)",
            border: "1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)",
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
