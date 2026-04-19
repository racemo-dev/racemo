use tauri::{State, AppHandle, command, Manager};
use tauri_plugin_store::StoreExt;
use serde::Serialize;
use std::fs;
use std::path::Path;
use super::IpcState;
use crate::ipc::protocol::ClientMessage;
use crate::process_util::SilentCommandExt;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

/// Bridge a log message from the webview to the Rust logger so it ends up in
/// ~/Library/Logs/com.racemo.app/Racemo.log alongside backend logs.
#[command]
pub fn fe_log(level: String, msg: String) {
    match level.as_str() {
        "error" => log::error!("[fe] {msg}"),
        "warn" => log::warn!("[fe] {msg}"),
        "info" => log::info!("[fe] {msg}"),
        _ => log::debug!("[fe] {msg}"),
    }
}

/// List directory contents sorted: directories first, then files, both alphabetical.
#[command]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ft = match entry.file_type().or_else(|_| fs::metadata(entry.path()).map(|m| m.file_type())) {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            dirs.push(DirEntry {
                name,
                entry_type: "dir".into(),
            });
        } else {
            files.push(DirEntry {
                name,
                entry_type: "file".into(),
            });
        }
    }
    dirs.sort_by_key(|e| e.name.to_lowercase());
    files.sort_by_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// List directory contents with .gitignore filtering.
/// Collects ignore rules from the git root down to the target directory.
#[command]
pub fn list_directory_gitfiltered(path: String, git_root: Option<String>) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Collect gitignore rules from git root down to path
    let mut rules = Vec::new();
    if let Some(ref root) = git_root {
        let root_path = Path::new(root);
        rules.extend(load_ignore_rules(root_path));
        // Walk from root to current dir, loading rules at each level
        if let Ok(rel) = dir.strip_prefix(root_path) {
            let mut current = root_path.to_path_buf();
            for component in rel.components() {
                current = current.join(component);
                if current != root_path {
                    rules.extend(load_ignore_rules(&current));
                }
            }
        }
    } else {
        rules.extend(load_ignore_rules(dir));
    }

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();
        let ft = match entry.file_type().or_else(|_| fs::metadata(&entry_path).map(|m| m.file_type())) {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_dir = ft.is_dir();
        if !rules.is_empty() && is_ignored(&rules, &entry_path, is_dir) {
            continue;
        }
        if is_dir {
            dirs.push(DirEntry { name, entry_type: "dir".into() });
        } else {
            files.push(DirEntry { name, entry_type: "file".into() });
        }
    }
    dirs.sort_by_key(|e| e.name.to_lowercase());
    files.sort_by_key(|e| e.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

/// Check if a directory contains any document files (recursively).
/// Used by the explorer docs filter to hide empty directories.
#[command]
pub fn dir_has_docs(path: String, extensions: Vec<String>) -> bool {
    let dir = Path::new(&path);
    if !dir.is_dir() { return false; }
    check_dir_has_docs(dir, &extensions, 0)
}

fn check_dir_has_docs(dir: &Path, extensions: &[String], depth: u32) -> bool {
    if depth > 10 { return false; }
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return false };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let path = entry.path();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) { continue; }
            if check_dir_has_docs(&path, extensions, depth + 1) { return true; }
        } else if let Some(ext) = name.rsplit('.').next() {
            if extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)) { return true; }
        }
    }
    false
}

/// List directory entries matching a partial prefix for autocomplete.
/// Unlike list_directory, this includes dotfiles if partial starts with '.'.
#[command]
pub fn list_directory_filtered(dir: String, partial: String) -> Result<Vec<DirEntry>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Ok(vec![]);
    }
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {e}"))?;
    let lower_partial = partial.to_lowercase();
    let mut result: Vec<DirEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && !partial.starts_with('.') {
                return None;
            }
            if !lower_partial.is_empty() && !name.to_lowercase().starts_with(&lower_partial) {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntry {
                name,
                entry_type: if is_dir { "dir".into() } else { "file".into() },
            })
        })
        .take(20)
        .collect();
    result.sort_by(|a, b| {
        let a_dir = a.entry_type == "dir";
        let b_dir = b.entry_type == "dir";
        b_dir.cmp(&a_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

fn resolve_home() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())
}

fn prompts_dir() -> Result<std::path::PathBuf, String> {
    Ok(Path::new(&resolve_home()?).join(".racemo").join("prompts"))
}

#[command]
pub fn get_home_dir() -> Result<String, String> {
    resolve_home()
}

/// Get the prompts directory path, creating it and default files if needed.
#[command]
pub fn get_prompts_dir() -> Result<String, String> {
    let dir = prompts_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create prompts dir: {e}"))?;
    }

    let defaults: &[(&str, &str)] = &[
        ("review.md", include_str!("../../prompts/review.md")),
        ("commit.md", include_str!("../../prompts/commit.md")),
        ("pr.md", include_str!("../../prompts/pr.md")),
        ("auto-commit.md", include_str!("../../prompts/auto-commit.md")),
        ("fix.md", include_str!("../../prompts/fix.md")),
    ];

    for (name, content) in defaults {
        let path = dir.join(name);
        if !path.exists() {
            fs::write(&path, content).map_err(|e| format!("Failed to write {name}: {e}"))?;
        }
    }

    Ok(dir.to_string_lossy().to_string())
}

/// Validate prompt file name: must be `[a-zA-Z0-9_-]+\.md`
fn validate_prompt_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.ends_with(".md")
        && name[..name.len() - 3]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("Invalid prompt file name: must be alphanumeric/hyphens/underscores + .md".to_string());
    }
    Ok(())
}

/// Read a prompt file, returning its contents or None if not found.
/// Name must be alphanumeric + hyphens + .md only (no path traversal).
#[command]
pub fn read_prompt_file(name: String) -> Result<Option<String>, String> {
    validate_prompt_name(&name)?;
    let path = prompts_dir()?.join(&name);
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {name}: {e}"))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

/// Write (save) a prompt file. Name validation: alphanumeric + hyphens + .md only.
#[command]
pub fn write_prompt_file(name: String, content: String) -> Result<(), String> {
    validate_prompt_name(&name)?;
    let dir = prompts_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create prompts dir: {e}"))?;
    }
    let path = dir.join(&name);
    fs::write(&path, content).map_err(|e| format!("Failed to write {name}: {e}"))
}

fn recent_dirs_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("racemo")
        .join("recent_dirs.json")
}

const MAX_RECENT_DIRS: usize = 10;

#[command]
pub fn get_recent_dirs() -> Vec<String> {
    let path = recent_dirs_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
            return list;
        }
    }
    vec![]
}

#[command]
pub fn add_recent_dir(path: String) -> Result<(), String> {
    let dir = path.trim().to_string();
    if dir.is_empty() {
        return Err("Empty path".to_string());
    }
    let mut list = get_recent_dirs();
    list.retain(|d| !d.eq_ignore_ascii_case(&dir));
    list.insert(0, dir);
    list.truncate(MAX_RECENT_DIRS);
    let json_path = recent_dirs_path();
    if let Some(parent) = json_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(&json_path, content).map_err(|e| e.to_string())
}

