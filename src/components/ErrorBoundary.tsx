import { Component, type ReactNode } from "react";
import { logger } from "../lib/logger";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, info: { componentStack?: string | null }) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error("[ErrorBoundary]", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: 8,
            color: "var(--text-muted)",
            fontSize: "var(--fs-12)",
          }}
        >
          <span>Editor crashed</span>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: "4px 12px",
              fontSize: "var(--fs-11)",
              color: "var(--text-secondary)",
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
