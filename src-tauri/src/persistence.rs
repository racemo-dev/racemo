use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use thiserror::Error;

use crate::layout::{PaneNode, SplitDirection};
use crate::session::Session;

const STATE_VERSION: u32 = 2;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("Failed to determine data directory")]
    NoDataDir,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("State version {found} is not supported (current: {expected})")]
    UnsupportedVersion { found: u32, expected: u32 },
}

/// Persisted state containing all sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub version: u32,
    pub sessions: Vec<PersistedSession>,
    pub active_session_id: Option<String>,
}

/// A session saved to disk (no PTY IDs, just layout with CWDs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub layout: SavedPaneNode,
    /// Terminal size at save time (used for restore).
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_cols")]
    pub cols: u16,
}

fn default_rows() -> u16 { 24 }
fn default_cols() -> u16 { 80 }

/// Saved pane node (only stores CWD for leaves, no pty_id/pane_id).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SavedPaneNode {
    Leaf {
        cwd: Option<String>,
        shell: Option<crate::layout::ShellType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_command: Option<String>,
    },
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<SavedPaneNode>,
        second: Box<SavedPaneNode>,
    },
}

/// Get the path to the state file.
pub fn state_file_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("racemo").join("sessions.json"))
}

/// Save state to disk atomically (write to temp file, then rename).
pub fn save_state(state: &PersistedState) -> Result<(), PersistenceError> {
    let path = state_file_path().ok_or(PersistenceError::NoDataDir)?;

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Write to temp file first for atomic operation
    let temp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(state)?;
    std::fs::write(&temp_path, json)?;

    // Atomic rename
    std::fs::rename(&temp_path, &path)?;

    log::debug!("Persisted {} sessions to {:?}", state.sessions.len(), path);
    Ok(())
}

/// Load state from disk.
pub fn load_state() -> Result<Option<PersistedState>, PersistenceError> {
    let path = match state_file_path() {
        Some(p) => p,
        None => return Err(PersistenceError::NoDataDir),
    };

    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path)?;
    let state: PersistedState = serde_json::from_str(&json)?;

    // Version check — discard outdated state gracefully
    if state.version != STATE_VERSION {
        log::warn!(
            "Discarding outdated state (version {} → {}), starting fresh",
            state.version,
            STATE_VERSION
        );
        // Remove the stale file so it doesn't keep triggering warnings
        let _ = std::fs::remove_file(&path);
        return Ok(None);
    }

    log::debug!("Loaded {} sessions from {:?}", state.sessions.len(), path);
    Ok(Some(state))
}

/// Convert a PaneNode tree to SavedPaneNode tree (for persistence).
pub fn pane_node_to_saved(node: &PaneNode, cwd_map: &HashMap<String, String>) -> SavedPaneNode {
    match node {
        PaneNode::Leaf { pty_id, cwd, shell, last_command, .. } => {
            // Use the cwd from cwd_map if available, otherwise use the node's cwd
            let saved_cwd = cwd_map.get(pty_id).cloned().or_else(|| cwd.clone());
            SavedPaneNode::Leaf { cwd: saved_cwd, shell: *shell, last_command: last_command.clone() }
        }
        PaneNode::Split {
            direction,
            ratio,
            first,
            second,
            ..
        } => SavedPaneNode::Split {
            direction: *direction,
            ratio: *ratio,
            first: Box::new(pane_node_to_saved(first, cwd_map)),
            second: Box::new(pane_node_to_saved(second, cwd_map)),
        },
    }
}

/// Convert a Session to PersistedSession.
pub fn session_to_persisted(session: &Session, cwd_map: &HashMap<String, String>, rows: u16, cols: u16) -> PersistedSession {
    PersistedSession {
        id: session.id.clone(),
        name: session.name.clone(),
        created_at: session.created_at,
        layout: pane_node_to_saved(&session.root_pane, cwd_map),
        rows,
        cols,
    }
}