#[command]
pub fn delete_recent_dir(path: String) -> Result<(), String> {
    let dir = path.trim().to_string();
    if dir.is_empty() {
        return Err("Empty path".to_string());
    }
    let mut list = get_recent_dirs();
    list.retain(|d| !d.eq_ignore_ascii_case(&dir));
    let json_path = recent_dirs_path();
    if let Some(parent) = json_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(&json_path, content).map_err(|e| e.to_string())
}

/// Check if the IPC client is connected to the server.
#[command]
pub async fn is_ipc_ready(state: State<'_, IpcState>) -> Result<bool, String> {
    let guard = state.lock().await;
    Ok(guard.is_some())
}

/// 업데이트 설치 전에 racemo-server 프로세스를 종료.
/// 실행 중인 바이너리는 교체할 수 없으므로 설치 직전에 호출해야 한다.
///
/// 1) IPC Shutdown 메시지 전송 (graceful)
/// 2) SERVER_CHILD 핸들이 있으면 kill (spawn한 경우)
/// 3) Windows: taskkill /F /IM 으로 잔존 프로세스 강제 종료
#[command]
pub async fn stop_server(state: State<'_, IpcState>) -> Result<(), String> {
    use crate::ipc::protocol::ClientMessage;

    // 1. IPC Shutdown (graceful) — 서버가 상태를 저장하고 종료
    {
        let guard = state.lock().await;
        if let Some(client) = guard.as_ref() {
            let _ = client.request(ClientMessage::Shutdown).await;
        }
    }
    // IPC 연결 정리
    *state.lock().await = None;

    // 2. SERVER_CHILD 핸들 kill (우리가 spawn한 경우)
    crate::ipc::client::kill_server();

    // 3. 잔존 프로세스 강제 종료 (이전 세션 등에서 남은 orphan 대비)
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "racemo-server.exe"])
            .silent()
            .output();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", "racemo-server"])
            .silent()
            .output();
    }

    // 프로세스 종료 대기
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    log::info!("stop_server: racemo-server stopped for update");
    Ok(())
}

/// Reconnect to the server by spawning it if needed and establishing a new IPC channel.
#[command]
pub async fn reconnect_ipc(
    app_handle: AppHandle,
    state: State<'_, IpcState>,
) -> Result<(), String> {
    log::info!("reconnect_ipc: starting reconnection...");
    let ipc_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        crate::ipc::client::setup_ipc(app_handle, ipc_state).await;
    });
    Ok(())
}

/// 허용된 AI CLI 도구 목록. 경로 구분자 포함 시 거부.
const ALLOWED_AI_COMMANDS: &[&str] = &[
    "claude", "gemini", "codex", "opencode", "aider", "copilot", "chatgpt", "ollama", "llm", "sgpt", "ai",
];

/// AI 명령어 allowlist 검증. 경로 구분자 포함 또는 allowlist 미포함 시 에러.
fn validate_ai_command(command: &str) -> Result<(), String> {
    if command.contains('/') || command.contains('\\') {
        return Err(format!("Command not allowed: '{command}'"));
    }
    let base = command
        .rsplit_once('.')
        .map(|(name, _ext)| name)
        .unwrap_or(command);
    if !ALLOWED_AI_COMMANDS.contains(&base) {
        return Err(format!("Command not allowed: '{command}'"));
    }
    Ok(())
}

fn spawn_error_message(command: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("'{}' is not installed. Please install it first and make sure it is available in your PATH.", command)
    } else {
        format!("Failed to spawn '{}': {}", command, e)
    }
}

/// macOS GUI 앱은 최소 PATH만 갖고 있으므로 사용자 로그인 쉘의 PATH를 한번만 resolve.
#[cfg(not(windows))]
fn cached_login_path() -> &'static str {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        match std::process::Command::new(&shell)
            .args(["-lc", "printenv PATH"])
            .output()
        {
            Ok(output) => {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if p.is_empty() {
                    log::warn!("Login shell returned empty PATH");
                }
                p
            }
            Err(e) => {
                log::warn!("Failed to resolve login PATH from {}: {}", shell, e);
                String::new()
            }
        }
    })
}

/// Windows GUI 앱은 로그인 쉘보다 제한된 PATH를 가질 수 있으므로
/// PowerShell에서 시스템 PATH를 한번만 resolve해서 캐시.
#[cfg(windows)]
fn cached_win_path() -> &'static str {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        match std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')"])
            .silent()
            .output()
        {
            Ok(output) => {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if p.is_empty() {
                    log::warn!("[PATH] PowerShell returned empty PATH");
                } else {
                    log::info!("[PATH] resolved Windows PATH ({} chars)", p.len());
                }
                p
            }
            Err(e) => {
                log::warn!("[PATH] Failed to resolve PATH from PowerShell: {}", e);
                String::new()
            }
        }
    })
}

/// Windows에서 .cmd shim의 실제 node.js 엔트리포인트를 추출.
/// npm global package의 .cmd 파일은 `node "path/to/script.js" %*` 패턴.
/// .exe는 그대로 반환, .cmd면 (node_path, script_path)를 반환.
#[cfg(windows)]
enum ResolvedCommand {
    /// 직접 실행 가능 (.exe 등)
    Direct(String),
    /// node.js 스크립트 (node 경로, node 플래그, 스크립트 경로)
    NodeScript(String, Vec<String>, String),
}

#[cfg(windows)]
fn resolve_win_command(command: &str) -> ResolvedCommand {
    let path_str = cached_win_path();
    let paths_raw = if path_str.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        path_str.to_string()
    };

    // 이미 확장자가 있으면 그대로
    if command.contains('.') {
        return ResolvedCommand::Direct(command.to_string());
    }

    // .exe 먼저 찾기
    for dir in paths_raw.split(';') {
        let exe = std::path::Path::new(dir).join(format!("{}.exe", command));
        if exe.exists() {
            log::info!("[PATH] resolved '{}' → '{}'", command, exe.display());
            return ResolvedCommand::Direct(exe.to_string_lossy().to_string());
        }
    }

    // .cmd 찾기 → node.js 엔트리포인트 추출
    for dir in paths_raw.split(';') {
        let cmd_path = std::path::Path::new(dir).join(format!("{}.cmd", command));
        if cmd_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&cmd_path) {
                // npm .cmd 패턴: "%_prog%" [flags] "%dp0%\node_modules\...\script.js" %*
                // "%dp0%\node_modules\" 를 포함하는 부분에서 스크립트 경로 추출
                if let Some(caps) = content.find("%dp0%\\node_modules\\") {
                    let after = &content[caps + 6..]; // skip "%dp0%\"
                    if let Some(end) = after.find('"') {
                        let rel_script = &after[..end];
                        let script = std::path::Path::new(dir).join(rel_script);
                        if script.exists() {
                            // .cmd에서 node에 전달하는 추가 플래그 추출 (예: --no-warnings=DEP0040)
                            let mut node_flags: Vec<String> = Vec::new();
                            // "%_prog%" <flags> "%dp0%\..." 사이의 플래그 추출
                            if let Some(prog_end) = content.find("%_prog%\"") {
                                let between = &content[prog_end + 9..caps];
                                for flag in between.split_whitespace() {
                                    let f = flag.trim_matches('"').to_string();
                                    if !f.is_empty() { node_flags.push(f); }
                                }
                            }
                            log::info!("[PATH] resolved '{}' → node {} '{}'", command,
                                node_flags.join(" "), script.display());
                            return ResolvedCommand::NodeScript(
                                "node".to_string(),
                                node_flags,
                                script.to_string_lossy().to_string(),
                            );
                        }
                    }
                }
            }
            // 파싱 실패하면 .cmd 경로 그대로 반환
            log::info!("[PATH] resolved '{}' → '{}' (cmd fallback)", command, cmd_path.display());
            return ResolvedCommand::Direct(cmd_path.to_string_lossy().to_string());
        }
    }

    ResolvedCommand::Direct(command.to_string())
}

