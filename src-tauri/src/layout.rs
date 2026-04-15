use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier for a pane.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneId(pub String);

impl Default for PaneId {
    fn default() -> Self {
        Self::new()
    }
}

impl PaneId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

/// Shell type enum for Windows (PowerShell, CMD, or WSL).
/// On non-Windows platforms, this is ignored and the default shell is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ShellType {
    #[default]
    PowerShell,
    Cmd,
    Wsl,
    Zsh,
    Bash,
    Fish,
}

impl ShellType {
    /// Get the shell executable path for this shell type on Windows.
    #[cfg(windows)]
    pub fn to_shell_path(&self) -> String {
        match self {
            ShellType::PowerShell => {
                std::env::var("SystemRoot")
                    .map(|root| format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", root))
                    .unwrap_or_else(|_| "powershell.exe".to_string())
            }
            ShellType::Cmd => {
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
            }
            ShellType::Wsl => {
                "wsl.exe".to_string()
            }
            ShellType::Zsh | ShellType::Bash | ShellType::Fish => {
                // Unix shells on Windows — run through WSL
                "wsl.exe".to_string()
            }
        }
    }

    #[cfg(not(windows))]
    pub fn to_shell_path(&self) -> String {
        match self {
            ShellType::Zsh => "/bin/zsh".to_string(),
            ShellType::Bash => "/bin/bash".to_string(),
            ShellType::Fish => {
                // Prefer Homebrew fish, then /usr/bin/fish
                for p in &["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"] {
                    if std::path::Path::new(p).exists() {
                        return p.to_string();
                    }
                }
                "fish".to_string()
            }
            _ => std::env::var("RACEMO_DEFAULT_SHELL")
                .or_else(|_| std::env::var("SHELL"))
                .unwrap_or_else(|_| "/bin/zsh".to_string()),
        }
    }

    /// Detect shell type from a shell executable path.
    pub fn from_path(path: &str) -> Option<ShellType> {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
        if name.contains("zsh") { return Some(ShellType::Zsh); }
        if name.contains("bash") { return Some(ShellType::Bash); }
        if name.contains("fish") { return Some(ShellType::Fish); }
        if name.contains("pwsh") || name.contains("powershell") { return Some(ShellType::PowerShell); }
        if name == "cmd" || name == "cmd.exe" { return Some(ShellType::Cmd); }
        if name.contains("wsl") { return Some(ShellType::Wsl); }
        None
    }
}

/// Direction of a pane split.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Horizontal, // left | right
    Vertical,   // top / bottom
}

