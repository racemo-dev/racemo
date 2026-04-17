use crate::process_util::SilentCommandExt;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub root: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub is_detached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatuses {
    pub repo_root: String,
    pub staged: Vec<GitStatusEntry>,
    pub unstaged: Vec<GitStatusEntry>,
    pub untracked: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub relative_time: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

/// Find the git binary, with macOS PATH fallbacks.
/// Override with RACEMO_GIT_BIN env var for testing (e.g. RACEMO_GIT_BIN=/nonexistent).
fn git_bin() -> &'static str {
    static GIT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    GIT.get_or_init(|| {
        if let Ok(custom) = std::env::var("RACEMO_GIT_BIN") {
            return custom;
        }
        for path in &["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"] {
            if Path::new(path).exists() {
                return path.to_string();
            }
        }
        "git".to_string()
    })
}

// ── Git Command Log ──────────────────────────────────────────

const MAX_LOG_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandLogEntry {
    pub timestamp: f64,
    pub command: String,
    pub success: bool,
    pub output: String,
    pub duration_ms: u64,
}

static GIT_LOG: Mutex<Option<VecDeque<GitCommandLogEntry>>> = Mutex::new(None);

fn push_log(entry: GitCommandLogEntry) {
    let mut guard = GIT_LOG.lock().unwrap_or_else(|e| e.into_inner());
    let log = guard.get_or_insert_with(VecDeque::new);
    if log.len() >= MAX_LOG_ENTRIES {
        log.pop_front();
    }
    log.push_back(entry);
}

/// Get all stored git command log entries.
pub fn get_command_log() -> Vec<GitCommandLogEntry> {
    let guard = GIT_LOG.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(|d| d.iter().cloned().collect()).unwrap_or_default()
}

/// Clear all stored git command log entries.
pub fn clear_command_log() {
    let mut guard = GIT_LOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(log) = guard.as_mut() {
        log.clear();
    }
}

pub fn git_init(dir: &str) -> Result<(), String> {
    run_git(dir, &["init"])?;
    Ok(())
}

/// Run a git command in the given directory, returning stdout as String.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let start = std::time::Instant::now();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    let output = Command::new(git_bin())
        .arg("-C")
        .arg(dir)
        .args(args)
        .silent()
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let cmd_str = format!("git {}", args.join(" "));

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        push_log(GitCommandLogEntry {
            timestamp: ts,
            command: cmd_str,
            success: false,
            output: stderr.clone(),
            duration_ms,
        });
        return Err(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim_end().to_string();
    push_log(GitCommandLogEntry {
        timestamp: ts,
        command: cmd_str,
        success: true,
        output: if stdout.len() > 500 {
            let truncated: String = stdout.chars().take(500).collect();
            format!("{}... ({} bytes)", truncated, stdout.len())
        } else {
            stdout.clone()
        },
        duration_ms,
    });
    Ok(stdout)
}