/// Execute an AI CLI command with a prompt and return the output.
#[command]
pub async fn run_ai_command(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    use std::process::Command as StdCommand;

    validate_ai_command(&command)?;

    log::info!("[Tauri] run_ai_command: {} ({} args, cwd: {:?})", command, args.len(), cwd);

    #[cfg(windows)]
    let mut cmd = {
        let resolved = resolve_win_command(&command);
        let mut c = match &resolved {
            ResolvedCommand::NodeScript(node, flags, script) => {
                let mut c = StdCommand::new(node);
                c.args(flags).arg(script).args(&args).silent();
                c
            }
            ResolvedCommand::Direct(prog) => {
                let mut c = StdCommand::new(prog);
                c.args(&args).silent();
                c
            }
        };
        let wp = cached_win_path();
        if !wp.is_empty() {
            let merged = format!("{};{}", wp, std::env::var("PATH").unwrap_or_default());
            c.env("PATH", merged);
        }
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = StdCommand::new(&command);
        c.args(&args);
        let path = cached_login_path();
        if !path.is_empty() { c.env("PATH", path); }
        c
    };

    if let Some(dir) = cwd {
        cmd.current_dir(&dir);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute '{}': {}", command, e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Command failed: {}", stderr))
    }
}

/// Kill a running streaming process by channel_id.
#[command]
pub fn kill_streaming(channel_id: String) {
    super::streaming::kill(&channel_id);
}

/// Strip ANSI/VT escape sequences from a string.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    // CSI: skip until ASCII letter (command byte)
                    for nc in chars.by_ref() {
                        if nc.is_ascii_alphabetic() { break; }
                    }
                }
                Some(']') => {
                    // OSC: skip until BEL or ESC
                    for nc in chars.by_ref() {
                        if nc == '\x07' || nc == '\x1b' { break; }
                    }
                }
                _ => {} // other escapes: skip one char (already consumed)
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Check if a string is a complete JSON object (balanced braces).
fn json_is_complete(s: &str) -> bool {
    let s = s.trim();
    if !s.starts_with('{') {
        return true; // Not JSON — treat as a standalone line
    }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for c in s.chars() {
        if esc { esc = false; continue; }
        match c {
            '\\' if in_str => esc = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => depth -= 1,
            _ => {}
        }
    }
    depth <= 0
}

/// Execute any shell command and stream output line-by-line via Tauri events.
/// Uses a PTY so the child process sees a real terminal and flushes output immediately.
/// JSON lines split by PTY column wrapping are re-assembled transparently.
#[command]
pub async fn exec_streaming(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    channel_id: String,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::thread;
    use tokio::sync::mpsc;
    use tauri::Emitter;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    validate_ai_command(&program)?;

    #[derive(Clone, serde::Serialize)]
    struct LineEvent { line: String, is_err: bool }

    let pty_system = native_pty_system();
    // Large column width minimises PTY wrapping; JSON reassembly handles the rest.
    let size = PtySize { rows: 24, cols: 4096, pixel_width: 0, pixel_height: 0 };
    let pair = pty_system.openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.env("NO_COLOR", "1");
    cmd.env("FORCE_COLOR", "0");
    cmd.env("TERM", "dumb");
    #[cfg(windows)]
    {
        let wp = cached_win_path();
        if !wp.is_empty() {
            let merged = format!("{};{}", wp, std::env::var("PATH").unwrap_or_default());
            cmd.env("PATH", merged);
        }
    }
    #[cfg(not(windows))]
    {
        let path = cached_login_path();
        if !path.is_empty() {
            cmd.env("PATH", path);
        }
    }
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd)
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("No such file or directory") || msg.contains("not found") {
                format!("'{}' is not installed. Please install it first and make sure it is available in your PATH.", program)
            } else {
                format!("spawn failed: {e}")
            }
        })?;
    let pid = child.process_id().unwrap_or(0);
    super::streaming::register(&channel_id, pid);

    // Clone reader BEFORE moving master; reader is independent of master's lifetime.
    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("PTY reader failed: {e}"))?;
    let master = pair.master;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel::<()>();

    // Reader thread: strip ANSI and re-assemble JSON lines split by PTY wrapping.
    // Detects Claude's {"type":"result",...} line as a session-end signal.
    {
        let tx = tx;
        thread::spawn(move || {
            let mut partial = String::new();
            for raw in BufReader::new(reader).lines().map_while(Result::ok) {
                let line = strip_ansi(&raw);
                let assembled = if !partial.is_empty() {
                    partial.push_str(&line);
                    if json_is_complete(&partial) {
                        let complete = partial.clone();
                        partial.clear();
                        Some(complete)
                    } else {
                        None
                    }
                } else if line.trim_start().starts_with('{') {
                    if json_is_complete(&line) {
                        Some(line)
                    } else {
                        partial = line;
                        None
                    }
                } else {
                    let t = line.trim().to_string();
                    if t.is_empty() { None } else { Some(t) }
                };

                if let Some(l) = assembled {
                    let is_result = l.contains("\"type\":\"result\"");
                    let _ = tx.send(l);
                    if is_result {
                        break; // No more meaningful output after Claude's result event
                    }
                }
            }
            if !partial.is_empty() { let _ = tx.send(partial); }
            let _ = done_tx.send(());
        });
    }

    // Wait for child to exit and close master so the reader thread can finish.
    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
        drop(master);
    });

    let event_name = format!("exec-out-{}", channel_id);
    loop {
        tokio::select! {
            biased;
            // Always drain lines first
            line = rx.recv() => {
                match line {
                    Some(l) => { let _ = app.emit(&event_name, LineEvent { line: l, is_err: false }); }
                    None => break, // reader thread ended naturally
                }
            }
            // Child has exited: give reader 300 ms to flush remaining output, then stop
            _ = &mut done_rx => {
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                while let Ok(l) = rx.try_recv() {
                    let _ = app.emit(&event_name, LineEvent { line: l, is_err: false });
                }
                break;
            }
        }
    }
    super::streaming::unregister(&channel_id);
    Ok(())
}

