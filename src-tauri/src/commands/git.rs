use tauri::command;
use crate::git;
use crate::process_util::SilentCommandExt;

#[command]
pub fn git_init(path: String) -> Result<(), String> {
    git::git_init(&path)
}

#[command]
pub fn git_repo_info(path: String) -> Result<git::GitRepoInfo, String> {
    git::get_repo_info(&path)
}

#[command]
pub fn git_file_statuses(path: String) -> Result<git::GitFileStatuses, String> {
    git::get_file_statuses(&path)
}

#[command]
pub fn git_commit_log(path: String, count: Option<u32>, all: Option<bool>) -> Result<Vec<git::GitCommitEntry>, String> {
    git::get_commit_log(&path, count.unwrap_or(50), all.unwrap_or(false))
}

#[command]
pub fn git_ref_list(path: String) -> Result<git::GitRefList, String> {
    git::get_ref_list(&path)
}

#[command]
pub fn git_commit_detail(path: String, hash: String) -> Result<git::GitCommitDetail, String> {
    git::get_commit_detail(&path, &hash)
}

#[command]
pub fn git_stage_file(path: String, file_path: String) -> Result<(), String> {
    git::stage_file(&path, &file_path)
}

#[command]
pub fn git_unstage_file(path: String, file_path: String) -> Result<(), String> {
    git::unstage_file(&path, &file_path)
}

#[command]
pub fn git_stage_all(path: String) -> Result<(), String> {
    git::stage_all(&path)
}

#[command]
pub fn git_unstage_all(path: String) -> Result<(), String> {
    git::unstage_all(&path)
}

#[command]
pub fn git_commit(path: String, message: String) -> Result<(), String> {
    git::git_commit(&path, &message)
}

#[command]
pub fn git_discard_file(path: String, file_path: String) -> Result<(), String> {
    git::discard_file(&path, &file_path)
}

#[command]
pub fn git_unpushed_commits(path: String) -> Result<Vec<String>, String> {
    git::get_unpushed_commits(&path)
}

#[command]
pub fn git_pr_status(path: String) -> Result<Option<String>, String> {
    git::git_pr_status(&path)
}

#[command]
pub fn git_create_pr(path: String, title: String, body: String, base: String) -> Result<String, String> {
    git::git_create_pr(&path, &title, &body, &base)
}

#[command]
pub fn git_default_branch(path: String) -> Result<String, String> {
    git::git_default_branch(&path)
}

#[command]
pub fn git_push(path: String) -> Result<(), String> {
    git::git_push(&path)
}

#[command]
pub fn git_pull(path: String) -> Result<(), String> {
    git::git_pull(&path)
}

#[command]
pub fn git_stash_pull(path: String) -> Result<(), String> {
    git::git_stash_pull(&path)
}

#[command]
pub fn git_stash_rebase_pull(path: String) -> Result<(), String> {
    git::git_stash_rebase_pull(&path)
}

#[command]
pub fn git_add_to_gitignore(path: String, pattern: String) -> Result<(), String> {
    git::add_to_gitignore(&path, &pattern)
}

#[command]
pub fn git_worktree_list(path: String) -> Result<Vec<git::GitWorktreeEntry>, String> {
    git::list_worktrees(&path)
}

#[command]
pub fn git_worktree_add(path: String, worktree_path: String, branch: String, new_branch: bool, target: Option<String>) -> Result<(), String> {
    git::add_worktree(&path, &worktree_path, &branch, new_branch, target)
}

#[command]
pub fn git_worktree_remove(path: String, worktree_path: String, force: bool) -> Result<(), String> {
    git::remove_worktree(&path, &worktree_path, force)
}

#[command]
pub fn git_worktree_prune(path: String) -> Result<(), String> {
    git::prune_worktrees(&path)
}

#[command]
pub fn git_worktree_sync(path: String, worktree_path: String, base: String, rebase: bool) -> Result<(), String> {
    git::sync_worktree(&path, &worktree_path, &base, rebase)
}

