use tauri::command;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct HistoryItem {
    pub command: String,
    pub timestamp: Option<i64>,
}

/// Get the Racemo history file path (platform-specific).
fn get_racemo_history_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|dir| dir.join("racemo").join("history.txt"))
}

/// Write a command to Racemo's own history file.
#[command]
pub fn write_racemo_history(command: String) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Ok(());
    }

    let path = get_racemo_history_path()
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create history directory: {e}"))?;
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open history file: {e}"))?;

    writeln!(file, "{};{}", timestamp, command)
        .map_err(|e| format!("Failed to write to history file: {e}"))?;

    Ok(())
}

/// Parse Racemo history file (format: "timestamp;command").
fn parse_racemo_history(path: &Path) -> Vec<HistoryItem> {
    let Ok(content) = fs::read_to_string(path) else {
        return vec![];
    };

    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            if let Some(semi_pos) = line.find(';') {
                let timestamp = line[..semi_pos].parse::<i64>().ok();
                let command = line[semi_pos + 1..].to_string();
                if !command.is_empty() {
                    return Some(HistoryItem { command, timestamp });
                }
            }
            None
        })
        .collect()
}

// ── Native shell history (platform-specific) ────────────────────

#[cfg(target_os = "windows")]
mod native_shell_history {
    use super::HistoryItem;
    use std::path::PathBuf;
    use std::env;
    use std::fs;

    fn powershell_history_path() -> Option<PathBuf> {
        env::var("APPDATA").ok().map(|appdata| {
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("PowerShell")
                .join("PSReadLine")
                .join("ConsoleHost_history.txt")
        })
    }

    /// Strip PowerShell prompt prefix like "PS D:\path> " from a history line.
    fn strip_ps_prompt(line: &str) -> &str {
        if let Some(rest) = line.strip_prefix("PS ") {
            if let Some(gt_pos) = rest.find("> ") {
                return rest[gt_pos + 2..].trim_start();
            }
        }
        line
    }