/// Execute an AI CLI command and stream output line-by-line via Tauri events.
/// Returns the full stdout on success, or an error string on failure.
#[command]
pub async fn run_ai_streaming(
    app: tauri::AppHandle,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    channel_id: String,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use std::thread;
    use tokio::sync::mpsc;
    use tauri::Emitter;

    validate_ai_command(&command)?;

    log::info!("[Tauri] run_ai_streaming: {} ({} args)", command, args.len());

    #[derive(Clone, serde::Serialize)]
    struct LineEvent { line: String, is_err: bool }

    #[cfg(windows)]
    let mut child = {
        let resolved = resolve_win_command(&command);
        let mut c = match &resolved {
            ResolvedCommand::NodeScript(node, flags, script) => {
                let mut c = std::process::Command::new(node);
                c.args(flags).arg(script).args(&args).silent();
                c
            }
            ResolvedCommand::Direct(prog) => {
                let mut c = std::process::Command::new(prog);
                c.args(&args).silent();
                c
            }
        };
        c.stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(ref dir) = cwd { c.current_dir(dir); }
        let wp = cached_win_path();
        if !wp.is_empty() {
            let merged = format!("{};{}", wp, std::env::var("PATH").unwrap_or_default());
            c.env("PATH", merged);
        }
        c.spawn().map_err(|e| spawn_error_message(&command, e))?
    };

    #[cfg(not(windows))]
    let mut child = {
        let mut c = std::process::Command::new(&command);
        c.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(ref dir) = cwd { c.current_dir(dir); }
        let path = cached_login_path();
        if !path.is_empty() { c.env("PATH", path); }
        c.spawn().map_err(|e| spawn_error_message(&command, e))?
    };

    super::streaming::register(&channel_id, child.id());
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

    let event_name = format!("ai-out-{}", channel_id);
    let mut stdout_lines: Vec<String> = Vec::new();
    while let Some((line, is_err)) = rx.recv().await {
        if !is_err {
            stdout_lines.push(line.clone());
        }
        let _ = app.emit(&event_name, LineEvent { line, is_err });
    }

    super::streaming::unregister(&channel_id);
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(stdout_lines.join("\n"))
    } else {
        Err(format!("Command '{}' exited with status: {}", command, status))
    }
}

/// Get the default shell log file path.
fn get_shell_log_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|dir| dir.join("racemo").join("shell.log"))
}

/// Get the shell log file path as a string.
#[command]
pub fn get_shell_log_path_string() -> Result<String, String> {
    get_shell_log_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine data directory".to_string())
}

/// Append shell output data to the log file.
#[command]
pub fn append_shell_log(data: String) -> Result<(), String> {
    let path = get_shell_log_path()
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create log directory: {e}"))?;
    }

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open log file: {e}"))?;

    file.write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to log file: {e}"))?;
    file.flush().map_err(|e| format!("Failed to flush log file: {e}"))?;
    Ok(())
}

/// Clear the shell log file.
#[command]
pub fn clear_shell_log() -> Result<(), String> {
    if let Some(path) = get_shell_log_path() {
        if path.exists() {
            fs::write(&path, "").map_err(|e| format!("Failed to clear shell log: {e}"))?;
        }
    }
    if let Some(hex_path) = get_shell_log_path().map(|p| p.with_extension("hex")) {
        if hex_path.exists() {
            fs::write(&hex_path, "").map_err(|e| format!("Failed to clear hex log: {e}"))?;
        }
    }
    Ok(())
}

/// Append shell output data to the hex log file in hex dump format.
#[command]
pub fn append_shell_log_hex(data: String) -> Result<(), String> {
    let path = get_shell_log_path()
        .map(|p| p.with_extension("hex"))
        .ok_or_else(|| "Cannot determine data directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create log directory: {e}"))?;
    }

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open hex log file: {e}"))?;

    let bytes = data.as_bytes();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    writeln!(file, "[{}] {} bytes", timestamp, bytes.len())
        .map_err(|e| format!("Failed to write to hex log: {e}"))?;

    for (i, chunk) in bytes.chunks(16).enumerate() {
        let offset = i * 16;
        let hex_part: String = chunk.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
        let ascii_part: String = chunk.iter().map(|&b| if (0x20..=0x7E).contains(&b) { b as char } else { '.' }).collect();
        writeln!(file, "  {:08X}  {:<48}  {}", offset, hex_part, ascii_part)
            .map_err(|e| format!("Failed to write hex dump line: {e}"))?;
    }

    writeln!(file).map_err(|e| format!("Failed to write separator: {e}"))?;
    file.flush().map_err(|e| format!("Failed to flush hex log file: {e}"))?;
    Ok(())
}


/// Open a file with the system default application.
#[command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to open: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to open: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to open: {e}"))?;
    }
    Ok(())
}

/// Reveal a file in the system file manager (Explorer/Finder).
#[command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let normalized = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .args(["/select,", &normalized])
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new(&path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .silent()
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }
    Ok(())
}

/// Create an empty file. Errors if the path already exists.
#[command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("Already exists: {path}"));
    }
    fs::File::create(p).map_err(|e| format!("Failed to create file: {e}"))?;
    Ok(())
}

/// Create a directory. Errors if the path already exists.
#[command]
pub fn create_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("Already exists: {path}"));
    }
    fs::create_dir(p).map_err(|e| format!("Failed to create directory: {e}"))?;
    Ok(())
}

/// Rename/move a path. Errors if the target already exists.
#[command]
pub fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let target = Path::new(&new_path);
    if target.exists() {
        return Err(format!("Target already exists: {new_path}"));
    }
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {e}"))?;
    Ok(())
}

/// Move a path to the system trash. Errors if the path does not exist.
#[command]
pub fn trash_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    trash::delete(p).map_err(|e| format!("Failed to move to trash: {e}"))?;
    Ok(())
}

