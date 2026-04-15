use crate::hooklog::HookTreeNode;

#[tauri::command]
pub fn read_hook_log() -> Result<Vec<HookTreeNode>, String> {
    Ok(crate::hooklog::read_hook_log_tree(20))
}

#[tauri::command]
pub fn clear_hook_log() -> Result<(), String> {
    crate::hooklog::clear_hook_log()
}
