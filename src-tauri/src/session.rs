use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::layout::{PaneNode, SplitDirection, ShellType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    #[serde(rename = "rootPane")]
    pub root_pane: PaneNode,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "paneCount")]
    pub pane_count: usize,
}

impl Session {
    pub fn new(name: Option<String>, root_pty_id: String, shell: Option<ShellType>) -> Self {
        let id = Uuid::new_v4().to_string();
        let display_name = name.unwrap_or_else(|| format!("session-{}", &id[..8]));
        let root_pane = PaneNode::leaf(root_pty_id, shell);
        Self {
            id,
            name: display_name,
            pane_count: 1,
            root_pane,
            created_at: chrono_timestamp(),
        }
    }

    /// Create a session from a restored pane tree.
    pub fn from_restored(name: String, root_pane: PaneNode) -> Self {
        let pane_count = root_pane.pane_count();
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            pane_count,
            root_pane,
            created_at: chrono_timestamp(),
        }
    }

    /// Split a pane, returns the new pty_id that was inserted.
    /// When `before` is true the new pane is placed first (left / top).
    pub fn split_pane(
        &mut self,
        pane_id: &str,
        direction: SplitDirection,
        new_pty_id: String,
        new_shell: Option<ShellType>,
        before: bool,
    ) -> Option<String> {
        let result = self.root_pane.split(pane_id, direction, new_pty_id, new_shell, before);
        self.pane_count = self.root_pane.pane_count();
        result
    }

    /// Close a pane, returns the pty_id that was closed.
    /// Returns None if this is the last pane (can't close it).
    pub fn close_pane(&mut self, pane_id: &str) -> Option<String> {
        if self.pane_count <= 1 {
            return None; // Don't close the last pane
        }
        let result = self.root_pane.close(pane_id);
        self.pane_count = self.root_pane.pane_count();
        result
    }

    /// Resize a split node.
    pub fn resize_pane(&mut self, split_id: &str, ratio: f64) -> bool {
        self.root_pane.resize(split_id, ratio)
    }
}

fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