/// Update the set of watched directories and editor file for fs change notifications.
#[tauri::command]
pub async fn update_watched_paths(
    dirs: Vec<String>,
    editor_file: Option<String>,
    state: tauri::State<'_, IpcState>,
) -> Result<(), String> {
    let client = super::ipc(&state).await?;
    client
        .send(ClientMessage::UpdateWatchedPaths {
            dirs,
            editor_file,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_dir() -> TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("file.txt"), b"hello").unwrap();
        fs::write(dir.path().join(".hidden"), b"").unwrap();
        dir
    }

    #[test]
    fn list_directory_dirs_before_files() {
        let dir = setup_dir();
        let entries = list_directory(dir.path().to_str().unwrap().to_string()).unwrap();
        assert!(!entries.is_empty());
        // First entry should be the directory
        assert_eq!(entries[0].entry_type, "dir");
        assert_eq!(entries[0].name, "subdir");
        // Files follow, sorted alphabetically (dotfiles included)
        let file_entries: Vec<_> = entries.iter().filter(|e| e.entry_type == "file").collect();
        assert!(file_entries.iter().any(|e| e.name == ".hidden"));
        assert!(file_entries.iter().any(|e| e.name == "file.txt"));
    }

    #[test]
    fn list_directory_shows_dotfiles() {
        let dir = setup_dir();
        let entries = list_directory(dir.path().to_str().unwrap().to_string()).unwrap();
        assert!(entries.iter().any(|e| e.name == ".hidden"), "dotfiles should be visible");
    }

    #[test]
    fn list_directory_not_a_dir_returns_err() {
        let dir = setup_dir();
        let file = dir.path().join("file.txt");
        let err = list_directory(file.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("Not a directory"), "unexpected error: {err}");
    }

    #[test]
    fn list_directory_nonexistent_returns_err() {
        let err = list_directory("/nonexistent/path/xyz".to_string()).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn list_directory_filtered_empty_partial_returns_non_hidden() {
        let dir = setup_dir();
        let entries = list_directory_filtered(
            dir.path().to_str().unwrap().to_string(),
            String::new(),
        )
        .unwrap();
        assert!(!entries.iter().any(|e| e.name.starts_with('.')));
        assert!(entries.iter().any(|e| e.name == "subdir"));
        assert!(entries.iter().any(|e| e.name == "file.txt"));
    }

    #[test]
    fn list_directory_filtered_dot_prefix_includes_dotfiles() {
        let dir = setup_dir();
        let entries = list_directory_filtered(
            dir.path().to_str().unwrap().to_string(),
            ".".to_string(),
        )
        .unwrap();
        assert!(entries.iter().any(|e| e.name == ".hidden"), "should include .hidden");
    }

    #[test]
    fn list_directory_filtered_prefix_filters_results() {
        let dir = setup_dir();
        let entries = list_directory_filtered(
            dir.path().to_str().unwrap().to_string(),
            "file".to_string(),
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file.txt");
    }

    #[test]
    fn list_directory_filtered_dirs_first() {
        let dir = setup_dir();
        let entries = list_directory_filtered(
            dir.path().to_str().unwrap().to_string(),
            String::new(),
        )
        .unwrap();
        // subdir should come before file.txt
        let subdir_pos = entries.iter().position(|e| e.name == "subdir").unwrap();
        let file_pos = entries.iter().position(|e| e.name == "file.txt").unwrap();
        assert!(subdir_pos < file_pos);
    }

    #[test]
    fn create_file_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.txt");
        create_file(path.to_str().unwrap().to_string()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn create_file_already_exists() {
        let dir = setup_dir();
        let path = dir.path().join("file.txt");
        let err = create_file(path.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("Already exists"), "unexpected error: {err}");
    }

    #[test]
    fn create_directory_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("newdir");
        create_directory(path.to_str().unwrap().to_string()).unwrap();
        assert!(path.is_dir());
    }

    #[test]
    fn create_directory_already_exists() {
        let dir = setup_dir();
        let path = dir.path().join("subdir");
        let err = create_directory(path.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("Already exists"), "unexpected error: {err}");
    }

    #[test]
    fn rename_path_success() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.txt");
        fs::write(&old, b"data").unwrap();
        let new = dir.path().join("new.txt");
        rename_path(
            old.to_str().unwrap().to_string(),
            new.to_str().unwrap().to_string(),
        )
        .unwrap();
        assert!(!old.exists());
        assert!(new.exists());
    }

    #[test]
    fn rename_path_target_exists() {
        let dir = setup_dir();
        let old = dir.path().join("file.txt");
        let new_path = dir.path().join("subdir");
        let err = rename_path(
            old.to_str().unwrap().to_string(),
            new_path.to_str().unwrap().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("Target already exists"), "unexpected error: {err}");
    }

    #[test]
    fn trash_path_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("to_trash.txt");
        fs::write(&path, b"bye").unwrap();
        trash_path(path.to_str().unwrap().to_string()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn read_text_file_success() {
        let dir = setup_dir();
        let path = dir.path().join("file.txt");
        let content = read_text_file(path.to_str().unwrap().to_string()).unwrap();
        assert_eq!(content, "hello");
    }

    #[test]
    fn read_text_file_not_found() {
        let err = read_text_file("/nonexistent/file.txt".to_string()).unwrap_err();
        assert!(err.contains("File not found"), "unexpected error: {err}");
    }

    #[test]
    fn read_text_file_is_dir() {
        let dir = setup_dir();
        let path = dir.path().join("subdir");
        let err = read_text_file(path.to_str().unwrap().to_string()).unwrap_err();
        assert!(err.contains("Not a file"), "unexpected error: {err}");
    }

    #[test]
    fn write_text_file_create_and_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.txt");
        write_text_file(path.to_str().unwrap().to_string(), "first".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        write_text_file(path.to_str().unwrap().to_string(), "second".to_string()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn write_text_file_no_parent() {
        let err = write_text_file("/nonexistent/dir/file.txt".to_string(), "x".to_string()).unwrap_err();
        assert!(err.contains("Parent directory does not exist"), "unexpected error: {err}");
    }

    #[test]
    fn read_text_file_traversal_blocked() {
        let err = read_text_file("/tmp/../etc/passwd".to_string()).unwrap_err();
        assert!(err.contains("Path traversal not allowed"), "unexpected error: {err}");
    }

    #[test]
    fn write_text_file_traversal_blocked() {
        let err = write_text_file("/tmp/../etc/evil".to_string(), "x".to_string()).unwrap_err();
        assert!(err.contains("Path traversal not allowed"), "unexpected error: {err}");
    }
}

/// Recursively list document files (.md, .txt, .pdf) under a directory.
#[command]
pub fn list_docs_recursive(path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    // Refuse to scan root-level paths (e.g. "/" or "/Users") to avoid full filesystem traversal
    let depth = root.components().count();
    if depth < 3 {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    collect_docs(root, &mut results, 0);
    results.sort_by_key(|a| a.to_lowercase());
    Ok(results)
}

const MAX_DOCS_DEPTH: u32 = 5;

fn collect_docs(dir: &Path, results: &mut Vec<String>, depth: u32) {
    if depth >= MAX_DOCS_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            // Skip build/cache dirs only
            if matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git" | ".next" | "__pycache__") {
                continue;
            }
            collect_docs(&path, results, depth + 1);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            match ext.to_lowercase().as_str() {
                "md" | "txt" | "pdf" => {
                    results.push(path.to_string_lossy().to_string());
                }
                _ => {}
            }
        }
    }
}

/// Verify that a path does not contain traversal components (.. segments).
fn reject_traversal(path: &Path) -> Result<(), String> {
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(format!("Path traversal not allowed: {}", path.display()));
        }
    }
    Ok(())
}

/// Read a text file and return its contents as a string.
#[command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    reject_traversal(p)?;
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    if !p.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    fs::read_to_string(p).map_err(|e| format!("Failed to read file: {e}"))
}