/// A node in the binary tree layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PaneNode {
    Leaf {
        id: String,
        #[serde(rename = "ptyId")]
        pty_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<ShellType>,
        #[serde(rename = "lastCommand", default, skip_serializing_if = "Option::is_none")]
        last_command: Option<String>,
    },
    Split {
        id: String,
        direction: SplitDirection,
        ratio: f64,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

impl PaneNode {
    /// Create a new leaf node.
    pub fn leaf(pty_id: String, shell: Option<ShellType>) -> Self {
        PaneNode::Leaf {
            id: PaneId::new().0,
            pty_id,
            cwd: None,
            shell,
            last_command: None,
        }
    }

    /// Set the last_command of a leaf node identified by pane_id.
    pub fn set_last_command(&mut self, pane_id: &str, command: String) -> bool {
        match self {
            PaneNode::Leaf { id, last_command, .. } if id == pane_id => {
                *last_command = Some(command);
                true
            }
            PaneNode::Split { first, second, .. } => {
                first.set_last_command(pane_id, command.clone())
                    || second.set_last_command(pane_id, command)
            }
            _ => false,
        }
    }

    /// Clear the last_command of a leaf node identified by pane_id.
    pub fn clear_last_command(&mut self, pane_id: &str) -> bool {
        match self {
            PaneNode::Leaf { id, last_command, .. } if id == pane_id => {
                *last_command = None;
                true
            }
            PaneNode::Split { first, second, .. } => {
                first.clear_last_command(pane_id) || second.clear_last_command(pane_id)
            }
            _ => false,
        }
    }

    /// Create a new split node from two children.
    pub fn new_split(direction: SplitDirection, ratio: f64, first: PaneNode, second: PaneNode) -> Self {
        PaneNode::Split {
            id: PaneId::new().0,
            direction,
            ratio,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    /// Get the id of this node.
    #[allow(dead_code)]
    pub fn id(&self) -> &str {
        match self {
            PaneNode::Leaf { id, .. } => id,
            PaneNode::Split { id, .. } => id,
        }
    }

    /// Split a leaf node identified by `target_id` into two panes.
    /// When `before` is true the new pane is placed first (left / top).
    /// Returns the pty_id of the newly created pane, or None if target not found.
    pub fn split(
        &mut self,
        target_id: &str,
        direction: SplitDirection,
        new_pty_id: String,
        new_shell: Option<ShellType>,
        before: bool,
    ) -> Option<String> {
        match self {
            PaneNode::Leaf { id, pty_id, cwd, shell, last_command } if id == target_id => {
                let old_leaf = PaneNode::Leaf {
                    id: id.clone(),
                    pty_id: pty_id.clone(),
                    cwd: cwd.clone(),
                    shell: *shell,
                    last_command: last_command.clone(),
                };
                let new_leaf = PaneNode::leaf(new_pty_id.clone(), new_shell);
                let (first, second) = if before {
                    (new_leaf, old_leaf)
                } else {
                    (old_leaf, new_leaf)
                };
                *self = PaneNode::Split {
                    id: PaneId::new().0,
                    direction,
                    ratio: 0.5,
                    first: Box::new(first),
                    second: Box::new(second),
                };
                Some(new_pty_id)
            }
            PaneNode::Split {
                first, second, ..
            } => first
                .split(target_id, direction, new_pty_id.clone(), new_shell, before)
                .or_else(|| second.split(target_id, direction, new_pty_id, new_shell, before)),
            _ => None,
        }
    }

    /// Close a pane by its id. Returns the pty_id of the closed pane
    /// and replaces the parent split with the surviving sibling.
    pub fn close(&mut self, target_id: &str) -> Option<String> {
        match self {
            PaneNode::Split {
                first, second, ..
            } => {
                // Check if first child is the target leaf.
                if let PaneNode::Leaf { id, pty_id, .. } = first.as_ref() {
                    if id == target_id {
                        let closed_pty = pty_id.clone();
                        *self = *second.clone();
                        return Some(closed_pty);
                    }
                }
                // Check if second child is the target leaf.
                if let PaneNode::Leaf { id, pty_id, .. } = second.as_ref() {
                    if id == target_id {
                        let closed_pty = pty_id.clone();
                        *self = *first.clone();
                        return Some(closed_pty);
                    }
                }
                // Recurse into children.
                first
                    .close(target_id)
                    .or_else(|| second.close(target_id))
            }
            _ => None,
        }
    }

    /// Update the ratio of a split node.
    pub fn resize(&mut self, target_id: &str, ratio: f64) -> bool {
        match self {
            PaneNode::Split {
                id,
                ratio: current_ratio,
                first,
                second,
                ..
            } => {
                if id == target_id {
                    *current_ratio = ratio.clamp(0.1, 0.9);
                    return true;
                }
                first.resize(target_id, ratio) || second.resize(target_id, ratio)
            }
            _ => false,
        }
    }

    /// Collect all pty_ids in this tree.
    #[allow(dead_code)]
    pub fn pty_ids(&self) -> Vec<String> {
        match self {
            PaneNode::Leaf { pty_id, .. } => vec![pty_id.clone()],
            PaneNode::Split { first, second, .. } => {
                let mut ids = first.pty_ids();
                ids.extend(second.pty_ids());
                ids
            }
        }
    }

    /// Populate cwd fields from a pty_id -> cwd map.
    pub fn populate_cwd(&mut self, cwd_map: &std::collections::HashMap<String, String>) {
        match self {
            PaneNode::Leaf { pty_id, cwd, .. } => {
                *cwd = cwd_map.get(pty_id).cloned();
            }
            PaneNode::Split { first, second, .. } => {
                first.populate_cwd(cwd_map);
                second.populate_cwd(cwd_map);
            }
        }
    }

    /// Find the pty_id associated with a given pane_id.
    pub fn find_pty_id(&self, pane_id: &str) -> Option<String> {
        match self {
            PaneNode::Leaf { id, pty_id, .. } => {
                if id == pane_id {
                    Some(pty_id.clone())
                } else {
                    None
                }
            }
            PaneNode::Split { first, second, .. } => {
                first.find_pty_id(pane_id).or_else(|| second.find_pty_id(pane_id))
            }
        }
    }

    /// Update the pty_id of a leaf pane by its pane_id.
    /// Returns the old pty_id if found and updated.
    pub fn update_pty_id(&mut self, pane_id: &str, new_pty_id: String) -> Option<String> {
        match self {
            PaneNode::Leaf { id, pty_id, .. } => {
                if id == pane_id {
                    let old = pty_id.clone();
                    *pty_id = new_pty_id;
                    Some(old)
                } else {
                    None
                }
            }
            PaneNode::Split { first, second, .. } => {
                first.update_pty_id(pane_id, new_pty_id.clone())
                    .or_else(|| second.update_pty_id(pane_id, new_pty_id))
            }
        }
    }

    /// Count the number of leaf panes.
    pub fn pane_count(&self) -> usize {
        match self {
            PaneNode::Leaf { .. } => 1,
            PaneNode::Split { first, second, .. } => {
                first.pane_count() + second.pane_count()
            }
        }
    }
}