#[command]
pub fn git_worktree_apply(path: String, worktree_path: String, target: String, squash: bool) -> Result<(), String> {
    git::apply_worktree(&path, &worktree_path, &target, squash)
}

#[command]
pub fn git_worktree_cherry_pick(worktree_path: String, commits: Vec<String>) -> Result<(), String> {
    let refs: Vec<&str> = commits.iter().map(|s| s.as_str()).collect();
    git::cherry_pick_worktree(&worktree_path, &refs)
}

#[command]
pub fn git_worktree_reset(worktree_path: String, commit: String, mode: String) -> Result<(), String> {
    git::reset_worktree(&worktree_path, &commit, &mode)
}

#[command]
pub fn git_worktree_lock(path: String, worktree_path: String, reason: Option<String>) -> Result<(), String> {
    git::lock_worktree(&path, &worktree_path, reason)
}

#[command]
pub fn git_worktree_unlock(path: String, worktree_path: String) -> Result<(), String> {
    git::unlock_worktree(&path, &worktree_path)
}

#[command]
pub fn git_delete_branch(path: String, branch: String) -> Result<(), String> {
    git::delete_branch(&path, &branch)
}

#[command]
pub fn git_diff_file(path: String, file_path: String, staged: bool, context_lines: Option<u32>) -> Result<String, String> {
    git::diff_file(&path, &file_path, staged, context_lines)
}

#[command]
pub fn git_discard_hunk(path: String, file_path: String, staged: bool, hunk_index: usize) -> Result<String, String> {
    git::discard_hunk(&path, &file_path, staged, hunk_index)
}

#[command]
pub fn git_apply_patch(path: String, patch: String, staged: bool) -> Result<(), String> {
    git::apply_patch(&path, &patch, staged)
}

#[command]
pub fn git_diff_summary(path: String) -> Result<String, String> {
    git::diff_summary(&path)
}

#[command]
pub fn git_checkout_commit(path: String, hash: String, detached: bool) -> Result<(), String> {
    git::checkout_commit(&path, &hash, detached)
}

#[command]
pub fn git_create_branch(path: String, name: String, start_point: Option<String>) -> Result<(), String> {
    git::create_branch(&path, &name, start_point.as_deref())
}

#[command]
pub fn git_create_tag(path: String, name: String, hash: Option<String>) -> Result<(), String> {
    git::create_tag(&path, &name, hash.as_deref())
}

#[command]
pub fn git_cherry_pick(path: String, hash: String) -> Result<(), String> {
    git::cherry_pick(&path, &hash)
}

#[command]
pub fn git_revert_commit(path: String, hash: String) -> Result<(), String> {
    git::revert_commit(&path, &hash)
}

#[command]
pub fn git_get_remote_url(path: String) -> Result<String, String> {
    git::get_remote_url(&path)
}

#[command]
pub fn git_show_commit_patch(path: String, hash: String) -> Result<String, String> {
    git::show_commit_patch(&path, &hash)
}

#[command]
pub fn git_diff_commits(path: String, hash1: String, hash2: String) -> Result<String, String> {
    git::diff_commits(&path, &hash1, &hash2)
}

#[command]
pub fn git_merge_base(path: String, hash1: String, hash2: String) -> Result<String, String> {
    git::merge_base(&path, &hash1, &hash2)
}

#[command]
pub fn git_resolve_ours(path: String, file_path: String) -> Result<(), String> {
    git::resolve_ours(&path, &file_path)
}

#[command]
pub fn git_resolve_theirs(path: String, file_path: String) -> Result<(), String> {
    git::resolve_theirs(&path, &file_path)
}

#[command]
pub fn git_merge_abort(path: String) -> Result<(), String> {
    git::merge_abort(&path)
}

#[command]
pub fn git_mergetool(path: String, file_path: String) -> Result<(), String> {
    git::mergetool(&path, &file_path)
}

#[command]
pub fn git_mergetool_name(path: String) -> Result<String, String> {
    git::get_mergetool_name(&path)
}