// ── File search ───────────────────────────────────────────────────────────────

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", ".next", "__pycache__",
    ".venv", "venv", "build", ".cache", "vendor", ".svn", ".hg", ".idea",
    ".turbo", ".vercel", "out", "coverage",
];
const MAX_FILE_RESULTS: usize = 500;
const MAX_CONTENT_RESULTS: usize = 2000;
const MAX_FILE_SIZE: u64 = 2_000_000; // 2MB
const FILE_BATCH_SIZE: usize = 20;
const CONTENT_BATCH_SIZE: usize = 50;

#[derive(Debug, Serialize, Clone)]
pub struct FileMatch {
    pub path: String,
    pub relative: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContentMatch {
    pub path: String,
    pub relative: String,
    pub name: String,
    #[serde(rename = "lineNumber")]
    pub line_number: usize,
    #[serde(rename = "lineText")]
    pub line_text: String,
}

const TEXT_EXTENSIONS: &[&str] = &[
    // code
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "go", "java", "kt", "swift", "c", "cpp", "h", "hpp",
    "cs", "rb", "php", "lua", "r", "scala", "ex", "exs",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    // web
    "html", "htm", "css", "scss", "sass", "less", "svelte", "vue",
    // data / config
    "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "env",
    "xml", "xsd", "plist", "graphql", "gql", "proto",
    // docs
    "md", "mdx", "txt", "rst", "adoc", "tex",
    // misc text
    "sql", "csv", "tsv", "log", "diff", "patch",
    "gitignore", "gitattributes", "editorconfig", "prettierrc", "eslintrc",
    "dockerfile", "makefile", "gemfile", "rakefile",
    "lock",
];

fn is_likely_text(path: &Path) -> bool {
    use std::io::Read;
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_FILE_SIZE { return false; }
    }
    // Extension whitelist: fast path
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        if TEXT_EXTENSIONS.contains(&ext_lower.as_str()) { return true; }
        // Known binary extensions: fast reject
        const BINARY_EXTENSIONS: &[&str] = &[
            "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg",
            "mp3", "mp4", "wav", "ogg", "flac", "aac", "mov", "avi", "mkv",
            "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
            "exe", "dll", "so", "dylib", "bin", "obj", "lib", "a",
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "wasm", "ttf", "otf", "woff", "woff2", "eot",
            "sqlite", "db", "rdb",
            "class", "jar", "pyc", "pyo",
        ];
        if BINARY_EXTENSIONS.contains(&ext_lower.as_str()) { return false; }
    }
    // No extension or unknown: fall back to null-byte heuristic
    let mut buf = [0u8; 512];
    if let Ok(mut f) = fs::File::open(path) {
        if let Ok(n) = f.read(&mut buf) {
            return n == 0 || !buf[..n].contains(&0u8);
        }
    }
    false
}

// ── Ignore rule engine (.gitignore / .p4ignore) ───────────────────────────────

#[derive(Clone)]
struct IgnoreRule {
    pattern: String,
    dir_only: bool,
    anchored: bool,
    negated: bool,
    base_dir: std::path::PathBuf,
}

fn parse_ignore_file(path: &Path) -> Vec<IgnoreRule> {
    let base_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let content = match fs::read_to_string(path) { Ok(c) => c, Err(_) => return vec![] };
    let mut rules = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let negated = line.starts_with('!');
        let pat = if negated { &line[1..] } else { line };
        let dir_only = pat.ends_with('/');
        let pat = pat.trim_end_matches('/');
        let anchored = pat.contains('/');
        let pat = pat.trim_start_matches('/');
        if pat.is_empty() { continue; }
        rules.push(IgnoreRule {
            pattern: pat.to_string(),
            dir_only,
            anchored,
            negated,
            base_dir: base_dir.clone(),
        });
    }
    rules
}

fn load_ignore_rules(dir: &Path) -> Vec<IgnoreRule> {
    let mut rules = Vec::new();
    for name in &[".gitignore", ".p4ignore"] {
        let path = dir.join(name);
        if path.is_file() {
            rules.extend(parse_ignore_file(&path));
        }
    }
    rules
}

/// Simple glob matcher: `*` = any chars except `/`, `**` = any chars, `?` = any single non-`/` char.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (None, _) => false,
        (Some(b'*'), _) => {
            if pattern.get(1) == Some(&b'*') {
                // `**` matches everything including `/`
                let rest = &pattern[2..];
                let rest = rest.strip_prefix(b"/").unwrap_or(rest);
                for i in 0..=text.len() {
                    if glob_match(rest, &text[i..]) { return true; }
                }
                false
            } else {
                // `*` matches anything except `/`
                let rest = &pattern[1..];
                for i in 0..=text.len() {
                    if glob_match(rest, &text[i..]) { return true; }
                    if i < text.len() && text[i] == b'/' { break; }
                }
                false
            }
        }
        (Some(b'?'), Some(&c)) if c != b'/' => glob_match(&pattern[1..], &text[1..]),
        (Some(b'?'), _) => false,
        (Some(&pc), Some(&tc)) if pc == tc => glob_match(&pattern[1..], &text[1..]),
        _ => false,
    }
}

fn is_ignored(rules: &[IgnoreRule], path: &Path, is_dir: bool) -> bool {
    let basename = path.file_name().unwrap_or_default().to_string_lossy();
    let mut result = false;
    for rule in rules {
        if rule.dir_only && !is_dir { continue; }
        let rel = match path.strip_prefix(&rule.base_dir) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let matched = if rule.anchored {
            glob_match(rule.pattern.as_bytes(), rel.as_bytes())
        } else {
            glob_match(rule.pattern.as_bytes(), basename.as_bytes())
                || rel.split('/').any(|seg| glob_match(rule.pattern.as_bytes(), seg.as_bytes()))
        };
        if matched { result = !rule.negated; }
    }
    result
}

#[allow(clippy::too_many_arguments)] // recursive walker threading shared state through call stack
fn walk_files(
    dir: &Path, root: &Path, query_lower: &str,
    batch: &mut Vec<FileMatch>, total: &mut usize, depth: u32,
    parent_rules: &[IgnoreRule],
    tx: &std::sync::mpsc::SyncSender<Vec<FileMatch>>,
    app: &tauri::AppHandle, dir_event: &str,
) {
    use tauri::Emitter;
    if depth > 12 || *total >= MAX_FILE_RESULTS { return; }
    let _ = app.emit(dir_event, dir.to_string_lossy().replace('\\', "/"));
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };

    let local = load_ignore_rules(dir);
    let all_rules: Vec<IgnoreRule> = parent_rules.iter().cloned().chain(local).collect();

    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            let skip = SKIP_DIRS.contains(&name.as_str())
                || (name.starts_with('.') && name != ".github");
            if skip { continue; }
            if is_ignored(&all_rules, &path, true) { continue; }
            subdirs.push(path);
        } else {
            if *total >= MAX_FILE_RESULTS { return; }
            if is_ignored(&all_rules, &path, false) { continue; }
            if name.to_lowercase().contains(query_lower) {
                let relative = path.strip_prefix(root)
                    .unwrap_or(&path).to_string_lossy().replace('\\', "/");
                batch.push(FileMatch { path: path.to_string_lossy().to_string(), relative, name });
                *total += 1;
                if batch.len() >= FILE_BATCH_SIZE {
                    let _ = tx.send(std::mem::take(batch));
                }
            }
        }
    }
    for sub in subdirs {
        if *total >= MAX_FILE_RESULTS { return; }
        walk_files(&sub, root, query_lower, batch, total, depth + 1, &all_rules, tx, app, dir_event);
    }
}

