//! 푸시 알림 설정 read/write commands. UI(설정 패널)에서 호출.

use tauri::AppHandle;

use crate::notify::NotifySettings;

#[tauri::command]
pub async fn get_notify_settings(app: AppHandle) -> NotifySettings {
    NotifySettings::load(&app)
}

#[tauri::command]
pub async fn set_notify_settings(
    app: AppHandle,
    settings: NotifySettings,
) -> Result<(), String> {
    settings.save(&app)
}
