import { useEffect, useState, useRef } from "react";
import { useRemoteStore } from "../../../stores/remoteStore";

const PAIRING_STEPS = [
  { step: "signaling", label: "Connecting to relay" },
  { step: "negotiating", label: "Peer connection" },
  { step: "channel", label: "Secure channel" },
];

const ACCOUNT_STEPS = [
  { step: "signaling", label: "Connecting to relay" },
  { step: "routing", label: "Routing to device" },
  { step: "negotiating", label: "Peer connection" },
  { step: "channel", label: "Secure channel" },
];

export function ConnectionSteps() {
  const connectionSteps = useRemoteStore((s) => s.connectionSteps);
  const connectionMode = useRemoteStore((s) => s.connectionMode);
  const allSteps = connectionMode === "account" ? ACCOUNT_STEPS : PAIRING_STEPS;

  // Find the index of the current active step (first step not yet completed)
  const completedStepNames = new Set(connectionSteps.map((s) => s.step));
  const currentStepIndex = allSteps.findIndex((s) => !completedStepNames.has(s.step));

  // Live elapsed timer for the current step
  const [liveElapsed, setLiveElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStepCount = useRef(connectionSteps.length);
  // eslint-disable-next-line react-hooks/purity -- ref initial value, only set on mount
  const stepStartTime = useRef(Date.now());

  useEffect(() => {
    // Reset timer when a new step completes
    if (connectionSteps.length !== lastStepCount.current) {
      lastStepCount.current = connectionSteps.length;
      stepStartTime.current = Date.now();
      setLiveElapsed(0);
    }

    if (timerRef.current) clearInterval(timerRef.current);
    if (currentStepIndex >= 0) {
      timerRef.current = setInterval(() => {
        setLiveElapsed(Date.now() - stepStartTime.current);
      }, 100);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [connectionSteps.length, currentStepIndex]);

  // Compute per-step elapsed time (delta between consecutive steps)
  const stepElapsedMap = new Map<string, number>();
  let prevMs = 0;
  for (const s of connectionSteps) {
    stepElapsedMap.set(s.step, s.elapsedMs - prevMs);
    prevMs = s.elapsedMs;
  }

  // Total elapsed = last completed step elapsed + live elapsed for current
  const totalMs = (connectionSteps.length > 0 ? connectionSteps[connectionSteps.length - 1].elapsedMs : 0) + (currentStepIndex >= 0 ? liveElapsed : 0);

  return (
    <div className="py-3 px-1">
      <div className="flex flex-col gap-2.5">
        {allSteps.map((stepDef, i) => {
          const isCompleted = completedStepNames.has(stepDef.step);
          const isCurrent = i === currentStepIndex;
          const isPending = !isCompleted && !isCurrent;
          const elapsed = isCompleted ? stepElapsedMap.get(stepDef.step) : isCurrent ? liveElapsed : undefined;

          return (
            <div key={stepDef.step} className="flex items-center gap-3" style={{ minHeight: 24 }}>
              {/* Icon */}
              <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                {isCompleted && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" stroke="var(--accent-blue)" strokeWidth="1.5" fill="none" />
                    <path d="M5 8l2 2 4-4" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {isCurrent && (
                  <span
                    className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: "var(--accent-blue)", borderTopColor: "transparent" }}
                  />
                )}
                {isPending && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" stroke="var(--text-muted)" strokeWidth="1" fill="none" opacity="0.4" />
                  </svg>
                )}
              </div>

              {/* Label */}
              <span
                className="flex-1"
                style={{
                  fontSize: "var(--fs-12)",
                  color: isPending ? "var(--text-muted)" : "var(--text-primary)",
                  opacity: isPending ? 0.5 : 1,
                }}
              >
                {stepDef.label}
              </span>

              {/* Elapsed */}
              {elapsed !== undefined && (
                <span
                  className="flex-shrink-0 font-mono tabular-nums"
                  style={{
                    fontSize: "var(--fs-11)",
                    color: isCompleted ? "var(--accent-blue)" : "var(--text-muted)",
                  }}
                >
                  {(elapsed / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Total elapsed */}
      <div
        className="mt-3 pt-2 text-center font-mono tabular-nums"
        style={{
          fontSize: "var(--fs-11)",
          color: "var(--text-muted)",
          borderTop: "1px solid var(--border-default)",
        }}
      >
        Total: {(totalMs / 1000).toFixed(1)}s
      </div>
    </div>
  );
}