#[allow(clippy::too_many_arguments)] // recursive walker threading shared state through call stack
fn walk_content(
    dir: &Path, root: &Path, query: &str, case_sensitive: bool,
    batch: &mut Vec<ContentMatch>, total: &mut usize, depth: u32,
    parent_rules: &[IgnoreRule],
    tx: &std::sync::mpsc::SyncSender<Vec<ContentMatch>>,
    app: &tauri::AppHandle, dir_event: &str,
) {
    use tauri::Emitter;
    if depth > 12 || *total >= MAX_CONTENT_RESULTS { return; }
    let _ = app.emit(dir_event, dir.to_string_lossy().replace('\\', "/"));
    let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    let query_lower = query.to_lowercase();

    let local = load_ignore_rules(dir);
    let all_rules: Vec<IgnoreRule> = parent_rules.iter().cloned().chain(local).collect();

    let mut subdirs = Vec::new();
    let mut file_paths = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            let skip = SKIP_DIRS.contains(&name.as_str())
                || (name.starts_with('.') && name != ".github");
            if skip { continue; }
            if is_ignored(&all_rules, &path, true) { continue; }
            subdirs.push(path);
        } else if !is_ignored(&all_rules, &path, false) {
            file_paths.push(path);
        }
    }

    for file_path in file_paths {
        if *total >= MAX_CONTENT_RESULTS { return; }
        if !is_likely_text(&file_path) { continue; }
        let content = match fs::read_to_string(&file_path) { Ok(c) => c, Err(_) => continue };
        let name = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let relative = file_path.strip_prefix(root)
            .unwrap_or(&file_path).to_string_lossy().replace('\\', "/");
        let path_str = file_path.to_string_lossy().to_string();
        for (i, line) in content.lines().enumerate() {
            if *total >= MAX_CONTENT_RESULTS { break; }
            let hit = if case_sensitive { line.contains(query) }
                else { line.to_lowercase().contains(&query_lower) };
            if hit {
                batch.push(ContentMatch {
                    path: path_str.clone(), relative: relative.clone(), name: name.clone(),
                    line_number: i + 1, line_text: line.trim_end().to_string(),
                });
                *total += 1;
                if batch.len() >= CONTENT_BATCH_SIZE {
                    let _ = tx.send(std::mem::take(batch));
                }
            }
        }
    }
    for sub in subdirs {
        if *total >= MAX_CONTENT_RESULTS { return; }
        walk_content(&sub, root, query, case_sensitive, batch, total, depth + 1, &all_rules, tx, app, dir_event);
    }
}

#[command]
pub async fn search_files(
    app: tauri::AppHandle,
    root: String, query: String, channel_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    eprintln!("[search_files] root={root:?} query={query:?} channel_id={channel_id:?}");
    let batch_event = format!("search-batch-{channel_id}");
    let done_event  = format!("search-done-{channel_id}");
    let dir_event   = format!("search-dir-{channel_id}");
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<FileMatch>>(32);
    let root_clone = root.clone();
    let query_clone = query.clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let root_path = std::path::PathBuf::from(&root_clone);
        let is_dir = root_path.is_dir();
        if is_dir && !query_clone.trim().is_empty() {
            let initial_rules = load_ignore_rules(&root_path);
            let mut batch = Vec::new();
            let mut total = 0usize;
            walk_files(&root_path, &root_path, &query_clone.to_lowercase(), &mut batch, &mut total, 0, &initial_rules, &tx, &app_clone, &dir_event);
            if !batch.is_empty() { let _ = tx.send(batch); }
        }
    });
    for batch in rx { let _ = app.emit(&batch_event, batch); }
    let _ = app.emit(&done_event, ());
    Ok(())
}

#[command]
pub async fn search_content(
    app: tauri::AppHandle,
    root: String, query: String, case_sensitive: bool, channel_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let batch_event = format!("search-batch-{channel_id}");
    let done_event  = format!("search-done-{channel_id}");
    let dir_event   = format!("search-dir-{channel_id}");
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<ContentMatch>>(32);
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let root_path = std::path::PathBuf::from(&root);
        if root_path.is_dir() && !query.trim().is_empty() {
            let initial_rules = load_ignore_rules(&root_path);
            let mut batch = Vec::new();
            let mut total = 0usize;
            walk_content(&root_path, &root_path, &query, case_sensitive, &mut batch, &mut total, 0, &initial_rules, &tx, &app_clone, &dir_event);
            if !batch.is_empty() { let _ = tx.send(batch); }
        }
    });
    for batch in rx { let _ = app.emit(&batch_event, batch); }
    let _ = app.emit(&done_event, ());
    Ok(())
}

/// Write text content to a file (creates or overwrites).
#[command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    reject_traversal(p)?;
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err(format!("Parent directory does not exist: {}", parent.display()));
        }
    }
    fs::write(p, content).map_err(|e| format!("Failed to write file: {e}"))
}

#[command]
pub fn save_clipboard_image(app: AppHandle, data: Vec<u8>, width: u32, height: u32) -> Result<String, String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let images_dir = cache_dir.join("images");
    fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let filename = format!("{}.png", uuid::Uuid::new_v4());
    let path = images_dir.join(&filename);

    let img = image::RgbaImage::from_raw(width, height, data)
        .ok_or_else(|| "RGBA data size does not match width × height × 4".to_string())?;
    img.save(&path).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[command]
pub fn set_block_hangul_key(enabled: bool) {
    crate::keyboard_hook::set_block_hangul(enabled);
}

