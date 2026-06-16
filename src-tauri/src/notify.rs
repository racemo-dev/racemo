//! 명령 완료(OSC 133;D) 푸시 알림 디스패처.
//!
//! `setup_listener`가 setup()에서 한 번 호출되어 `pty-command-finished`
//! Tauri 이벤트를 받고 OS 알림으로 변환한다. 임계값 미만이거나 윈도우가
//! 포커스 상태이면 무시.
//!
//! 모바일 푸시 경로는 Phase 4에서 같은 settings를 공유한다.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "notification-settings.json";
const STORE_KEY: &str = "settings";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotifySettings {
    pub enabled: bool,
    /// 명령 실행 시간이 이 임계값(초) 이상이어야 알림. 기본 30초.
    pub threshold_seconds: u32,
    /// true면 exit_code != 0 인 경우에만 알림.
    pub failures_only: bool,
    /// true면 메인 윈도우가 포커스된 동안에는 알림 억제.
    pub suppress_when_focused: bool,
    pub channels: NotifyChannels,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotifyChannels {
    Desktop,
    Mobile,
    Both,
}

impl Default for NotifySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_seconds: 30,
            failures_only: false,
            suppress_when_focused: true,
            channels: NotifyChannels::Desktop,
        }
    }
}

impl NotifySettings {
    pub fn load(app: &AppHandle) -> Self {
        let Ok(store) = app.store(STORE_FILE) else {
            return Self::default();
        };
        store
            .get(STORE_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
        let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        store.set(STORE_KEY, value);
        store.save().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct CommandFinishedPayload {
    #[allow(dead_code)]
    pane_id: String,
    elapsed_ms: u64,
    exit_code: Option<i32>,
}

/// 알림을 발사할지 + 어떤 채널로 보낼지 판정하는 순수 함수.
/// UI/IO 없이 결정 로직만 담아 단위 테스트 가능.
pub fn decide_notification(
    settings: &NotifySettings,
    elapsed_ms: u64,
    exit_code: Option<i32>,
    window_focused: bool,
) -> Option<NotifyChannels> {
    if !settings.enabled {
        return None;
    }
    if elapsed_ms < (settings.threshold_seconds as u64) * 1000 {
        return None;
    }
    if settings.failures_only && exit_code.unwrap_or(0) == 0 {
        return None;
    }
    if settings.suppress_when_focused && window_focused {
        return None;
    }
    Some(settings.channels)
}

fn format_title(exit_code: Option<i32>) -> String {
    match exit_code {
        Some(0) | None => "명령 완료".to_string(),
        Some(code) => format!("명령 실패 (exit {code})"),
    }
}

fn format_body(elapsed_ms: u64) -> String {
    let secs = elapsed_ms / 1000;
    if secs < 60 {
        format!("{secs}초 만에 끝남")
    } else {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}분 {s}초 만에 끝남")
    }
}

/// `pty-command-finished` 이벤트를 구독해 데스크탑 알림(+ Phase 4에서 모바일)을 발사.
pub fn setup_listener(app: &AppHandle) {
    let app_for_handler = app.clone();
    app.listen("pty-command-finished", move |event| {
        let payload: CommandFinishedPayload = match serde_json::from_str(event.payload()) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[notify] failed to parse pty-command-finished payload: {e}");
                return;
            }
        };

        let settings = NotifySettings::load(&app_for_handler);
        let window_focused = app_for_handler
            .get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false);

        let Some(channels) = decide_notification(
            &settings,
            payload.elapsed_ms,
            payload.exit_code,
            window_focused,
        ) else {
            return;
        };

        let title = format_title(payload.exit_code);
        let body = format_body(payload.elapsed_ms);

        if matches!(channels, NotifyChannels::Desktop | NotifyChannels::Both) {
            if let Err(e) = app_for_handler
                .notification()
                .builder()
                .title(&title)
                .body(&body)
                .show()
            {
                log::warn!("[notify] failed to show desktop notification: {e}");
            }
        }

        if matches!(channels, NotifyChannels::Mobile | NotifyChannels::Both) {
            // presence loop 가 구독 중. JSON 그대로 forward.
            let mobile_payload = serde_json::json!({
                "elapsed_ms": payload.elapsed_ms,
                "exit_code": payload.exit_code,
            });
            if let Err(e) = app_for_handler.emit("remote-task-complete", mobile_payload) {
                log::warn!("[notify] failed to emit remote-task-complete: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(threshold: u32, failures_only: bool, suppress: bool) -> NotifySettings {
        NotifySettings {
            enabled: true,
            threshold_seconds: threshold,
            failures_only,
            suppress_when_focused: suppress,
            channels: NotifyChannels::Desktop,
        }
    }

    #[test]
    fn under_threshold_skipped() {
        let r = decide_notification(&s(30, false, true), 5_000, Some(0), false);
        assert!(r.is_none());
    }

    #[test]
    fn over_threshold_fires() {
        let r = decide_notification(&s(30, false, true), 31_000, Some(0), false);
        assert_eq!(r, Some(NotifyChannels::Desktop));
    }

    #[test]
    fn focused_suppresses() {
        let r = decide_notification(&s(30, false, true), 60_000, Some(0), true);
        assert!(r.is_none());
    }

    #[test]
    fn focused_allowed_when_suppress_off() {
        let r = decide_notification(&s(30, false, false), 60_000, Some(0), true);
        assert_eq!(r, Some(NotifyChannels::Desktop));
    }

    #[test]
    fn failures_only_skips_success() {
        let r = decide_notification(&s(30, true, false), 60_000, Some(0), false);
        assert!(r.is_none());
    }

    #[test]
    fn failures_only_fires_on_nonzero() {
        let r = decide_notification(&s(30, true, false), 60_000, Some(1), false);
        assert_eq!(r, Some(NotifyChannels::Desktop));
    }

    #[test]
    fn missing_exit_code_treated_as_success() {
        let r = decide_notification(&s(30, true, false), 60_000, None, false);
        assert!(r.is_none());
    }

    #[test]
    fn disabled_short_circuits() {
        let mut settings = s(30, false, true);
        settings.enabled = false;
        let r = decide_notification(&settings, 999_999, Some(1), false);
        assert!(r.is_none());
    }

    #[test]
    fn boundary_exact_threshold_fires() {
        // 정확히 30s = 임계값. 코드는 `<`로 skip하므로 정확히 같으면 fire.
        let r = decide_notification(&s(30, false, true), 30_000, Some(0), false);
        assert_eq!(r, Some(NotifyChannels::Desktop));
    }

    #[test]
    fn boundary_just_under_threshold_skipped() {
        let r = decide_notification(&s(30, false, true), 29_999, Some(0), false);
        assert!(r.is_none());
    }

    #[test]
    fn format_body_seconds_only() {
        assert_eq!(format_body(45_000), "45초 만에 끝남");
    }

    #[test]
    fn format_body_minutes() {
        assert_eq!(format_body(125_000), "2분 5초 만에 끝남");
    }

    #[test]
    fn format_title_success() {
        assert_eq!(format_title(Some(0)), "명령 완료");
        assert_eq!(format_title(None), "명령 완료");
    }

    #[test]
    fn format_title_failure_includes_code() {
        assert_eq!(format_title(Some(127)), "명령 실패 (exit 127)");
    }

    #[test]
    fn settings_default_values() {
        let d = NotifySettings::default();
        assert!(d.enabled);
        assert_eq!(d.threshold_seconds, 30);
        assert!(!d.failures_only);
        assert!(d.suppress_when_focused);
        assert_eq!(d.channels, NotifyChannels::Desktop);
    }
}
