import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AuthUser, DeviceCodeResponse, TokenResponse } from "../types/auth";
import { getGitT } from "../lib/i18n/git";
import { logger } from "../lib/logger";
import { DEFAULT_SIGNALING_WS_URL } from "./settingsStore";

interface AuthStore {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isStartingLogin: boolean;
  error: string | null;

  // Device Flow state
  deviceFlow: {
    userCode: string | null;
    verificationUri: string | null;
    deviceCode: string | null;
    isPolling: boolean;
    isDialogOpen: boolean;
    interval: number;
  };

  // Actions
  startLogin: () => Promise<void>;
  cancelLogin: () => void;
  dismissLoginDialog: () => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  isStartingLogin: false,
  error: null,

  deviceFlow: {
    userCode: null,
    verificationUri: null,
    deviceCode: null,
    isPolling: false,
    isDialogOpen: false,
    interval: 5,
  },

  startLogin: async () => {
    set({ error: null, isStartingLogin: true });
    logger.debug("[authStore] Starting GitHub login flow...");

    try {
      const res = await invoke<DeviceCodeResponse>("auth_start_device_flow");
      logger.debug("[authStore] Received device code response");

      set({
        deviceFlow: {
          userCode: res.user_code,
          verificationUri: res.verification_uri,
          deviceCode: res.device_code,
          isPolling: true,
          isDialogOpen: true,
          interval: res.interval,
        },
        isStartingLogin: false,
      });

      // Start polling
      pollForToken(res.device_code, res.interval, res.expires_in);
    } catch (e) {
      logger.error("[authStore] startLogin failed:", e);
      let errorMsg = String(e);
      if (errorMsg.includes("error sending request") || errorMsg.includes("unreachable") || errorMsg.includes("Connection")) {
        errorMsg = `Signaling server unreachable (${DEFAULT_SIGNALING_WS_URL})`;

        // 커스텀 모달 표시
        const { useDialogStore } = await import("./dialogStore");
        useDialogStore.getState().show({
          title: getGitT("auth.connectionError"),
          message: errorMsg,
          type: "error",
          confirmLabel: getGitT("auth.confirm"),
        });
      }
      set({ error: errorMsg, isStartingLogin: false });
    }
  },

  cancelLogin: () => {
    set({
      deviceFlow: {
        userCode: null,
        verificationUri: null,
        deviceCode: null,
        isPolling: false,
        isDialogOpen: false,
        interval: 5,
      },
      error: null,
    });
    // Explicit cancel also drops any pending "resume hosting after login"
    // intent so we don't auto-host on a later re-login.
    void import("./remoteStore").then(({ useRemoteStore }) => {
      useRemoteStore.getState().setPendingHostAfterLogin(false);
    });
  },

  // Hide the device flow dialog without cancelling the polling. Used when the
  // user accidentally clicks outside the modal — they can still complete the
  // browser auth and the poller will pick up the token in the background.
  //
  // Note: we deliberately KEEP `pendingHostAfterLogin` so the auto-resume
  // flow still fires on success. If polling subsequently fails or times out,
  // `pollForToken` is responsible for clearing the pending intent so a later
  // unrelated login does not surprise the user by auto-starting a share.
  dismissLoginDialog: () => {
    set((state) => ({
      deviceFlow: {
        ...state.deviceFlow,
        isDialogOpen: false,
      },
    }));
  },

  logout: async () => {
    try {
      await invoke("auth_logout");
    } catch (e) {
      logger.error("Logout error:", e);
    }
    set({
      user: null,
      isAuthenticated: false,
      error: null,
    });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const user = await invoke<AuthUser | null>("auth_get_current_user");
      set({
        user,
        isAuthenticated: !!user,
        isLoading: false,
      });
    } catch (_e) {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },
}));

// ── Polling Logic ──

function pollForToken(deviceCode: string, interval: number, expiresIn: number) {
  const deadline = Date.now() + expiresIn * 1000;

  // Clear any pending "resume hosting after login" intent tied to a failed or
  // timed-out device flow. Without this, the intent can outlive the login
  // attempt and auto-start a share on an unrelated future login.
  const clearPendingIntents = () => {
    void import("./remoteStore").then(({ useRemoteStore }) => {
      useRemoteStore.getState().setPendingHostAfterLogin(false);
    });
  };

  const poll = async () => {
    const state = useAuthStore.getState();
    if (!state.deviceFlow.isPolling) return;
    if (Date.now() > deadline) {
      useAuthStore.setState({
        error: "Login timed out. Please try again.",
        deviceFlow: {
          ...state.deviceFlow,
          isPolling: false,
          isDialogOpen: false,
        },
      });
      clearPendingIntents();
      return;
    }

    try {
      const res = await invoke<TokenResponse>("auth_poll_token", {
        deviceCode,
      });

      if (res.status === "success" && res.user) {
        logger.debug("[authStore] Login successful, user:", res.user);
        useAuthStore.setState({
          user: res.user as AuthUser,
          isAuthenticated: true,
          deviceFlow: {
            userCode: null,
            verificationUri: null,
            deviceCode: null,
            isPolling: false,
            isDialogOpen: false,
            interval: 5,
          },
          error: null,
        });
        return; // Done!
      }

      if (res.status === "authorization_pending" || res.status === "slow_down") {
        // Keep polling
        const delay = res.status === "slow_down" ? (interval + 5) * 1000 : interval * 1000;
        setTimeout(poll, delay);
        return;
      }

      // Other error
      useAuthStore.setState({
        error: res.message || `Login failed: ${res.status}`,
        deviceFlow: {
          ...useAuthStore.getState().deviceFlow,
          isPolling: false,
          isDialogOpen: false,
        },
      });
      clearPendingIntents();
    } catch (e) {
      useAuthStore.setState({
        error: String(e),
        deviceFlow: {
          ...useAuthStore.getState().deviceFlow,
          isPolling: false,
          isDialogOpen: false,
        },
      });
      clearPendingIntents();
    }
  };

  setTimeout(poll, interval * 1000);
}

// Note: checkAuth() is called from App.tsx after IPC is ready, not at module load.