#[command]
pub fn load_diff_cache(path: String) -> Result<String, String> {
    let cache_path = std::path::PathBuf::from(&path)
        .join(".racemo")
        .join("cache")
        .join("diff-collapsed.json");
    if cache_path.exists() {
        fs::read_to_string(&cache_path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[command]
pub fn save_diff_cache(path: String, data: String) -> Result<(), String> {
    let cache_dir = std::path::PathBuf::from(&path)
        .join(".racemo")
        .join("cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    fs::write(cache_dir.join("diff-collapsed.json"), data).map_err(|e| e.to_string())
}

#[command]
pub fn load_discard_cache(path: String) -> Result<String, String> {
    let cache_path = std::path::PathBuf::from(&path)
        .join(".racemo")
        .join("cache")
        .join("diff-discarded.json");
    if cache_path.exists() {
        fs::read_to_string(&cache_path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

#[command]
pub fn save_discard_cache(path: String, data: String) -> Result<(), String> {
    let cache_dir = std::path::PathBuf::from(&path)
        .join(".racemo")
        .join("cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    fs::write(cache_dir.join("diff-discarded.json"), data).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ClaudeUsagePeriod {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ClaudeUsageResult {
    pub five_hour: Option<ClaudeUsagePeriod>,
    pub seven_day: Option<ClaudeUsagePeriod>,
    pub seven_day_sonnet: Option<ClaudeUsagePeriod>,
}

/// Fetch Claude Code usage from Anthropic OAuth API.
/// Reads the access token from ~/.claude/.credentials.json.
#[command]
pub async fn get_claude_usage() -> Result<ClaudeUsageResult, String> {
    // Read credentials
    let home = resolve_home()?;
    let creds_path = std::path::Path::new(&home)
        .join(".claude")
        .join(".credentials.json");
    let creds_raw = fs::read_to_string(&creds_path)
        .map_err(|e| format!("Cannot read credentials: {e}"))?;
    let creds: serde_json::Value = serde_json::from_str(&creds_raw)
        .map_err(|e| format!("Invalid credentials JSON: {e}"))?;
    let token = creds
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|v| v.as_str())
        .ok_or("No OAuth access token found in credentials")?
        .to_string();

    // Call Anthropic usage API
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API error {status}: {body}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    fn parse_period(v: &serde_json::Value) -> Option<ClaudeUsagePeriod> {
        Some(ClaudeUsagePeriod {
            utilization: v.get("utilization")?.as_f64()?,
            resets_at: v.get("resets_at")?.as_str()?.to_string(),
        })
    }

    Ok(ClaudeUsageResult {
        five_hour: body.get("five_hour").and_then(parse_period),
        seven_day: body.get("seven_day").and_then(parse_period),
        seven_day_sonnet: body.get("seven_day_sonnet").and_then(parse_period),
    })
}

// ── Editor panel state persistence ──────────────────────────────────────────

#[derive(Debug, Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SavedTab {
    Editor { path: String },
    Browser { url: String, name: String },
}

#[derive(Debug, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub panel_open: bool,
    pub active_index: usize,
    #[serde(default)]
    pub tabs: Vec<SavedTab>,
    // Legacy field for backward compat (read-only)
    #[serde(default)]
    pub paths: Vec<String>,
}

#[command]
pub fn get_editor_state(app: AppHandle) -> EditorState {
    let Ok(store) = app.store("editor-state.json") else {
        return EditorState::default();
    };
    let panel_open = store.get("panelOpen").and_then(|v| v.as_bool()).unwrap_or(false);
    let active_index = store.get("activeIndex")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    // Prefer new "tabs" format; fall back to legacy "paths" for old data
    let tabs: Vec<SavedTab> = store.get("tabs")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let paths: Vec<String> = if tabs.is_empty() {
        store.get("paths")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    EditorState { panel_open, active_index, tabs, paths }
}

#[command]
pub fn save_editor_state(
    app: AppHandle,
    panel_open: bool,
    active_index: usize,
    tabs: Vec<SavedTab>,
) -> Result<(), String> {
    let store = app.store("editor-state.json").map_err(|e| e.to_string())?;
    store.set("panelOpen", serde_json::json!(panel_open));
    store.set("activeIndex", serde_json::json!(active_index));
    store.set("tabs", serde_json::json!(tabs));
    // Remove legacy key
    store.delete("paths");
    store.delete("browserTabs");
    store.save().map_err(|e| e.to_string())
}

/// Get a browser webview by label, rejecting non-browser labels.
fn get_browser_webview(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    if !label.starts_with("bw") {
        return Err(format!("Invalid browser webview label: {label}"));
    }
    app.get_webview(label).ok_or_else(|| format!("Webview '{label}' not found"))
}

/// Navigate a webview to a new URL by label.
#[command]
pub fn webview_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!("Only http/https URLs allowed: {trimmed}"));
    }
    let parsed: tauri::Url = trimmed.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let wv = get_browser_webview(&app, &label)?;
    wv.navigate(parsed).map_err(|e| format!("navigate failed: {e}"))
}

/// Reload the current page in a webview.
#[command]
pub fn webview_reload(app: AppHandle, label: String) -> Result<(), String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.eval("window.location.reload()").map_err(|e| format!("eval failed: {e}"))
}

/// Navigate back in webview history.
#[command]
pub fn webview_go_back(app: AppHandle, label: String) -> Result<(), String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.eval("window.history.back()").map_err(|e| format!("eval failed: {e}"))
}

/// Navigate forward in webview history.
#[command]
pub fn webview_go_forward(app: AppHandle, label: String) -> Result<(), String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.eval("window.history.forward()").map_err(|e| format!("eval failed: {e}"))
}

/// Get the current URL of a webview.
#[command]
pub fn webview_get_url(app: AppHandle, label: String) -> Result<String, String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.url().map(|u| u.to_string()).map_err(|e| e.to_string())
}

/// Hide a browser webview (when modal overlays appear).
#[command]
pub fn webview_hide(app: AppHandle, label: String) -> Result<(), String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.hide().map_err(|e| e.to_string())
}

/// Show a browser webview (when modal overlay disappears).
#[command]
pub fn webview_show(app: AppHandle, label: String) -> Result<(), String> {
    let wv = get_browser_webview(&app, &label)?;
    wv.show().map_err(|e| e.to_string())
}

/// Toggle devtools for a webview.
#[command]
pub fn webview_toggle_devtools(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(feature = "devtools")]
    {
        let wv = get_browser_webview(&app, &label)?;
        if wv.is_devtools_open() {
            wv.close_devtools();
        } else {
            wv.open_devtools();
        }
    }
    #[cfg(not(feature = "devtools"))]
    {
        let _ = (&app, &label);
    }
    Ok(())
}

/// Linux AppImage updates fail with `Text file busy` if the active AppImage is overwritten directly.
/// Rename the running AppImage to `.bak` so the updater can write to the target path.
/// Also renames any versioned AppImage (e.g. Racemo_0.0.5_Linux_x64.AppImage) since the
/// updater will install to the normalized `Racemo.AppImage` name.
#[command]
pub fn prepare_update() -> Result<(), String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        let path = std::path::Path::new(&appimage);
        if path.exists() {
            let bak = path.with_extension("bak");
            if bak.exists() {
                let _ = std::fs::remove_file(&bak);
            }
            if let Err(e) = std::fs::rename(path, &bak) {
                log::warn!("prepare_update: Failed to rename AppImage: {}", e);
            } else {
                log::info!("prepare_update: {} → {}", path.display(), bak.display());
            }
        }
        // Also clear the normalized path if it differs from the running AppImage
        let dir = path.parent().unwrap_or(std::path::Path::new("."));
        let normalized = dir.join("Racemo.AppImage");
        if normalized != path && normalized.exists() {
            let bak2 = normalized.with_extension("bak");
            let _ = std::fs::remove_file(&bak2);
            let _ = std::fs::rename(&normalized, &bak2);
            log::info!("prepare_update: {} → {}", normalized.display(), bak2.display());
        }
    }
    Ok(())
}