#[command]
pub fn git_open_vscode_merge(path: String, file_path: String) -> Result<(), String> {
    git::open_in_vscode_merge(&path, &file_path)
}

#[command]
pub fn git_command_log() -> Vec<git::GitCommandLogEntry> {
    git::get_command_log()
}

#[command]
pub fn git_clear_command_log() {
    git::clear_command_log();
}

/// List remote repositories from the detected hosting CLI.
#[command]
pub fn git_list_remote_repos(limit: Option<u32>) -> Result<Vec<RemoteRepo>, String> {
    use std::process::Command as StdCommand;
    let limit = limit.unwrap_or(20);

    // Try gh first
    if let Ok(output) = StdCommand::new("gh")
        .args(["repo", "list", "--json", "name,url,isPrivate,updatedAt", "--limit", &limit.to_string()])
        .silent()
        .output()
    {
        if output.status.success() {
            let json = String::from_utf8_lossy(&output.stdout);
            if let Ok(repos) = serde_json::from_str::<Vec<GhRepo>>(&json) {
                return Ok(repos.into_iter().map(|r| RemoteRepo {
                    name: r.name,
                    url: r.url,
                    is_private: r.is_private,
                }).collect());
            }
        }
    }

    // Try glab
    if let Ok(output) = StdCommand::new("glab")
        .args(["repo", "list", "--output", "json"])
        .silent()
        .output()
    {
        if output.status.success() {
            let json = String::from_utf8_lossy(&output.stdout);
            if let Ok(repos) = serde_json::from_str::<Vec<GlabRepo>>(&json) {
                return Ok(repos.into_iter().take(limit as usize).map(|r| RemoteRepo {
                    name: r.path_with_namespace.unwrap_or(r.name),
                    url: r.http_url_to_repo.unwrap_or_default(),
                    is_private: r.visibility.as_deref() == Some("private"),
                }).collect());
            }
        }
    }

    Ok(vec![])
}

#[derive(serde::Deserialize)]
struct GhRepo {
    name: String,
    url: String,
    #[serde(rename = "isPrivate")]
    is_private: bool,
}

#[derive(serde::Deserialize)]
struct GlabRepo {
    name: String,
    #[serde(default)]
    path_with_namespace: Option<String>,
    #[serde(default)]
    http_url_to_repo: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
}

#[derive(serde::Serialize)]
pub struct RemoteRepo {
    pub name: String,
    pub url: String,
    pub is_private: bool,
}

/// Detect which git hosting CLI is available (gh, glab, or none).
#[command]
pub fn git_detect_hosting_cli() -> Option<String> {
    use std::process::Command as StdCommand;
    for cli in &["gh", "glab"] {
        if StdCommand::new(cli)
            .arg("--version")
            .silent()
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return Some(cli.to_string());
        }
    }
    None
}

/// Run a git command and stream output line-by-line via Tauri events.
/// Returns true if the command exited successfully.
#[command]
pub async fn git_exec_streaming(
    app: tauri::AppHandle,
    cwd: String,
    args: Vec<String>,
    channel_id: String,
) -> Result<bool, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command as StdCommand, Stdio};
    use std::thread;
    use tokio::sync::mpsc;
    use tauri::Emitter;

    #[derive(Clone, serde::Serialize)]
    struct LineEvent {
        line: String,
        is_err: bool,
    }

    let mut child = StdCommand::new("git")
        .current_dir(&cwd)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .silent()
        .spawn()
        .map_err(|e| e.to_string())?;

    crate::commands::streaming::register(&channel_id, child.id());
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, bool)>();

    let stdout = child.stdout.take().ok_or("stdout already taken")?;
    let tx1 = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx1.send((line, false));
        }
    });

    let stderr = child.stderr.take().ok_or("stderr already taken")?;
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx.send((line, true));
        }
    });

    let event_name = format!("git-out-{}", channel_id);
    while let Some((line, is_err)) = rx.recv().await {
        let _ = app.emit(&event_name, LineEvent { line, is_err });
    }

    crate::commands::streaming::unregister(&channel_id);
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.success())
}