/// Run a git command preserving trailing whitespace in output (needed for diff/patch).
fn run_git_raw(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(git_bin())
        .arg("-C")
        .arg(dir)
        .args(args)
        .silent()
        .output()
        .map_err(|e| format!("Failed to execute git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a git command with data piped to stdin.
fn run_git_stdin(dir: &str, args: &[&str], stdin_data: &str) -> Result<String, String> {
    use std::io::Write;
    let start = std::time::Instant::now();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    let mut child = Command::new(git_bin())
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .silent()
        .spawn()
        .map_err(|e| format!("Failed to execute git: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_data.as_bytes())
            .map_err(|e| format!("Failed to write to git stdin: {e}"))?;
    }

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for git: {e}"))?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let cmd_str = format!("git {} (stdin)", args.join(" "));

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        push_log(GitCommandLogEntry {
            timestamp: ts,
            command: cmd_str,
            success: false,
            output: stderr.clone(),
            duration_ms,
        });
        return Err(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim_end().to_string();
    push_log(GitCommandLogEntry {
        timestamp: ts,
        command: cmd_str,
        success: true,
        output: if stdout.len() > 500 {
            let truncated: String = stdout.chars().take(500).collect();
            format!("{}... ({} bytes)", truncated, stdout.len())
        } else {
            stdout.clone()
        },
        duration_ms,
    });
    Ok(stdout)
}

/// Find the git repository root for the given path.
pub fn find_git_root(path: &str) -> Result<String, String> {
    run_git(path, &["rev-parse", "--show-toplevel"])
}

/// Get repository info (branch, ahead/behind).
pub fn get_repo_info(path: &str) -> Result<GitRepoInfo, String> {
    let root = find_git_root(path)?;

    // Get current branch
    let (branch, is_detached) =
        match run_git(path, &["symbolic-ref", "--short", "HEAD"]) {
            Ok(b) => (b, false),
            Err(_) => {
                // Detached HEAD — use short commit hash
                let hash = run_git(path, &["rev-parse", "--short", "HEAD"])
                    .unwrap_or_else(|_| "unknown".into());
                (hash, true)
            }
        };

    // Get ahead/behind counts (may fail if no upstream)
    let (ahead, behind) =
        match run_git(path, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) {
            Ok(output) => {
                let parts: Vec<&str> = output.split_whitespace().collect();
                if parts.len() == 2 {
                    (
                        parts[0].parse::<u32>().unwrap_or(0),
                        parts[1].parse::<u32>().unwrap_or(0),
                    )
                } else {
                    (0, 0)
                }
            }
            Err(_) => (0, 0),
        };

    Ok(GitRepoInfo {
        root,
        branch,
        ahead,
        behind,
        is_detached,
    })
}

/// Parse `git status --porcelain=v1` output into categorized file statuses.
pub fn get_file_statuses(path: &str) -> Result<GitFileStatuses, String> {
    let root = find_git_root(path)?;
    let output = run_git(path, &["status", "--porcelain=v1"])?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0]; // index (staged) status
        let y = line.as_bytes()[1]; // worktree status
        // Porcelain v1: "XY PATH" — skip XY then trim leading spaces for robustness
        let file_path = line[2..].trim_start();

        // Handle renames: "R  old -> new"
        let file_path = if file_path.contains(" -> ") {
            file_path.split(" -> ").last().unwrap_or(file_path)
        } else {
            file_path
        }
        .to_string();

        // Untracked
        if x == b'?' && y == b'?' {
            untracked.push(GitStatusEntry {
                path: file_path,
                status: GitFileStatus::Untracked,
                staged: false,
            });
            continue;
        }

        // Conflicts (both modified, or unmerged states)
        if (x == b'U' || y == b'U') || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
            unstaged.push(GitStatusEntry {
                path: file_path,
                status: GitFileStatus::Conflicted,
                staged: false,
            });
            continue;
        }

        // Staged changes (index column)
        if x != b' ' && x != b'?' {
            let status = match x {
                b'M' => GitFileStatus::Modified,
                b'A' => GitFileStatus::Added,
                b'D' => GitFileStatus::Deleted,
                b'R' => GitFileStatus::Renamed,
                _ => GitFileStatus::Modified,
            };
            staged.push(GitStatusEntry {
                path: file_path.clone(),
                status,
                staged: true,
            });
        }

        // Unstaged changes (worktree column)
        if y != b' ' && y != b'?' {
            let status = match y {
                b'M' => GitFileStatus::Modified,
                b'D' => GitFileStatus::Deleted,
                _ => GitFileStatus::Modified,
            };
            unstaged.push(GitStatusEntry {
                path: file_path,
                status,
                staged: false,
            });
        }
    }

    Ok(GitFileStatuses {
        repo_root: root,
        staged,
        unstaged,
        untracked,
    })
}

/// Get recent commit log entries.
/// If `all` is true, includes commits from all branches (`--all`).
pub fn get_commit_log(path: &str, count: u32, all: bool) -> Result<Vec<GitCommitEntry>, String> {
    let format = "%h%x00%s%x00%an%x00%at%x00%ar%x00%p%x00%D";
    let n_arg = format!("-n{count}");
    let format_arg = format!("--format={format}");
    let mut args = vec!["log", &format_arg, &n_arg];
    if all {
        args.push("--all");
    }
    let output = run_git(path, &args)?;

    let mut entries = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() >= 5 {
            let parents = parts.get(5).unwrap_or(&"")
                .split_whitespace()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            let refs = parts.get(6).unwrap_or(&"")
                .split(", ")
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            entries.push(GitCommitEntry {
                hash: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                timestamp: parts[3].parse::<i64>().unwrap_or(0),
                relative_time: parts[4].to_string(),
                parents,
                refs,
            });
        }
    }
    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub hash: String,
    pub full_hash: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub status: String, // "M", "A", "D", "R"
}

/// Get detailed info for a specific commit (message, author, changed files).
pub fn get_commit_detail(path: &str, hash: &str) -> Result<GitCommitDetail, String> {
    // Fetch metadata (no message — avoids NUL conflicts with multiline body)
    let format = "%H%x00%h%x00%an%x00%ae%x00%ci";
    let format_arg = format!("--format={format}");
    let header = run_git(path, &["log", "-1", &format_arg, hash])?;
    let parts: Vec<&str> = header.split('\0').collect();
    if parts.len() < 5 {
        return Err("Failed to parse commit header".into());
    }

    // Fetch full commit message separately (%B = subject + body)
    let message = run_git(path, &["log", "-1", "--format=%B", hash])?
        .trim()
        .to_string();

    // Get changed files with status
    let diff_output = run_git(path, &["diff-tree", "--no-commit-id", "-r", "--name-status", hash])?;
    let files: Vec<GitCommitFile> = diff_output
        .lines()
        .filter_map(|line| {
            let mut cols = line.splitn(2, '\t');
            let status = cols.next()?.trim().to_string();
            let file_path = cols.next()?.trim().to_string();
            if file_path.is_empty() {
                return None;
            }
            Some(GitCommitFile {
                path: file_path,
                status: status.chars().next().map(|c| c.to_string()).unwrap_or_default(),
            })
        })
        .collect();

    Ok(GitCommitDetail {
        full_hash: parts[0].to_string(),
        hash: parts[1].to_string(),
        message,
        author: parts[2].to_string(),
        email: parts[3].to_string(),
        date: parts[4].to_string(),
        files,
    })
}

/// Stage a specific file.
pub fn stage_file(path: &str, file: &str) -> Result<(), String> {
    run_git(path, &["add", "--", file])?;
    Ok(())
}

/// Unstage a specific file.
pub fn unstage_file(path: &str, file: &str) -> Result<(), String> {
    run_git(path, &["reset", "HEAD", "--", file])?;
    Ok(())
}

/// Stage all changes.
pub fn stage_all(path: &str) -> Result<(), String> {
    run_git(path, &["add", "-A"])?;
    Ok(())
}

/// Unstage all changes.
pub fn unstage_all(path: &str) -> Result<(), String> {
    run_git(path, &["reset", "HEAD"])?;
    Ok(())
}

/// Create a commit with the given message.
pub fn git_commit(path: &str, message: &str) -> Result<(), String> {
    run_git(path, &["commit", "-m", message])?;
    Ok(())
}

/// Discard changes to a specific file (restore to HEAD).
pub fn discard_file(path: &str, file: &str) -> Result<(), String> {
    run_git(path, &["checkout", "--", file])?;
    Ok(())
}

/// Append a pattern to .gitignore (creates the file if missing).
pub fn add_to_gitignore(path: &str, pattern: &str) -> Result<(), String> {
    use std::fs::{OpenOptions, read_to_string};
    use std::io::Write;

    let gitignore = std::path::Path::new(path).join(".gitignore");
    // Check if the pattern already exists
    if gitignore.exists() {
        let content = read_to_string(&gitignore).map_err(|e| e.to_string())?;
        if content.lines().any(|line| line.trim() == pattern.trim()) {
            return Ok(()); // already present
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore)
        .map_err(|e| e.to_string())?;
    // Ensure we start on a new line
    if gitignore.exists() {
        let content = std::fs::read(&gitignore).unwrap_or_default();
        if !content.is_empty() && content.last() != Some(&b'\n') {
            writeln!(file).map_err(|e| e.to_string())?;
        }
    }
    writeln!(file, "{}", pattern.trim()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Get unpushed commit summaries (HEAD vs upstream).
pub fn get_unpushed_commits(path: &str) -> Result<Vec<String>, String> {
    let output = run_git(path, &["log", "@{upstream}..HEAD", "--oneline"])?;
    Ok(output.lines().map(|l| l.to_string()).filter(|l| !l.is_empty()).collect())
}

/// Check if a PR already exists for the current branch (requires gh CLI).
pub fn git_pr_status(path: &str) -> Result<Option<String>, String> {
    match run_cmd(path, "gh", &["pr", "view", "--json", "url", "--jq", ".url"]) {
        Ok(url) if !url.trim().is_empty() => Ok(Some(url.trim().to_string())),
        _ => Ok(None),
    }
}

/// Create a PR using gh CLI. Returns the PR URL.
pub fn git_create_pr(path: &str, title: &str, body: &str, base: &str) -> Result<String, String> {
    let output = run_cmd(path, "gh", &["pr", "create", "--title", title, "--body", body, "--base", base])?;
    // gh pr create outputs the PR URL on the last line
    let url = output.lines().last().unwrap_or("").trim().to_string();
    Ok(url)
}

/// Get the default branch name (main or master).
pub fn git_default_branch(path: &str) -> Result<String, String> {
    // Try to get remote HEAD
    if let Ok(output) = run_git(path, &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]) {
        let branch = output.trim().strip_prefix("origin/").unwrap_or(output.trim());
        if !branch.is_empty() {
            return Ok(branch.to_string());
        }
    }
    // Fallback: check if main or master exists
    if run_git(path, &["rev-parse", "--verify", "main"]).is_ok() {
        return Ok("main".to_string());
    }
    if run_git(path, &["rev-parse", "--verify", "master"]).is_ok() {
        return Ok("master".to_string());
    }
    Ok("main".to_string())
}

/// Run an arbitrary command (not just git).
fn run_cmd(path: &str, cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .current_dir(path)
        .silent()
        .output()
        .map_err(|e| format!("{cmd} failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Push to the remote.
/// Disables credential prompts to avoid hanging when not authenticated.
pub fn git_push(path: &str) -> Result<(), String> {
    run_git_no_prompt(path, &["push"])
}

/// Pull from the remote.
/// Disables credential prompts to avoid hanging when not authenticated.
pub fn git_pull(path: &str) -> Result<(), String> {
    run_git_no_prompt(path, &["pull"])
}

/// Run a git command with credential prompts disabled and a timeout.
/// This prevents git from hanging when waiting for interactive authentication.
fn run_git_no_prompt(dir: &str, args: &[&str]) -> Result<(), String> {
    use std::io::Read;

    let mut child = Command::new(git_bin())
        .arg("-C")
        .arg(dir)
        .args(args)
        // Disable interactive credential prompts
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .silent()
        .spawn()
        .map_err(|e| format!("Failed to spawn git: {e}"))?;

    // Wait with 30s timeout
    let timeout = std::time::Duration::from_secs(30);
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut stderr = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                let msg = stderr.trim().to_string();
                if msg.contains("could not read Username")
                    || msg.contains("Authentication failed")
                    || msg.contains("terminal prompts disabled")
                {
                    return Err("Authentication failed. Please configure Git credentials or log in.".to_string());
                }
                return Err(if msg.is_empty() { format!("git exited with {status}") } else { msg });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err("Git operation timed out (30s). Check your network connection and credentials.".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Failed to wait for git: {e}")),
        }
    }
}

/// Stash local changes, pull, then pop.
pub fn git_stash_pull(path: &str) -> Result<(), String> {
    run_git(path, &["stash", "push", "-m", "racemo-auto-stash"])?;
    let pull_result = run_git(path, &["pull"]);
    if let Err(e) = pull_result {
        let _ = run_git(path, &["stash", "pop"]);
        return Err(e);
    }
    run_git(path, &["stash", "pop"])?;
    Ok(())
}

/// Stash local changes, pull with rebase, then pop.
pub fn git_stash_rebase_pull(path: &str) -> Result<(), String> {
    run_git(path, &["stash", "push", "-m", "racemo-auto-stash"])?;
    let pull_result = run_git(path, &["pull", "--rebase"]);
    if let Err(e) = pull_result {
        let _ = run_git(path, &["rebase", "--abort"]);
        let _ = run_git(path, &["stash", "pop"]);
        return Err(e);
    }
    run_git(path, &["stash", "pop"])?;
    Ok(())
}

// ── Refs (branches, tags, stashes) ───────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefList {
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub tags: Vec<String>,
    pub stashes: Vec<String>,
    pub current_branch: String,
}

/// List all branches, tags, and stashes.
pub fn get_ref_list(path: &str) -> Result<GitRefList, String> {
    // Current branch
    let current_branch = run_git(path, &["symbolic-ref", "--short", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    // Local branches
    let local_output = run_git(path, &["branch", "--format=%(refname:short)"])?;
    let local_branches: Vec<String> = local_output
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    // Remote branches
    let remote_output = run_git(path, &["branch", "-r", "--format=%(refname:short)"])?;
    let remote_branches: Vec<String> = remote_output
        .lines()
        .filter(|s| !s.is_empty() && !s.contains("HEAD"))
        .map(|s| s.to_string())
        .collect();

    // Tags
    let tag_output = run_git(path, &["tag", "--sort=-creatordate"])?;
    let tags: Vec<String> = tag_output
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    // Stashes
    let stash_output = run_git(path, &["stash", "list", "--format=%gd: %gs"])
        .unwrap_or_default();
    let stashes: Vec<String> = stash_output
        .lines()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(GitRefList {
        local_branches,
        remote_branches,
        tags,
        stashes,
        current_branch,
    })
}

// ── Worktree ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub is_bare: bool,
    pub is_main: bool,
    pub is_locked: bool,
    pub is_dirty: bool,
}

/// List all worktrees using `git worktree list --porcelain`.
pub fn list_worktrees(path: &str) -> Result<Vec<GitWorktreeEntry>, String> {
    let output = run_git(path, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut current_path = String::new();
    let mut current_head = String::new();
    let mut current_branch = String::new();
    let mut is_bare = false;

    let mut current_is_locked = false;

    for line in output.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // Save previous entry if we have one
            if !current_path.is_empty() {
                let is_dirty = run_git(&current_path, &["status", "--porcelain"])
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);

                entries.push(GitWorktreeEntry {
                    path: current_path.clone(),
                    head: current_head.clone(),
                    branch: current_branch.clone(),
                    is_bare,
                    is_main: entries.is_empty(),
                    is_locked: current_is_locked,
                    is_dirty,
                });
            }
            current_path = p.to_string();
            current_head = String::new();
            current_branch = String::new();
            is_bare = false;
            current_is_locked = false;
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            current_head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            current_branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line == "bare" {
            is_bare = true;
        } else if line.starts_with("locked") {
            current_is_locked = true;
        } else if line == "detached" && current_branch.is_empty() {
            let short: String = current_head.chars().take(7).collect();
            current_branch = format!("(detached {})", short);
        }
    }

    // Push last entry
    if !current_path.is_empty() {
        let is_dirty = run_git(&current_path, &["status", "--porcelain"])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        entries.push(GitWorktreeEntry {
            path: current_path,
            head: current_head,
            branch: current_branch,
            is_bare,
            is_main: entries.is_empty(),
            is_locked: current_is_locked,
            is_dirty,
        });
    }

    Ok(entries)
}

/// Sync a worktree by fetching and merging/rebasing from its base branch.
pub fn sync_worktree(path: &str, worktree_path: &str, base: &str, rebase: bool) -> Result<(), String> {
    // 1. Fetch
    run_git(path, &["fetch", "origin"])?;

    // 2. Sync (rebase or merge) — auto-stash unstaged changes
    if rebase {
        run_git(worktree_path, &["rebase", "--autostash", base])?;
    } else {
        // Check for unstaged changes and stash if needed
        let stashed = run_git(worktree_path, &["stash", "push", "--include-untracked", "-m", "racemo-autostash"]).is_ok();
        let merge_result = run_git(worktree_path, &["merge", base]);
        if stashed {
            let _ = run_git(worktree_path, &["stash", "pop"]);
        }
        merge_result?;
    }

    Ok(())
}

/// Apply changes from a worktree to a target branch.
pub fn apply_worktree(path: &str, worktree_path: &str, target: &str, squash: bool) -> Result<(), String> {
    // 1. Ensure target branch is checked out in main or some repository root
    // Actually, usually we merge the worktree's branch INTO the target.
    let entry = list_worktrees(path)?
        .into_iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {}", worktree_path))?;

    if entry.branch.is_empty() {
        return Err("Worktree has no branch to apply".into());
    }

    // 2. Merge into target
    // We assume the user wants to merge 'entry.branch' into 'target'
    // This is best done from the main repo or where 'target' can be checked out.
    // However, git merge can be done if we are on 'target'.
    
    // For simplicity, let's assume we use the main repo root to do the merge
    let main_path = path;

    // Checkout target (skip if already on target branch — avoids worktree conflict)
    let current = get_repo_info(main_path).map(|i| i.branch).unwrap_or_default();
    if current != target {
        run_git(main_path, &["checkout", target])?;
    }

    let mut args = vec!["merge"];
    if squash {
        args.push("--squash");
    }
    args.push(&entry.branch);

    run_git(main_path, &args)?;

    Ok(())
}

/// Cherry-pick specific commits into a worktree.
pub fn cherry_pick_worktree(worktree_path: &str, commits: &[&str]) -> Result<(), String> {
    for &commit in commits {
        run_git(worktree_path, &["cherry-pick", "--allow-empty", commit])?;
    }
    Ok(())
}

/// Reset a worktree HEAD to a specific commit.
pub fn reset_worktree(worktree_path: &str, commit: &str, mode: &str) -> Result<(), String> {
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    run_git(worktree_path, &["reset", flag, commit])?;
    Ok(())
}

/// Lock a worktree.
pub fn lock_worktree(path: &str, worktree_path: &str, reason: Option<String>) -> Result<(), String> {
    let mut args = vec!["worktree", "lock"];
    let reason_str;
    if let Some(r) = reason {
        if !r.is_empty() {
            reason_str = r;
            args.push("--reason");
            args.push(&reason_str);
            args.push(worktree_path);
            return run_git(path, &args).map(|_| ());
        }
    }
    args.push(worktree_path);
    run_git(path, &args)?;
    Ok(())
}

/// Unlock a worktree.
pub fn unlock_worktree(path: &str, worktree_path: &str) -> Result<(), String> {
    run_git(path, &["worktree", "unlock", worktree_path])?;
    Ok(())
}

/// Add a new worktree. If `new_branch` is true, creates the branch first.
pub fn add_worktree(path: &str, worktree_path: &str, branch: &str, new_branch: bool, target: Option<String>) -> Result<(), String> {
    let mut args = vec!["worktree", "add"];
    if new_branch {
        args.push("-b");
        args.push(branch);
        args.push(worktree_path);
        // target is optional commit/branch for the new branch
        if let Some(t) = target.as_deref() {
            if !t.is_empty() {
                args.push(t);
            }
        }
    } else {
        // Checking out existing branch or commit
        // If branch name is provided but new_branch is false, it might mean we want to checkout that existing branch
        // Or if target is provided, we use that.
        // git worktree add <path> <commit-ish>
        args.push(worktree_path);
        if let Some(t) = target.as_deref() {
             if !t.is_empty() {
                args.push(t);
            }
        } else if !branch.is_empty() {
            args.push(branch);
        }
    }
    
    run_git(path, &args)?;
    Ok(())
}

/// Remove a worktree. If `force` is true, uses --force.
pub fn remove_worktree(path: &str, worktree_path: &str, force: bool) -> Result<(), String> {
    if force {
        run_git(path, &["worktree", "remove", "--force", worktree_path])?;
    } else {
        run_git(path, &["worktree", "remove", worktree_path])?;
    }
    Ok(())
}

/// Prune stale worktree references.
pub fn prune_worktrees(path: &str) -> Result<(), String> {
    run_git(path, &["worktree", "prune"])?;
    Ok(())
}

/// Delete a branch.
pub fn delete_branch(path: &str, branch: &str) -> Result<(), String> {
    run_git(path, &["branch", "-D", branch])?;
    Ok(())
}

/// Get unified diff for a specific file.
/// If `staged` is true, uses `--cached` to show staged changes.
/// `context_lines` controls how many context lines surround each hunk (default 3).
/// For untracked files, uses --no-index to show full content as additions.
pub fn diff_file(path: &str, file: &str, staged: bool, context_lines: Option<u32>) -> Result<String, String> {
    let ctx = format!("-U{}", context_lines.unwrap_or(3));

    // First try normal diff
    let result = if staged {
        run_git(path, &["diff", &ctx, "--cached", "--", file])
    } else {
        run_git(path, &["diff", &ctx, "--", file])
    };

    // If diff is empty, check if file is untracked (new file)
    if let Ok(ref diff) = result {
        if diff.trim().is_empty() {
            // Check if file is untracked
            let status = run_git(path, &["status", "--porcelain", "--", file])?;
            if status.starts_with("??") || status.starts_with("A ") || status.starts_with("A  ") {
                // Untracked or newly added file - use --no-index to show as all additions
                // Note: git diff --no-index exits with 1 when files differ, which is expected
                let file_path = std::path::Path::new(path).join(file);
                if file_path.exists() {
                    // Read file and create a synthetic diff
                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                        let lines: Vec<&str> = content.lines().collect();
                        let line_count = lines.len();
                        let mut diff_output = format!("diff --git a/{} b/{}\n", file, file);
                        diff_output.push_str("new file mode 100644\n");
                        diff_output.push_str("--- /dev/null\n");
                        diff_output.push_str(&format!("+++ b/{}\n", file));
                        diff_output.push_str(&format!("@@ -0,0 +1,{} @@\n", line_count));
                        for line in lines {
                            diff_output.push_str(&format!("+{}\n", line));
                        }
                        return Ok(diff_output);
                    }
                }
            }
        }
    }

    result
}

/// Get a diff summary for generating commit messages.
/// Returns combined diff stat + short diff for staged changes (or all if nothing staged).
pub fn diff_summary(path: &str) -> Result<String, String> {
    // Check if there are staged changes
    let staged_stat = run_git(path, &["diff", "--cached", "--stat"])?;
    let has_staged = !staged_stat.trim().is_empty();

    if has_staged {
        let stat = run_git(path, &["diff", "--cached", "--stat"])?;
        let diff = run_git(path, &["diff", "--cached", "-U1", "--no-color"])?;
        // Truncate diff to ~4000 chars to keep it manageable
        let truncated = if diff.len() > 4000 { &diff[..4000] } else { &diff };
        Ok(format!("{}\n---\n{}", stat, truncated))
    } else {
        let stat = run_git(path, &["diff", "--stat"])?;
        let diff = run_git(path, &["diff", "-U1", "--no-color"])?;
        let truncated = if diff.len() > 4000 { &diff[..4000] } else { &diff };
        Ok(format!("{}\n---\n{}", stat, truncated))
    }
}

/// Checkout a specific commit. If `detached` is true, uses `--detach`.
pub fn checkout_commit(path: &str, hash: &str, detached: bool) -> Result<(), String> {
    if detached {
        run_git(path, &["checkout", "--detach", hash])?;
    } else {
        run_git(path, &["checkout", hash])?;
    }
    Ok(())
}

/// Create a new branch at the given start point (optional).
pub fn create_branch(path: &str, name: &str, start_point: Option<&str>) -> Result<(), String> {
    match start_point {
        Some(sp) => run_git(path, &["branch", name, sp])?,
        None => run_git(path, &["branch", name])?,
    };
    Ok(())
}

/// Create a tag at the given commit hash (optional).
pub fn create_tag(path: &str, name: &str, hash: Option<&str>) -> Result<(), String> {
    match hash {
        Some(h) => run_git(path, &["tag", name, h])?,
        None => run_git(path, &["tag", name])?,
    };
    Ok(())
}

/// Cherry-pick a commit.
pub fn cherry_pick(path: &str, hash: &str) -> Result<(), String> {
    run_git(path, &["cherry-pick", hash])?;
    Ok(())
}

/// Revert a commit (no-edit).
pub fn revert_commit(path: &str, hash: &str) -> Result<(), String> {
    run_git(path, &["revert", "--no-edit", hash])?;
    Ok(())
}

/// Get the remote URL for origin.
pub fn get_remote_url(path: &str) -> Result<String, String> {
    run_git(path, &["remote", "get-url", "origin"])
}

/// Show the patch for a specific commit.
pub fn show_commit_patch(path: &str, hash: &str) -> Result<String, String> {
    run_git(path, &["show", "--format=format:", "--patch", hash])
}

/// Diff between two commits.
pub fn diff_commits(path: &str, hash1: &str, hash2: &str) -> Result<String, String> {
    run_git(path, &["diff", hash1, hash2])
}

/// Find the merge base of two commits.
pub fn merge_base(path: &str, hash1: &str, hash2: &str) -> Result<String, String> {
    run_git(path, &["merge-base", hash1, hash2])
}

/// Resolve a conflicted file by accepting "ours" version.
pub fn resolve_ours(path: &str, file: &str) -> Result<(), String> {
    run_git(path, &["checkout", "--ours", "--", file])?;
    run_git(path, &["add", "--", file])?;
    Ok(())
}

/// Resolve a conflicted file by accepting "theirs" version.
pub fn resolve_theirs(path: &str, file: &str) -> Result<(), String> {
    run_git(path, &["checkout", "--theirs", "--", file])?;
    run_git(path, &["add", "--", file])?;
    Ok(())
}

/// Abort an in-progress merge.
pub fn merge_abort(path: &str) -> Result<(), String> {
    run_git(path, &["merge", "--abort"])?;
    Ok(())
}

/// Get the configured merge tool name (returns empty string if none).
pub fn get_mergetool_name(path: &str) -> Result<String, String> {
    match run_git(path, &["config", "merge.tool"]) {
        Ok(name) => Ok(name),
        Err(_) => Ok(String::new()),
    }
}

/// Launch external mergetool for a file (non-blocking spawn).
/// Does NOT use CREATE_NO_WINDOW so the GUI tool is visible.
pub fn mergetool(path: &str, file: &str) -> Result<(), String> {
    let mut cmd = Command::new(git_bin());
    cmd.arg("-C").arg(path).args(["mergetool", "--no-prompt", "--", file]);
    // NOTE: No CREATE_NO_WINDOW — external merge tools need a visible window.
    cmd.spawn().map_err(|e| format!("Failed to launch mergetool: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    push_log(GitCommandLogEntry {
        timestamp: ts,
        command: format!("git mergetool --no-prompt -- {}", file),
        success: true,
        output: "spawned".to_string(),
        duration_ms: 0,
    });
    Ok(())
}

/// Open a conflicted file in VS Code's merge editor.
pub fn open_in_vscode_merge(path: &str, file: &str) -> Result<(), String> {
    let file_path = Path::new(path).join(file);
    Command::new("code")
        .arg("--wait")
        .arg("--merge")
        .arg(&file_path)
        .arg(&file_path)
        .arg(&file_path)
        .arg(&file_path)
        .silent()
        .spawn()
        .map_err(|e| format!("Failed to open VS Code: {e}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    push_log(GitCommandLogEntry {
        timestamp: ts,
        command: format!("code --wait --merge {}", file_path.display()),
        success: true,
        output: "spawned".to_string(),
        duration_ms: 0,
    });
    Ok(())
}

/// Return the patch text for a single hunk (for saving before discard).
/// Get raw diff output without trimming (preserves trailing context lines).
fn raw_diff(path: &str, file: &str, staged: bool) -> Result<String, String> {
    if staged {
        run_git_raw(path, &["diff", "-U3", "--cached", "--", file])
    } else {
        run_git_raw(path, &["diff", "-U3", "--", file])
    }
}

/// Apply a patch string (re-apply previously discarded changes).
/// Uses --cached for staged hunks. Falls back to --3way merge.
pub fn apply_patch(path: &str, patch: &str, staged: bool) -> Result<(), String> {
    let normalized = normalize_patch(patch);
    let base_args: Vec<&str> = if staged {
        vec!["apply", "--cached", "--whitespace=nowarn"]
    } else {
        vec!["apply", "--whitespace=nowarn"]
    };
    let fallback_args: Vec<&str> = if staged {
        vec!["apply", "--3way", "--cached", "--whitespace=nowarn"]
    } else {
        vec!["apply", "--3way", "--whitespace=nowarn"]
    };
    run_git_stdin(path, &base_args, &normalized)
        .or_else(|_| run_git_stdin(path, &fallback_args, &normalized))
        .map(|_| ())
}

/// Atomically extract the hunk patch and discard it in one operation.
/// Returns the saved patch text on success (for undo).
pub fn discard_hunk(path: &str, file: &str, staged: bool, hunk_index: usize) -> Result<String, String> {
    let diff = raw_diff(path, file, staged)?;
    let patch = extract_hunk_patch(&diff, hunk_index)?;
    let result = if staged {
        run_git_stdin(path, &["apply", "--reverse", "--cached", "--whitespace=nowarn"], &patch)
    } else {
        run_git_stdin(path, &["apply", "--reverse", "--whitespace=nowarn"], &patch)
    };
    result.map(|_| patch)
}

fn normalize_patch(patch: &str) -> String {
    if patch.ends_with('\n') { patch.to_string() } else { format!("{patch}\n") }
}

/// Extract diff header + a single hunk to form a valid patch.
fn extract_hunk_patch(diff: &str, hunk_index: usize) -> Result<String, String> {
    // Split while preserving line endings so patch stays byte-exact
    let raw_lines: Vec<&str> = diff.split('\n').collect();

    let mut header_end = 0; // first line index that is a hunk
    let mut hunk_starts: Vec<usize> = Vec::new();

    for (i, line) in raw_lines.iter().enumerate() {
        if line.starts_with("@@") {
            if hunk_starts.is_empty() {
                header_end = i;
            }
            hunk_starts.push(i);
        }
    }
    // Include `\ No newline at end of file` lines as part of the preceding hunk.
    // These lines start with `\` and must stay attached to their hunk for valid patches.

    if hunk_starts.is_empty() {
        return Err("No hunks found in diff".to_string());
    }
    if hunk_index >= hunk_starts.len() {
        return Err(format!("Hunk index {} out of range ({})", hunk_index, hunk_starts.len()));
    }

    let hunk_start = hunk_starts[hunk_index];
    let hunk_end = if hunk_index + 1 < hunk_starts.len() {
        hunk_starts[hunk_index + 1]
    } else {
        // Last hunk: trim only truly empty trailing lines, keep `\ No newline` lines
        let mut end = raw_lines.len();
        while end > hunk_start && raw_lines[end - 1].is_empty() {
            end -= 1;
        }
        end
    };

    let mut patch = raw_lines[..header_end].join("\n");
    patch.push('\n');
    patch.push_str(&raw_lines[hunk_start..hunk_end].join("\n"));
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    Ok(patch)
}