/// Convert SavedPaneNode tree to PaneNode tree, spawning PTYs for each leaf.
/// The pty_spawner closure takes an optional CWD and returns a pty_id or error.
pub fn saved_to_pane_node<F>(node: &SavedPaneNode, pty_spawner: &mut F) -> Result<PaneNode, String>
where
    F: FnMut(Option<&str>, Option<crate::layout::ShellType>) -> Result<(String, Option<crate::layout::ShellType>), String>,
{
    match node {
        SavedPaneNode::Leaf { cwd, shell, last_command } => {
            let (pty_id, detected_shell) = pty_spawner(cwd.as_deref(), *shell)?;
            Ok(PaneNode::Leaf {
                id: uuid::Uuid::new_v4().to_string(),
                pty_id,
                cwd: cwd.clone(),
                shell: detected_shell.or(*shell),
                last_command: last_command.clone(),
            })
        }
        SavedPaneNode::Split {
            direction,
            ratio,
            first,
            second,
        } => {
            let first_node = saved_to_pane_node(first, pty_spawner)?;
            let second_node = saved_to_pane_node(second, pty_spawner)?;
            Ok(PaneNode::Split {
                id: uuid::Uuid::new_v4().to_string(),
                direction: *direction,
                ratio: *ratio,
                first: Box::new(first_node),
                second: Box::new(second_node),
            })
        }
    }
}

/// Convert a PersistedSession back to Session by spawning PTYs.
pub fn persisted_to_session<F>(persisted: &PersistedSession, pty_spawner: &mut F) -> Result<Session, String>
where
    F: FnMut(Option<&str>, Option<crate::layout::ShellType>) -> Result<(String, Option<crate::layout::ShellType>), String>,
{
    let root_pane = saved_to_pane_node(&persisted.layout, pty_spawner)?;
    let pane_count = root_pane.pane_count();

    Ok(Session {
        id: persisted.id.clone(),
        name: persisted.name.clone(),
        root_pane,
        created_at: persisted.created_at,
        pane_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pane_node_to_saved_leaf() {
        let node = PaneNode::Leaf {
            id: "pane-1".to_string(),
            pty_id: "pty-1".to_string(),
            cwd: Some("/home/user".to_string()),
            shell: Some(crate::layout::ShellType::Cmd),
            last_command: None,
        };
        let cwd_map = HashMap::new();
        let saved = pane_node_to_saved(&node, &cwd_map);

        match saved {
            SavedPaneNode::Leaf { cwd, shell, .. } => {
                assert_eq!(cwd, Some("/home/user".to_string()));
                assert_eq!(shell, Some(crate::layout::ShellType::Cmd));
            }
            _ => panic!("Expected Leaf"),
        }
    }

    #[test]
    fn test_pane_node_to_saved_uses_cwd_map() {
        let node = PaneNode::Leaf {
            id: "pane-1".to_string(),
            pty_id: "pty-1".to_string(),
            cwd: Some("/old/path".to_string()),
            shell: None,
            last_command: None,
        };
        let mut cwd_map = HashMap::new();
        cwd_map.insert("pty-1".to_string(), "/new/path".to_string());

        let saved = pane_node_to_saved(&node, &cwd_map);

        match saved {
            SavedPaneNode::Leaf { cwd, .. } => {
                assert_eq!(cwd, Some("/new/path".to_string()));
            }
            _ => panic!("Expected Leaf"),
        }
    }

    #[test]
    fn test_roundtrip_serialization() {
        let state = PersistedState {
            version: STATE_VERSION,
            sessions: vec![PersistedSession {
                id: "session-1".to_string(),
                name: "test".to_string(),
                created_at: 1234567890,
                layout: SavedPaneNode::Split {
                    direction: SplitDirection::Horizontal,
                    ratio: 0.5,
                    first: Box::new(SavedPaneNode::Leaf {
                        cwd: Some("/home/user/a".to_string()),
                        shell: Some(crate::layout::ShellType::PowerShell),
                        last_command: None,
                    }),
                    second: Box::new(SavedPaneNode::Leaf {
                        cwd: Some("/home/user/b".to_string()),
                        shell: None,
                        last_command: None,
                    }),
                },
                rows: 50,
                cols: 120,
            }],
            active_session_id: Some("session-1".to_string()),
        };

        let json = serde_json::to_string(&state).unwrap();
        let loaded: PersistedState = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.version, STATE_VERSION);
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].name, "test");
    }
}
