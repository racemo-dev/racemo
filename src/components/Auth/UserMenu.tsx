import { useState, useRef, useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";

export default function UserMenu() {
  const { user, logout } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  if (!user) return null;

  const planLabel = user.plan === "pro" ? "Pro" : "Starter";
  const planColor =
    user.plan === "pro" ? "var(--accent-purple, #a78bfa)" : "var(--text-muted)";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center rounded-full overflow-hidden transition-opacity"
        style={{
          width: "calc(24px * var(--ui-scale))",
          height: "calc(24px * var(--ui-scale))",
          opacity: isOpen ? 1 : 0.8,
        }}
        title={`${user.login} (${planLabel})`}
      >
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.login}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center font-bold"
            style={{
              background: "var(--accent-blue, #3b82f6)",
              color: "var(--bg-base)",
              fontSize: "var(--fs-10)",
            }}
          >
            {user.login[0]?.toUpperCase()}
          </div>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute bottom-full left-0 mb-1 rounded-lg shadow-lg py-1 z-50"
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-default)",
            minWidth: 180,
          }}
        >
          <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            <div
              className="font-medium"
              style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)" }}
            >
              {user.name || user.login}
            </div>
            <div
              className="flex items-center gap-1"
              style={{ fontSize: "var(--fs-10)", color: "var(--text-muted)" }}
            >
              @{user.login}
              <span
                className="ml-1 px-1 rounded"
                style={{
                  fontSize: "var(--fs-9)",
                  color: planColor,
                  background:
                    user.plan === "pro"
                      ? "color-mix(in srgb, var(--accent-purple) 10%, transparent)"
                      : "color-mix(in srgb, var(--text-muted) 10%, transparent)",
                }}
              >
                {planLabel}
              </span>
            </div>
          </div>

          {/* Upgrade to Pro entry removed until Stripe checkout is wired up. */}

          <button
            className="w-full text-left px-3 py-1.5 transition-colors"
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--text-secondary)",
            }}
            onMouseEnter={(e) =>
              ((e.target as HTMLElement).style.background = "var(--bg-overlay)")
            }
            onMouseLeave={(e) =>
              ((e.target as HTMLElement).style.background = "transparent")
            }
            onClick={() => {
              logout();
              setIsOpen(false);
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