    pub fn read_items() -> Vec<HistoryItem> {
        let Some(path) = powershell_history_path() else { return vec![] };
        let Ok(content) = fs::read_to_string(&path) else { return vec![] };
        content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let cmd = strip_ps_prompt(line.trim());
                HistoryItem { command: cmd.to_string(), timestamp: None }
            })
            .collect()
    }

    pub fn clear() -> Result<(), String> {
        if let Some(path) = powershell_history_path() {
            if path.exists() {
                fs::write(&path, "")
                    .map_err(|e| format!("Failed to clear PowerShell history: {e}"))?;
            }
        }
        Ok(())
    }

    pub fn delete_entry(command: &str) -> Result<(), String> {
        let Some(path) = powershell_history_path() else { return Ok(()) };
        if !path.exists() { return Ok(()) }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read PowerShell history: {e}"))?;
        let filtered: Vec<&str> = content.lines().filter(|line| *line != command).collect();
        let new_content = filtered.join("\n") + if filtered.is_empty() { "" } else { "\n" };
        fs::write(&path, new_content)
            .map_err(|e| format!("Failed to write PowerShell history: {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
mod native_shell_history {
    use super::HistoryItem;
    use std::env;
    use std::fs;
    use std::path::Path;

    pub fn read_items() -> Vec<HistoryItem> {
        let Ok(home) = env::var("HOME") else { return vec![] };
        let zsh_path = format!("{home}/.zsh_history");
        let bash_path = format!("{home}/.bash_history");

        if Path::new(&zsh_path).exists() {
            parse_zsh_history(&zsh_path).unwrap_or_default()
        } else if Path::new(&bash_path).exists() {
            parse_bash_history(&bash_path).unwrap_or_default()
        } else {
            vec![]
        }
    }

    pub fn clear() -> Result<(), String> {
        let Ok(home) = env::var("HOME") else { return Ok(()) };
        let zsh_path = format!("{home}/.zsh_history");
        let bash_path = format!("{home}/.bash_history");
        if Path::new(&zsh_path).exists() {
            let _ = fs::write(&zsh_path, "");
        } else if Path::new(&bash_path).exists() {
            let _ = fs::write(&bash_path, "");
        }
        Ok(())
    }

    pub fn delete_entry(command: &str) -> Result<(), String> {
        let Ok(home) = env::var("HOME") else { return Ok(()) };
        let zsh_path = format!("{home}/.zsh_history");
        let bash_path = format!("{home}/.bash_history");

        if Path::new(&zsh_path).exists() {
            if let Ok(content) = fs::read_to_string(&zsh_path) {
                let filtered: Vec<&str> = content
                    .lines()
                    .filter(|line| {
                        if line.starts_with(": ") {
                            if let Some(semi_pos) = line.find(';') {
                                return &line[semi_pos + 1..] != command;
                            }
                        }
                        *line != command
                    })
                    .collect();
                let new_content = filtered.join("\n") + if filtered.is_empty() { "" } else { "\n" };
                let _ = fs::write(&zsh_path, new_content);
            }
        } else if Path::new(&bash_path).exists() {
            if let Ok(content) = fs::read_to_string(&bash_path) {
                let filtered: Vec<&str> = content.lines().filter(|line| *line != command).collect();
                let new_content = filtered.join("\n") + if filtered.is_empty() { "" } else { "\n" };
                let _ = fs::write(&bash_path, new_content);
            }
        }
        Ok(())
    }

    fn parse_zsh_history(path: &str) -> Result<Vec<HistoryItem>, String> {
        let data = fs::read(path).map_err(|e| format!("Failed to read zsh history: {e}"))?;
        let content = String::from_utf8_lossy(&data);
        let mut items = Vec::new();
        let mut pending_line = String::new();

        for line in content.lines() {
            if !pending_line.is_empty() {
                pending_line.push('\n');
                if let Some(stripped) = line.strip_suffix('\\') {
                    pending_line.push_str(stripped);
                    continue;
                }
                pending_line.push_str(line);
                items.push(HistoryItem { command: pending_line.clone(), timestamp: None });
                pending_line.clear();
                continue;
            }

            if line.ends_with('\\') {
                let cmd_part = if line.starts_with(": ") {
                    line.split_once(';').map(|x| x.1).unwrap_or(line)
                } else {
                    line
                };
                pending_line = cmd_part.trim_end_matches('\\').to_string();
                continue;
            }

            if let Some(rest) = line.strip_prefix(": ") {
                if let Some(semi_pos) = rest.find(';') {
                    let ts_part = &rest[..semi_pos];
                    let command = rest[semi_pos + 1..].to_string();
                    let timestamp = ts_part.split(':').next().and_then(|s| s.trim().parse::<i64>().ok());
                    if !command.is_empty() {
                        items.push(HistoryItem { command, timestamp });
                    }
                }
            } else if !line.trim().is_empty() {
                items.push(HistoryItem { command: line.to_string(), timestamp: None });
            }
        }

        let mut seen = std::collections::HashSet::new();
        let mut deduped = Vec::new();
        for item in items.into_iter().rev() {
            if seen.insert(item.command.clone()) {
                deduped.push(item);
            }
            if deduped.len() >= 5000 { break; }
        }
        deduped.reverse();
        Ok(deduped)
    }

    fn parse_bash_history(path: &str) -> Result<Vec<HistoryItem>, String> {
        let data = fs::read(path).map_err(|e| format!("Failed to read bash history: {e}"))?;
        let content = String::from_utf8_lossy(&data);
        let mut items = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for line in content.lines().rev() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
            if seen.insert(trimmed.to_string()) {
                items.push(HistoryItem { command: trimmed.to_string(), timestamp: None });
            }
            if items.len() >= 5000 { break; }
        }
        items.reverse();
        Ok(items)
    }
}

/// Read shell history file and return parsed entries (most recent last).
/// Merges Racemo's own history with native shell history.
#[command]
pub fn read_shell_history() -> Result<Vec<HistoryItem>, String> {
    let mut all_items = Vec::new();

    if let Some(racemo_path) = get_racemo_history_path() {
        if racemo_path.exists() {
            all_items.extend(parse_racemo_history(&racemo_path));
        }
    }

    all_items.extend(native_shell_history::read_items());
    all_items.sort_by_key(|item| item.timestamp.unwrap_or(0));

    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for item in all_items.into_iter().rev() {
        if seen.insert(item.command.clone()) {
            deduped.push(item);
        }
        if deduped.len() >= 5000 {
            break;
        }
    }
    deduped.reverse();
    Ok(deduped)
}

/// Delete a specific command from history files (Racemo + native shell).
#[command]
pub fn delete_history_entry(command: String) -> Result<(), String> {
    if let Some(path) = get_racemo_history_path() {
        if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read Racemo history: {e}"))?;

            let filtered: Vec<&str> = content
                .lines()
                .filter(|line| {
                    if let Some(semi_pos) = line.find(';') {
                        let cmd = &line[semi_pos + 1..];
                        cmd != command
                    } else {
                        true
                    }
                })
                .collect();

            let new_content = filtered.join("\n") + if filtered.is_empty() { "" } else { "\n" };
            fs::write(&path, new_content)
                .map_err(|e| format!("Failed to write Racemo history: {e}"))?;
        }
    }

    native_shell_history::delete_entry(&command)?;
    Ok(())
}

/// Clear all history from the Racemo history file and native shell history.
#[command]
pub fn clear_history() -> Result<(), String> {
    if let Some(path) = get_racemo_history_path() {
        if path.exists() {
            fs::write(&path, "")
                .map_err(|e| format!("Failed to clear Racemo history: {e}"))?;
        }
    }
    native_shell_history::clear()?;
    Ok(())
}

/// Get the Racemo history file path as a string.
#[command]
pub fn get_history_path() -> Result<String, String> {
    get_racemo_history_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine data directory".to_string())
}

/// Get the favorites file path.
fn get_favorites_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|dir| dir.join("racemo").join("favorites.json"))
}

/// Get all favorite commands.
#[command]
pub fn get_favorites() -> Result<Vec<String>, String> {
    let path = get_favorites_path()
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read favorites: {e}"))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse favorites: {e}"))
}

/// Add a command to favorites.
#[command]
pub fn add_favorite(command: String) -> Result<(), String> {
    let path = get_favorites_path()
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create favorites directory: {e}"))?;
    }

    let mut favorites: Vec<String> = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read favorites: {e}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    if !favorites.contains(&command) {
        favorites.push(command);
        let json = serde_json::to_string_pretty(&favorites)
            .map_err(|e| format!("Failed to serialize favorites: {e}"))?;
        fs::write(&path, json)
            .map_err(|e| format!("Failed to write favorites: {e}"))?;
    }

    Ok(())
}

/// Remove a command from favorites.
#[command]
pub fn remove_favorite(command: String) -> Result<(), String> {
    let path = get_favorites_path()
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if !path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read favorites: {e}"))?;
    let mut favorites: Vec<String> = serde_json::from_str(&content).unwrap_or_default();

    if let Some(pos) = favorites.iter().position(|x| x == &command) {
        favorites.remove(pos);
        let json = serde_json::to_string_pretty(&favorites)
            .map_err(|e| format!("Failed to serialize favorites: {e}"))?;
        fs::write(&path, json)
            .map_err(|e| format!("Failed to write favorites: {e}"))?;
    }

    Ok(())
}
