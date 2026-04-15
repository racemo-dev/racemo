use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
#[cfg(unix)]
use tokio::net::UnixListener;
#[cfg(windows)]
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::{broadcast, Mutex as TokioMutex};
use uuid::Uuid;

use crate::ipc::protocol::*;
use crate::ipc::conpty::{pack_pty_size, unpack_pty_size};
// Session에서 사용하는 레이아웃 타입 (crate::session 스코프)
use crate::session::Session;
use crate::persistence::{
    load_state, save_state, session_to_persisted, persisted_to_session, PersistedState,
};

/// 서버가 관리하는 실행 중인 PTY 핸들.
struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    /// 자식 프로세스 핸들. Windows에서는 child watcher 스레드가 소유하므로 None.
    #[cfg(not(windows))]
    _child: Box<dyn portable_pty::Child + Send + Sync>,
    /// PTY 출력 히스토리 (재연결 시 복원용, 최대 100KB)
    history: Arc<Mutex<Vec<u8>>>,
    /// 현재 PTY 크기 (rows << 16 | cols), 리더 스레드와 공유.
    pty_size: Arc<AtomicU32>,
}

/// 모든 세션과 PTY를 관리하는 서버 상태.
pub struct ServerState {
    pub sessions: Vec<Session>,
    ptys: HashMap<String, PtyHandle>,
    /// 연결된 모든 클라이언트에 ServerMessage를 브로드캐스트하는 채널.
    broadcast_tx: broadcast::Sender<ServerMessage>,
    /// PTY별 현재 작업 디렉토리. PTY 리더 스레드에서 OSC 7 파싱으로 갱신.
    cwd_map: Arc<Mutex<HashMap<String, String>>>,
    /// CWD가 변경되어 영속화가 필요함을 나타내는 플래그.
    cwd_dirty: Arc<AtomicBool>,
    /// 영속화를 위한 마지막 활성/생성 세션 ID.
    pub active_session_id: Option<String>,
    /// 복원 대기 중인 영속 세션 (지연 복원: 첫 ListSessions 시 PTY 생성).
    pending_sessions: Vec<crate::persistence::PersistedSession>,
    /// 파일 시스템 변경 감시기.
    file_watcher: Option<crate::ipc::file_watcher::FileWatcher>,
    /// 호스트 로컬 터미널이 요청한 PTY 사이즈 (pane_id → (rows, cols)).
    host_pty_sizes: HashMap<String, (u16, u16)>,
    /// 원격 클라이언트가 요청한 PTY 사이즈 (pane_id → (rows, cols)).
    remote_pty_sizes: HashMap<String, (u16, u16)>,
}

/// PowerShell OSC 133 쉘 통합 스크립트 (Windows 전용)
///
/// prompt() 함수: 133;A(프롬프트 시작) 전송 후 프롬프트 문자열 반환 끝에 133;B(입력 준비) 삽입
///   → xterm이 133;B 파싱 시 setPromptY() 호출 → IME가 쉘 모드 인식
///
/// Enter 핸들러: 133;C(명령 실행 시작) 전송 후 AcceptLine
///   → clearPromptY() 호출 → 앱 실행 중 IME는 앱 모드로 전환
#[cfg(windows)]
fn ps_osc133_script() -> &'static str {
    // 세미콜론으로 구분된 단일 라인 — PowerShell이 r\n 한 번에 실행
    // $e = ESC(0x1B), $st = '\' (0x5C) → $e+']133;A'+$e+$st = OSC 133;A ST
    // OSC 7: ESC ] 7 ; file://localhost/<path> BEL — CWD 변경 추적용
    "if(Test-Path $PROFILE){. $PROFILE};\
$e=[char]0x1b;$st=[char]0x5c;$bel=[char]0x07;\
function prompt{\
[Console]::Write($e+']133;A'+$e+$st);\
$p=$ExecutionContext.SessionState.Path.CurrentLocation.Path;\
$pu=$p.Replace('\\','/');\
[Console]::Write($e+']7;file://localhost/'+$pu+$bel);\
return 'PS '+$p+'> '+$e+']133;B'+$e+$st};\
Set-PSReadLineKeyHandler -Key Enter -ScriptBlock{\
[Console]::Write($e+']133;C'+$e+$st);\
[Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()}"
}

/// zsh용 OSC 133 shell integration.
/// ZDOTDIR을 임시 디렉토리로 변경하여 .zshenv에서 원본 환경 복원 + OSC 133 훅 등록.
#[cfg(not(windows))]
fn setup_zsh_osc133_zdotdir() -> Option<std::path::PathBuf> {
    use std::fs;
    let dir = std::env::temp_dir().join("racemo-zsh-osc133");
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("Failed to create zsh init dir: {e}");
        return None;
    }
    // .zshenv: 가장 먼저 로드됨. 원본 ZDOTDIR 복원 후 나머지 zsh 초기화가 원래대로 진행.
    // OSC 133 훅은 중복 방지를 위해 RACEMO_OSC133 플래그 체크.
    let zshenv = dir.join(".zshenv");
    let script = r#"# Racemo OSC 133 shell integration — auto-generated, do not edit
if [[ -n "$RACEMO_ORIG_ZDOTDIR" ]]; then
  ZDOTDIR="$RACEMO_ORIG_ZDOTDIR"
  unset RACEMO_ORIG_ZDOTDIR
else
  unset ZDOTDIR
fi
# Source original .zshenv if it exists
[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"

if [[ -z "$RACEMO_OSC133" ]]; then
  export RACEMO_OSC133=1
  __racemo_precmd() {
    local ec=$?
    printf '\e]133;D;%d\e\\' "$ec"
    printf '\e]133;A\e\\'
    printf '\e]7;file://%s%s\a' "${HOST:-$(hostname)}" "${PWD}"
  }
  __racemo_preexec() { printf '\e]133;C\e\\'; }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __racemo_precmd
  add-zsh-hook preexec __racemo_preexec
  PS1="${PS1}%{\e]133;B\e\\%}"
fi
"#;
    if let Err(e) = fs::write(&zshenv, script) {
        log::warn!("Failed to write zsh OSC 133 init: {e}");
        return None;
    }
    Some(dir)
}

/// bash용 OSC 133 shell integration.
/// --rcfile로 전달할 커스텀 rcfile을 생성. 원본 .bashrc를 source한 뒤 OSC 133 설정.
#[cfg(not(windows))]
fn setup_bash_osc133_rcfile() -> Option<std::path::PathBuf> {
    use std::fs;
    let dir = std::env::temp_dir().join("racemo-bash-osc133");
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("Failed to create bash init dir: {e}");
        return None;
    }
    let rcfile = dir.join(".bashrc");
    let script = r#"# Racemo OSC 133 shell integration — auto-generated, do not edit
# Source login files for full PATH (GUI 앱에서 실행 시 PATH 누락 방지)
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Source original .bashrc (if not already sourced by bash_profile)
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

if [ -z "$RACEMO_OSC133" ]; then
  export RACEMO_OSC133=1
  __racemo_prompt() {
    local ec=$?
    printf '\e]133;D;%d\e\\' "$ec"
    printf '\e]133;A\e\\'
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-$(hostname)}" "${PWD}"
  }
  PROMPT_COMMAND="__racemo_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS0=$'\e]133;C\e\\'
  PS1="${PS1}\[\e]133;B\e\\\]"
fi
"#;
    if let Err(e) = fs::write(&rcfile, script) {
        log::warn!("Failed to write bash OSC 133 init: {e}");
        return None;
    }
    Some(rcfile)
}

/// fish용 OSC 133 shell integration. --init-command로 전달할 스크립트 반환.
#[cfg(not(windows))]
fn fish_osc133_init_command() -> Option<String> {
    Some(concat!(
        "if not set -q RACEMO_OSC133; ",
        "set -gx RACEMO_OSC133 1; ",
        "function __racemo_postexec --on-event fish_postexec; ",
        "printf '\\e]133;D;%d\\e\\\\' $status; ",
        "end; ",
        "function __racemo_prompt --on-event fish_prompt; ",
        "printf '\\e]133;A\\e\\\\'; ",
        "printf '\\e]7;file://%s%s\\a' (hostname) (pwd); ",
        "end; ",
        "function __racemo_preexec --on-event fish_preexec; ",
        "printf '\\e]133;C\\e\\\\'; ",
        "end; ",
        "end",
    ).to_string())
}

impl ServerState {
    pub fn new(broadcast_tx: broadcast::Sender<ServerMessage>) -> Self {
        // fs-watcher → broadcast FsChange
        let (fs_tx, mut fs_rx) = broadcast::channel::<Vec<FsChangeEvent>>(16);
        let bc_tx = broadcast_tx.clone();
        std::thread::Builder::new()
            .name("fs-watcher-bridge".into())
            .spawn(move || {
                loop {
                    match fs_rx.blocking_recv() {
                        Ok(events) => { let _ = bc_tx.send(ServerMessage::FsChange { events }); }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[fs-watcher-bridge] lagged, skipped {n} events");
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            })
            .ok();

        // In dev mode (tauri dev), the file watcher's FSEvents conflicts with
        // cargo watch on the same directory tree, causing tauri dev to restart
        // the app and SIGKILL the server. Disable in dev builds.
        let watcher = if cfg!(debug_assertions) {
            log::info!("[fs-watcher] disabled in debug build (conflicts with tauri dev)");
            let _ = fs_tx;
            None
        } else {
            crate::ipc::file_watcher::FileWatcher::new(fs_tx)
                .map_err(|e| log::warn!("[fs-watcher] init failed: {e}"))
                .ok()
        };

        Self {
            sessions: Vec::new(),
            ptys: HashMap::new(),
            broadcast_tx,
            cwd_map: Arc::new(Mutex::new(HashMap::new())),
            cwd_dirty: Arc::new(AtomicBool::new(false)),
            active_session_id: None,
            pending_sessions: Vec::new(),
            file_watcher: watcher,
            host_pty_sizes: HashMap::new(),
            remote_pty_sizes: HashMap::new(),
        }
    }

    /// 새 PTY를 생성하고 (pty_id, detected_shell_type)를 반환.
    pub fn spawn_pty(
        &mut self,
        rows: u16,
        cols: u16,
        cwd: Option<&str>,
        shell_type: Option<ShellType>,
    ) -> Result<(String, Option<ShellType>), String> {
        log::info!("spawn_pty: rows={rows}, cols={cols}, cwd={:?}, shell_type={:?}", cwd, shell_type);
        let pty_system = native_pty_system();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let shell = shell_type.unwrap_or_default().to_shell_path();
        let detected_shell = ShellType::from_path(&shell).or(shell_type);
        let mut cmd = CommandBuilder::new(&shell);
        // macOS/Linux: login shell로 실행하여 /etc/zprofile(path_helper) 등이 로드되도록 함.
        // GUI 앱에서 실행 시 PATH가 최소한만 설정되는 문제를 해결.
        // bash는 --login + --rcfile 충돌이 있으므로 rcfile에서 login 파일을 직접 source.
        #[cfg(not(windows))]
        if matches!(detected_shell, Some(ShellType::Zsh | ShellType::Fish)) {
            cmd.arg("--login");
        }
        #[cfg(windows)]
        if matches!(detected_shell, Some(ShellType::PowerShell)) {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(ps_osc133_script());
        }
        #[cfg(not(windows))]
        if matches!(detected_shell, Some(ShellType::PowerShell)) {
            cmd.arg("-NoLogo");
        }
        // macOS/Linux: bash/zsh/fish에 OSC 133 shell integration 자동 주입
        // → 프롬프트(A), 입력(B), 실행(C), 완료+exit code(D) 시퀀스를 내보내
        //   클라이언트가 명령 성공/실패를 감지할 수 있게 한다.
        #[cfg(not(windows))]
        {
            if matches!(detected_shell, Some(ShellType::Zsh)) {
                // zsh: ZDOTDIR을 임시 디렉토리로 설정, .zshenv에서 원본 복원 + OSC 133 설정
                if let Some(init_dir) = setup_zsh_osc133_zdotdir() {
                    if let Ok(original) = std::env::var("ZDOTDIR") {
                        cmd.env("RACEMO_ORIG_ZDOTDIR", &original);
                    }
                    cmd.env("ZDOTDIR", init_dir.to_string_lossy().as_ref());
                }
            } else if matches!(detected_shell, Some(ShellType::Bash)) {
                // bash: BASH_ENV에 스크립트 경로 지정 (interactive에서는 무시되므로 --rcfile 사용)
                if let Some(rcfile) = setup_bash_osc133_rcfile() {
                    cmd.arg("--rcfile");
                    cmd.arg(rcfile.to_string_lossy().as_ref());
                }
            } else if matches!(detected_shell, Some(ShellType::Fish)) {
                if let Some(init_script) = fish_osc133_init_command() {
                    cmd.arg("--init-command");
                    cmd.arg(&init_script);
                }
            }
        }
        // CMD: PROMPT 환경변수로 OSC 133;A(프롬프트 시작) + OSC 133;B(입력 준비) 삽입
        #[cfg(windows)]
        if matches!(detected_shell, Some(ShellType::Cmd)) {
            // $E = ESC(0x1B), $P = 현재 경로, $G = '>'
            // OSC 133;A → CWD → 기본 프롬프트 → OSC 133;B (입력 위치 마킹)
            cmd.env("PROMPT", "$E]133;A$E\\$P$G $E]133;B$E\\");
        }
        // 서버 내부 및 Tauri 전용 환경변수를 PTY에 노출하지 않도록 제거.
        for key in &[
            "RACEMO_SOCKET_PATH",
            "RACEMO_LOG_LEVEL",
            "TAURI_ENV",
            "RUST_LOG",
            "RUST_BACKTRACE",
        ] {
            cmd.env_remove(key);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("PROMPT_EOL_MARK", "");
        cmd.env("SHELL_SESSIONS_DISABLE", "1");
        if std::env::var("LANG").unwrap_or_default().is_empty() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        // 초기 작업 디렉토리 결정: 제공된 cwd 사용, 없으면 HOME으로 폴백.
        let initial_cwd = if let Some(dir) = cwd {
            if dir.is_empty() {
                let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".to_string());
                cmd.cwd(&home);
                home
            } else if std::path::Path::new(dir).is_dir() {
                cmd.cwd(dir);
                dir.to_string()
            } else {
                return Err(format!("Directory not found: {dir}"));
            }
        } else {
            let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".to_string());
            cmd.cwd(&home);
            home
        };

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;

        drop(pair.slave);

        let pty_id = Uuid::new_v4().to_string();

        // 초기 CWD를 즉시 저장.
        self.cwd_map.lock().insert(pty_id.clone(), initial_cwd);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

        let history = Arc::new(Mutex::new(Vec::new()));
        let pty_size = Arc::new(AtomicU32::new(pack_pty_size(rows, cols)));

        // PtyExit 메시지 중복 방지 플래그 (리더 스레드 vs 자식 워처)
        let exit_sent = Arc::new(AtomicBool::new(false));

        // PTY 출력을 읽어 브로드캐스트하는 백그라운드 스레드 생성.
        let tx = self.broadcast_tx.clone();
        let reader_pty_id = pty_id.clone();
        let reader_history = history.clone();
        let exit_sent_reader = exit_sent.clone();
        let reader_cwd_map = self.cwd_map.clone();
        let reader_cwd_dirty = self.cwd_dirty.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // OSC 7 parser state for CWD tracking
            let mut in_osc7 = false;
            let mut osc_buf = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();

                        // OSC 7 파싱으로 CWD 갱신
                        let paths = crate::ipc::osc7::parse_osc7_from_stream(&data, &mut in_osc7, &mut osc_buf);
                        if let Some(last_path) = paths.last() {
                            reader_cwd_map.lock().insert(reader_pty_id.clone(), last_path.clone());
                            reader_cwd_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
                        }

                        // 히스토리에 저장 (최대 100KB 제한)
                        {
                            let mut hist = reader_history.lock();
                            hist.extend_from_slice(&data);
                            if hist.len() > 100 * 1024 {
                                let to_remove = hist.len() - (100 * 1024);
                                hist.drain(0..to_remove);
                            }
                        }

                        let _ = tx.send(ServerMessage::PtyOutput {
                            pane_id: reader_pty_id.clone(),
                            data,
                        });
                    }
                    Err(_) => break,
                }
            }
            // 자식 워처에서 이미 보내지 않았을 때만 PtyExit 전송
            if !exit_sent_reader.swap(true, Ordering::SeqCst) {
                let _ = tx.send(ServerMessage::PtyExit {
                    pane_id: reader_pty_id,
                });
            }
        });

        // Windows에서 자식 프로세스 종료를 감시하는 추가 스레드 생성.
        // ConPTY 리더는 쉘 종료 시 즉시 EOF를 반환하지 않을 수 있다.
        #[cfg(windows)]
        {
            let child = Arc::new(Mutex::new(child));
            let child_watcher = child.clone();
            let exit_sent_watcher = exit_sent.clone();
            let tx_watcher = self.broadcast_tx.clone();
            let watcher_pty_id = pty_id.clone();
            let cwd_map_watcher = self.cwd_map.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    let mut c = child_watcher.lock();
                    match c.try_wait() {
                        Ok(Some(_status)) => {
                            // 자식 프로세스 종료 - 아직 보내지 않았으면 PtyExit 전송
                            if !exit_sent_watcher.swap(true, Ordering::SeqCst) {
                                log::info!("Child process exited for PTY {}", watcher_pty_id);
                                cwd_map_watcher.lock().remove(&watcher_pty_id);
                                let _ = tx_watcher.send(ServerMessage::PtyExit {
                                    pane_id: watcher_pty_id,
                                });
                            }
                            break;
                        }
                        Ok(None) => continue, // 아직 실행 중
                        Err(_) => break,      // 상태 확인 오류
                    }
                }
            });

            self.ptys.insert(
                pty_id.clone(),
                PtyHandle {
                    writer,
                    master: pair.master,
                    history,
                    pty_size,
                },
            );
        }

        #[cfg(not(windows))]
        {
            self.ptys.insert(
                pty_id.clone(),
                PtyHandle {
                    writer,
                    master: pair.master,
                    _child: child,
                    history,
                    pty_size,
                },
            );

        }

        self.host_pty_sizes.insert(pty_id.clone(), (rows, cols));
        log::info!("PTY spawned: {pty_id} (shell: {detected_shell:?})");
        Ok((pty_id, detected_shell))
    }

    fn get_pty_mut(&mut self, pane_id: &str) -> Result<&mut PtyHandle, String> {
        self.ptys
            .get_mut(pane_id)
            .ok_or_else(|| format!("PTY not found: {pane_id}"))
    }

    pub fn write_pty(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let handle = self.get_pty_mut(pane_id)?;
        handle
            .writer
            .write_all(data)
            .map_err(|e| format!("Write failed: {e}"))?;
        handle
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {e}"))?;
        Ok(())
    }

    /// 호스트 로컬 터미널의 resize 요청. min(호스트, 원격)으로 실제 PTY에 적용.
    pub fn resize_pty(&mut self, pane_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.host_pty_sizes.insert(pane_id.to_string(), (rows, cols));
        let (eff_rows, eff_cols) = self.effective_pty_size(pane_id);
        let result = self.apply_pty_resize(pane_id, eff_rows, eff_cols);
        // 호스트 요청 사이즈와 실제 적용 사이즈가 다르면 (원격 min 제한됨)
        // apply_pty_resize가 early return(PTY 미변경)했어도 PtyResized를 보내서
        // 호스트 로컬 xterm이 실제 PTY 사이즈에 맞게 동기화되도록 함.
        if (rows, cols) != (eff_rows, eff_cols) {
            let _ = self.broadcast_tx.send(ServerMessage::PtyResized {
                pane_id: pane_id.to_string(),
                rows: eff_rows,
                cols: eff_cols,
            });
        }
        result
    }

    /// 원격 클라이언트의 resize 요청. min(호스트, 원격)으로 실제 PTY에 적용.
    pub fn resize_pty_remote(&mut self, pane_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.remote_pty_sizes.insert(pane_id.to_string(), (rows, cols));
        let (eff_rows, eff_cols) = self.effective_pty_size(pane_id);
        self.apply_pty_resize(pane_id, eff_rows, eff_cols)
    }

    /// 모든 원격 PTY 사이즈를 제거하고 호스트 사이즈로 복원.
    pub fn clear_all_remote_pty_sizes(&mut self) {
        let pane_ids: Vec<String> = self.remote_pty_sizes.keys().cloned().collect();
        for pane_id in pane_ids {
            self.remote_pty_sizes.remove(&pane_id);
            if let Some(&(rows, cols)) = self.host_pty_sizes.get(&pane_id) {
                let _ = self.apply_pty_resize(&pane_id, rows, cols);
            }
        }
    }

    /// min(호스트, 원격) 계산. 원격이 없으면 호스트 사이즈 그대로.
    fn effective_pty_size(&self, pane_id: &str) -> (u16, u16) {
        let host = self.host_pty_sizes.get(pane_id).copied().unwrap_or((24, 80));
        match self.remote_pty_sizes.get(pane_id) {
            Some(&(rr, rc)) => (host.0.min(rr), host.1.min(rc)),
            None => host,
        }
    }

    fn apply_pty_resize(&mut self, pane_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let handle = self.get_pty_mut(pane_id)?;
        let old = unpack_pty_size(handle.pty_size.load(Ordering::Relaxed));
        if old == (rows, cols) {
            return Ok(());
        }
        log::info!("apply_pty_resize: pane_id={pane_id}, old={}x{}, new={rows}x{cols}", old.0, old.1);
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {e}"))?;
        handle.pty_size.store(pack_pty_size(rows, cols), Ordering::Relaxed);
        // 원격 클라이언트에 실제 적용된 PTY 사이즈 알림
        let _ = self.broadcast_tx.send(ServerMessage::PtyResized {
            pane_id: pane_id.to_string(),
            rows,
            cols,
        });
        Ok(())
    }

    pub fn get_pty_history(&self, pty_id: &str) -> Option<Vec<u8>> {
        self.ptys.get(pty_id).map(|h| h.history.lock().clone())
    }

    /// Check if a pty_id is attached to any active session.
    ///
    /// Used to validate `TerminalInput` / `ResizeRequest` messages arriving
    /// over WebRTC: the proto field there is the PTY id (the value stored in
    /// `PaneNode::Leaf { pty_id, .. }`), not the pane container id.
    pub fn is_valid_pty(&self, pty_id: &str) -> bool {
        self.sessions
            .iter()
            .any(|s| s.root_pane.pty_ids().iter().any(|p| p == pty_id))
    }

    /// Check if a pane container id exists in any active session.
    ///
    /// Used to validate `SplitPaneRequest` / `ClosePaneRequest` messages
    /// arriving over WebRTC: these operations target a pane container by its
    /// layout id (`PaneNode::Leaf { id, .. }`), which is separate from the
    /// PTY id that routes terminal I/O.
    pub fn is_valid_pane(&self, pane_id: &str) -> bool {
        self.sessions
            .iter()
            .any(|s| s.root_pane.find_pty_id(pane_id).is_some())
    }

    pub fn kill_pty(&mut self, pty_id: &str) {
        log::info!("kill_pty: {pty_id}");
        self.ptys.remove(pty_id);
        self.cwd_map.lock().remove(pty_id);
        self.host_pty_sizes.remove(pty_id);
        self.remote_pty_sizes.remove(pty_id);
    }

    /// 현재 상태를 디스크에 영속화. 상태 변경 작업마다 호출.
    /// 세션이 0개이고 아직 복원 대기 중인 세션이 있으면 덮어쓰지 않음 (빌드 시 데이터 손실 방지).
    fn persist(&self) {
        if self.sessions.is_empty() && !self.pending_sessions.is_empty() {
            log::warn!("Skipping persist: no active sessions but {} pending sessions exist", self.pending_sessions.len());
            return;
        }
        // All sessions closed — delete the state file so nothing is restored on next launch.
        if self.sessions.is_empty() {
            if let Some(path) = crate::persistence::state_file_path() {
                let _ = std::fs::remove_file(&path);
                log::info!("All sessions closed, removed state file");
            }
            return;
        }
        let cwd_map = self.cwd_map.lock().clone();
        let persisted = PersistedState {
            version: 2,
            sessions: self.sessions.iter().map(|s| {
                let (rows, cols) = self.get_session_pty_size(s);
                session_to_persisted(s, &cwd_map, rows, cols)
            }).collect(),
            active_session_id: self.active_session_id.clone(),
        };

        if let Err(e) = save_state(&persisted) {
            log::error!("Failed to persist state: {e}");
        }
    }

    /// 특정 PTY의 현재 사이즈 반환.
    pub fn get_pty_size(&self, pty_id: &str) -> Option<(u16, u16)> {
        self.ptys.get(pty_id).map(|h| unpack_pty_size(h.pty_size.load(Ordering::Relaxed)))
    }

    fn get_session_pty_size(&self, session: &Session) -> (u16, u16) {
        let pty_ids = session.root_pane.pty_ids();
        if let Some(pty_id) = pty_ids.first() {
            if let Some(handle) = self.ptys.get(pty_id) {
                return unpack_pty_size(handle.pty_size.load(Ordering::Relaxed));
            }
        }
        (24, 80)
    }

    /// 영속 세션을 메모리에 로드 (PTY 생성 없이).
    /// 클라이언트가 실제 터미널 크기와 함께 ListSessions를 보낼 때 지연 생성.
    pub fn load_persisted_sessions(&mut self) {
        match load_state() {
            Ok(Some(state)) => {
                log::info!("Loaded {} persisted sessions (PTY deferred)", state.sessions.len());
                self.active_session_id = state.active_session_id;
                self.pending_sessions = state.sessions;
            }
            Ok(None) => {
                log::info!("No saved state found, starting fresh");
            }
            Err(e) => {
                log::error!("Failed to load state: {e}");
            }
        }
    }

    /// 대기 중인 세션을 각 세션의 저장된 크기로 PTY를 생성하여 복원.
    /// 이미 동일한 ID를 가진 세션이 있으면 중복 복원하지 않음.
    fn restore_pending_sessions(&mut self) {
        if self.pending_sessions.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.pending_sessions);
        log::info!("Restoring {} pending sessions", pending.len());
        for persisted in pending {
            // 동일 ID 세션이 이미 존재하면 스킵 (중복 방지)
            if self.sessions.iter().any(|s| s.id == persisted.id) {
                log::info!("Session '{}' already exists, skipping restore", persisted.name);
                continue;
            }
            let session_name = persisted.name.clone();
            let rows = persisted.rows;
            let cols = persisted.cols;
            log::info!("Restoring session '{}' with saved size {rows}x{cols}", session_name);
            match self.restore_single_session(persisted, rows, cols) {
                Ok(session) => {
                    log::info!("Restored session: {}", session.name);
                    self.sessions.push(session);
                }
                Err(e) => {
                    log::error!("Failed to restore session '{}': {e}", session_name);
                }
            }
        }
    }

    fn restore_single_session(
        &mut self,
        persisted: crate::persistence::PersistedSession,
        rows: u16,
        cols: u16,
    ) -> Result<Session, String> {
        let mut pty_spawner = |cwd: Option<&str>, shell_type: Option<ShellType>| self.spawn_pty(rows, cols, cwd, shell_type);
        persisted_to_session(&persisted, &mut pty_spawner)
    }

    /// cwd_map에서 세션의 모든 Leaf 노드에 CWD 필드를 채움.
    fn populate_cwd(&self, session: &mut Session) {
        let map = self.cwd_map.lock();
        session.root_pane.populate_cwd(&map);
    }

    /// 세션을 복제하고 CWD 필드를 채워서 반환.
    fn session_with_cwd(&self, session: &Session) -> Session {
        let mut s = session.clone();
        self.populate_cwd(&mut s);
        s
    }

    /// 단일 클라이언트 메시지를 처리하고 응답을 반환.
    pub fn handle_message(&mut self, msg: ClientMessage) -> ServerMessage {
        Self::log_request(&msg);

        let response = match msg {
            ClientMessage::CreateSession { name, working_dir, shell, rows, cols } => {
                self.handle_create_session(name, working_dir, shell, rows, cols)
            }
            ClientMessage::ListSessions => self.handle_list_sessions(),
            ClientMessage::AttachSession { session_id } => self.handle_attach_session(session_id),
            ClientMessage::DetachSession { session_id } => {
                ServerMessage::SessionDetached { session_id }
            }
            ClientMessage::CloseSession { session_id } => self.handle_close_session(session_id),
            ClientMessage::RenameSession { session_id, name } => {
                self.handle_rename_session(session_id, name)
            }
            ClientMessage::SetPaneLastCommand { session_id, pane_id, command } => {
                self.handle_set_pane_last_command(session_id, pane_id, command)
            }
            ClientMessage::SplitPane { session_id, pane_id, direction, shell, rows, cols, before } => {
                self.handle_split_pane(session_id, pane_id, direction, shell, rows, cols, before)
            }
            ClientMessage::ClosePane { session_id, pane_id } => {
                self.handle_close_pane(session_id, pane_id)
            }
            ClientMessage::ResizePane { session_id, split_id, ratio } => {
                self.handle_resize_pane(session_id, split_id, ratio)
            }
            ClientMessage::ResizePty { pane_id, rows, cols } => {
                match self.resize_pty(&pane_id, rows, cols) {
                    Ok(()) => ServerMessage::Ok,
                    Err(e) => ServerMessage::Error { code: ErrorCode::PaneNotFound, message: e },
                }
            }
            ClientMessage::RemoteResizePty { pane_id, rows, cols } => {
                match self.resize_pty_remote(&pane_id, rows, cols) {
                    Ok(()) => ServerMessage::Ok,
                    Err(e) => ServerMessage::Error { code: ErrorCode::PaneNotFound, message: e },
                }
            }
            ClientMessage::WriteToPty { pane_id, data } => {
                match self.write_pty(&pane_id, &data) {
                    Ok(()) => ServerMessage::Ok,
                    Err(e) => ServerMessage::Error { code: ErrorCode::PaneNotFound, message: e },
                }
            }
            ClientMessage::RespawnPty { session_id, pane_id, shell, rows, cols } => {
                self.handle_respawn_pty(session_id, pane_id, shell, rows, cols)
            }
            ClientMessage::UpdateWatchedPaths { dirs, editor_file } => {
                if let Some(ref mut watcher) = self.file_watcher {
                    watcher.update_dirs(dirs);
                    watcher.update_file(editor_file);
                }
                ServerMessage::Ok
            }
            ClientMessage::Ping => ServerMessage::Pong,
            ClientMessage::Shutdown => {
                log::info!("Shutdown requested");
                self.persist();
                std::process::exit(0);
            }
            ClientMessage::GetActiveSessionId => ServerMessage::ActiveSessionId {
                session_id: self.active_session_id.clone(),
            },
            ClientMessage::StartHosting
            | ClientMessage::StopHosting
            | ClientMessage::GetHostingStatus
            | ClientMessage::StartAccountHosting { .. }
            | ClientMessage::ApproveAccountConnection { .. } => {
                ServerMessage::Error {
                    code: ErrorCode::InvalidOperation,
                    message: "Hosting messages must be handled async".to_string(),
                }
            }
        };

        Self::log_response(&response);
        response
    }

    fn log_request(msg: &ClientMessage) {
        const YELLOW: &str = "\x1b[93m";
        const RESET: &str = "\x1b[0m";
        match msg {
            ClientMessage::WriteToPty { data, .. } => {
                let _preview = if data.len() > 20 {
                    format!("{}... ({} bytes)", String::from_utf8_lossy(&data[..20]), data.len())
                } else {
                    format!("{:?} ({} bytes)", String::from_utf8_lossy(data), data.len())
                };
            }
            ClientMessage::Ping => {
                log::info!("{YELLOW}→ Request:{RESET} Ping");
            }
            ClientMessage::ResizePty { pane_id, rows, cols } => {
                log::info!("{YELLOW}→ Request:{RESET} ResizePty {{ pane_id: {pane_id}, rows: {rows}, cols: {cols} }}");
            }
            ClientMessage::RemoteResizePty { pane_id, rows, cols } => {
                log::info!("{YELLOW}→ Request:{RESET} RemoteResizePty {{ pane_id: {pane_id}, rows: {rows}, cols: {cols} }}");
            }
            _ => {
                log::info!("{YELLOW}→ Request:{RESET} {:?}", msg);
            }
        }
    }

    fn log_response(response: &ServerMessage) {
        const CYAN: &str = "\x1b[96m";
        const RESET: &str = "\x1b[0m";
        match response {
            ServerMessage::PtyOutput { pane_id, data } => {
                let preview = if data.len() > 100 {
                    format!("{}... ({} bytes)", String::from_utf8_lossy(&data[..100]), data.len())
                } else {
                    format!("{:?} ({} bytes)", String::from_utf8_lossy(data), data.len())
                };
                log::trace!("{CYAN}← Response:{RESET} PtyOutput {{ pane_id: {pane_id}, data: {preview} }}");
            }
            ServerMessage::Ok => {}
            ServerMessage::Pong => {
                log::trace!("{CYAN}← Response:{RESET} Pong");
            }
            ServerMessage::SessionCreated { session } => {
                log::info!("{CYAN}← Response:{RESET} SessionCreated {{ session_id: {}, name: {:?} }}", session.id, session.name);
            }
            ServerMessage::SessionList { sessions } => {
                log::info!("{CYAN}← Response:{RESET} SessionList {{ count: {} }}", sessions.len());
            }
            ServerMessage::SessionAttached { session } => {
                log::info!("{CYAN}← Response:{RESET} SessionAttached {{ session_id: {}, name: {:?} }}", session.id, session.name);
            }
            ServerMessage::SessionUpdated { session } => {
                log::info!("{CYAN}← Response:{RESET} SessionUpdated {{ session_id: {} }}", session.id);
            }
            ServerMessage::SessionModified { session } => {
                log::info!("{CYAN}← Response:{RESET} SessionModified {{ session_id: {} }}", session.id);
            }
            ServerMessage::SessionDetached { session_id } => {
                log::info!("{CYAN}← Response:{RESET} SessionDetached {{ session_id: {} }}", session_id);
            }
            ServerMessage::SessionClosed { remaining } => {
                log::info!("{CYAN}← Response:{RESET} SessionClosed {{ has_remaining: {} }}", remaining.is_some());
            }
            ServerMessage::SessionRenamed => {
                log::info!("{CYAN}← Response:{RESET} SessionRenamed");
            }
            ServerMessage::Error { code, message } => {
                log::warn!("{CYAN}← Response:{RESET} Error {{ code: {:?}, message: {} }}", code, message);
            }
            _ => {
                log::debug!("{CYAN}← Response:{RESET} {:?}", response);
            }
        }
    }

    fn handle_create_session(
        &mut self,
        name: Option<String>,
        working_dir: Option<String>,
        shell: Option<ShellType>,
        rows: u16,
        cols: u16,
    ) -> ServerMessage {
        let cwd = working_dir.as_deref();
        match self.spawn_pty(rows, cols, cwd, shell) {
            Ok((pty_id, detected_shell)) => {
                let session = Session::new(name, pty_id, detected_shell);
                log::info!("Session created: id={}, name={:?}", session.id, session.name);
                self.active_session_id = Some(session.id.clone());
                self.sessions.push(session);
                self.persist();
                let session = self.session_with_cwd(self.sessions.last().expect("just pushed"));
                ServerMessage::SessionCreated { session }
            }
            Err(e) => {
                log::error!("Failed to create session: {e}");
                ServerMessage::Error { code: ErrorCode::PtySpawnFailed, message: e }
            }
        }
    }

    fn handle_list_sessions(&mut self) -> ServerMessage {
        self.restore_pending_sessions();
        let sessions: Vec<Session> = self.sessions.iter().map(|s| self.session_with_cwd(s)).collect();
        ServerMessage::SessionList { sessions }
    }

    fn handle_attach_session(&mut self, session_id: String) -> ServerMessage {
        match self.sessions.iter().find(|s| s.id == session_id) {
            Some(session) => {
                self.active_session_id = Some(session_id);
                self.persist();
                ServerMessage::SessionAttached { session: self.session_with_cwd(session) }
            }
            None => ServerMessage::Error {
                code: ErrorCode::SessionNotFound,
                message: format!("Session not found: {session_id}"),
            },
        }
    }

    fn handle_close_session(&mut self, session_id: String) -> ServerMessage {
        let idx = self.sessions.iter().position(|s| s.id == session_id);
        match idx {
            Some(i) => {
                let removed = self.sessions.remove(i);
                log::info!("Session closed: id={}, name={}", removed.id, removed.name);
                for pty_id in removed.root_pane.pty_ids() {
                    self.kill_pty(&pty_id);
                }
                self.active_session_id = self.sessions.last().map(|s| s.id.clone());
                self.persist();
                let remaining = self.sessions.last().cloned();
                ServerMessage::SessionClosed { remaining }
            }
            None => {
                log::warn!("CloseSession failed: session not found: {session_id}");
                ServerMessage::Error {
                    code: ErrorCode::SessionNotFound,
                    message: format!("Session not found: {session_id}"),
                }
            }
        }
    }

    fn handle_rename_session(&mut self, session_id: String, name: String) -> ServerMessage {
        match self.sessions.iter_mut().find(|s| s.id == session_id) {
            Some(session) => {
                session.name = name;
                self.persist();
                ServerMessage::SessionRenamed
            }
            None => ServerMessage::Error {
                code: ErrorCode::SessionNotFound,
                message: format!("Session not found: {session_id}"),
            },
        }
    }

    fn handle_set_pane_last_command(
        &mut self,
        session_id: String,
        pane_id: String,
        command: String,
    ) -> ServerMessage {
        match self.sessions.iter_mut().find(|s| s.id == session_id) {
            Some(session) => {
                if command.is_empty() {
                    session.root_pane.clear_last_command(&pane_id);
                } else {
                    session.root_pane.set_last_command(&pane_id, command);
                }
                self.persist();
                ServerMessage::Ok
            }
            None => ServerMessage::Error {
                code: ErrorCode::SessionNotFound,
                message: format!("Session not found: {session_id}"),
            },
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_split_pane(
        &mut self,
        session_id: String,
        pane_id: String,
        direction: SplitDirection,
        shell: Option<ShellType>,
        rows: u16,
        cols: u16,
        before: bool,
    ) -> ServerMessage {
        let source_cwd = self
            .sessions
            .iter()
            .find(|s| s.id == session_id)
            .and_then(|s| s.root_pane.find_pty_id(&pane_id))
            .and_then(|pty_id| self.cwd_map.lock().get(&pty_id).cloned());

        match self.spawn_pty(rows, cols, source_cwd.as_deref(), shell) {
            Ok((new_pty_id, _detected_shell)) => {
                let split_result = {
                    match self.sessions.iter_mut().find(|s| s.id == session_id) {
                        Some(session) => {
                            match session.split_pane(&pane_id, direction, new_pty_id.clone(), shell, before) {
                                Some(_) => {
                                    log::info!("Pane split: session={session_id}, new_pty={new_pty_id}, direction={direction:?}");
                                    Some(session.clone())
                                }
                                None => None,
                            }
                        }
                        None => None,
                    }
                };
                match split_result {
                    Some(mut s) => {
                        self.persist();
                        s.root_pane.populate_cwd(&self.cwd_map.lock());
                        let _ = self.broadcast_tx.send(ServerMessage::SessionUpdated { session: s.clone() });
                        ServerMessage::SessionModified { session: s }
                    }
                    None => {
                        if self.sessions.iter().any(|s| s.id == session_id) {
                            log::warn!("SplitPane failed: pane not found: {pane_id}");
                            ServerMessage::Error { code: ErrorCode::PaneNotFound, message: format!("Pane not found: {pane_id}") }
                        } else {
                            log::warn!("SplitPane failed: session not found: {session_id}");
                            ServerMessage::Error { code: ErrorCode::SessionNotFound, message: format!("Session not found: {session_id}") }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("SplitPane failed: PTY spawn failed: {e}");
                ServerMessage::Error { code: ErrorCode::PtySpawnFailed, message: e }
            }
        }
    }

    fn handle_close_pane(&mut self, session_id: String, pane_id: String) -> ServerMessage {
        let close_result = {
            match self.sessions.iter_mut().find(|s| s.id == session_id) {
                Some(session) => match session.close_pane(&pane_id) {
                    Some(closed_pty_id) => {
                        log::info!("Pane closed: session={session_id}, pane={pane_id}");
                        Some((session.clone(), closed_pty_id))
                    }
                    None => None,
                },
                None => None,
            }
        };
        match close_result {
            Some((mut s, closed_pty_id)) => {
                self.persist();
                s.root_pane.populate_cwd(&self.cwd_map.lock());
                let _ = self.broadcast_tx.send(ServerMessage::SessionUpdated { session: s.clone() });
                self.kill_pty(&closed_pty_id);
                ServerMessage::SessionModified { session: s }
            }
            None => {
                if self.sessions.iter().any(|s| s.id == session_id) {
                    log::warn!("ClosePane failed: cannot close last pane");
                    ServerMessage::Error { code: ErrorCode::InvalidOperation, message: "Cannot close the last pane".to_string() }
                } else {
                    log::warn!("ClosePane failed: session not found: {session_id}");
                    ServerMessage::Error { code: ErrorCode::SessionNotFound, message: format!("Session not found: {session_id}") }
                }
            }
        }
    }

    fn handle_resize_pane(&mut self, session_id: String, split_id: String, ratio: f64) -> ServerMessage {
        let resize_result = {
            match self.sessions.iter_mut().find(|s| s.id == session_id) {
                Some(session) => {
                    session.resize_pane(&split_id, ratio);
                    Some(session.clone())
                }
                None => None,
            }
        };
        match resize_result {
            Some(mut s) => {
                self.persist();
                s.root_pane.populate_cwd(&self.cwd_map.lock());
                ServerMessage::SessionModified { session: s }
            }
            None => ServerMessage::Error {
                code: ErrorCode::SessionNotFound,
                message: format!("Session not found: {session_id}"),
            },
        }
    }

    fn handle_respawn_pty(
        &mut self,
        session_id: String,
        pane_id: String,
        shell: ShellType,
        rows: u16,
        cols: u16,
    ) -> ServerMessage {
        let respawn_info: Option<(String, Option<String>)> = {
            match self.sessions.iter().find(|s| s.id == session_id) {
                Some(session) => {
                    match session.root_pane.find_pty_id(&pane_id) {
                        Some(old_id) => {
                            let cwd = self.cwd_map.lock().get(&old_id).cloned();
                            Some((old_id, cwd))
                        }
                        None => None,
                    }
                }
                None => None,
            }
        };
        match respawn_info {
            Some((old_id, cwd)) => {
                self.kill_pty(&old_id);
                match self.spawn_pty(rows, cols, cwd.as_deref(), Some(shell)) {
                    Ok((new_pty_id, _detected_shell)) => {
                        let update_result = {
                            if let Some(session) = self.sessions.iter_mut().find(|s| s.id == session_id) {
                                session.root_pane.update_pty_id(&pane_id, new_pty_id);
                                Some(session.clone())
                            } else {
                                None
                            }
                        };
                        match update_result {
                            Some(mut session_clone) => {
                                self.persist();
                                session_clone.root_pane.populate_cwd(&self.cwd_map.lock());
                                ServerMessage::SessionModified { session: session_clone }
                            }
                            None => ServerMessage::Error {
                                code: ErrorCode::SessionNotFound,
                                message: format!("Session not found: {session_id}"),
                            },
                        }
                    }
                    Err(e) => ServerMessage::Error { code: ErrorCode::PtySpawnFailed, message: e },
                }
            }
            None => {
                if self.sessions.iter().any(|s| s.id == session_id) {
                    ServerMessage::Error { code: ErrorCode::PaneNotFound, message: format!("Pane not found: {pane_id}") }
                } else {
                    ServerMessage::Error { code: ErrorCode::SessionNotFound, message: format!("Session not found: {session_id}") }
                }
            }
        }
    }
}

// ── 서버 생명주기 헬퍼 ──────────────────────────────────────────

type RemoteHostManagerRef = Arc<TokioMutex<crate::remote::server_host::RemoteHostManager>>;

/// 서버 공통 초기화: PID 파일, 상태 생성, 세션 복원, 주기적 영속화 태스크.
fn init_server() -> anyhow::Result<(
    Arc<Mutex<ServerState>>,
    broadcast::Sender<ServerMessage>,
    RemoteHostManagerRef,
)> {
    let pid_path = pid_file_path();
    std::fs::write(&pid_path, std::process::id().to_string())?;

    let (broadcast_tx, _) = broadcast::channel::<ServerMessage>(1024);
    let state = Arc::new(Mutex::new(ServerState::new(broadcast_tx.clone())));

    // 영속 세션 로드 (첫 ListSessions 시 PTY 지연 생성)
    {
        let mut s = state.lock();
        s.load_persisted_sessions();
    }

    // 주기적 영속화 태스크 생성 - CWD 변경 시에만 저장
    {
        let state_for_persist = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                let s = state_for_persist.lock();
                if !s.sessions.is_empty() && s.cwd_dirty.swap(false, Ordering::SeqCst) {
                    s.persist();
                    log::debug!("CWD change detected, state persisted");
                }
            }
        });
    }

    // Remote host manager (server-side WebRTC hosting)
    let remote_host_manager = Arc::new(TokioMutex::new(
        crate::remote::server_host::RemoteHostManager::new(state.clone(), broadcast_tx.clone()),
    ));

    Ok((state, broadcast_tx, remote_host_manager))
}

/// 모든 스트림 타입에 대한 클라이언트 핸들러 태스크 생성.
fn spawn_client_handler(
    stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    state: Arc<Mutex<ServerState>>,
    broadcast_rx: broadcast::Receiver<ServerMessage>,
    remote_host_manager: Arc<TokioMutex<crate::remote::server_host::RemoteHostManager>>,
) {
    tokio::spawn(async move {
        let (reader, writer) = tokio::io::split(stream);
        handle_client_io(reader, writer, state, broadcast_rx, remote_host_manager).await;
    });
}

/// IPC 서버 실행. Unix 소켓 또는 Named Pipe에서 수신 대기.
pub async fn run_server(socket_path: &str) -> anyhow::Result<()> {
    // 플랫폼별 리스너 설정
    #[cfg(unix)]
    let listener = {
        let _ = std::fs::remove_file(socket_path);
        let listener = UnixListener::bind(socket_path)?;
        // 소켓 권한을 0600으로 설정 (소유자만 접근 가능)
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = std::fs::set_permissions(socket_path, perms);
        }
        listener
    };

    log::info!("Racemo server listening on {socket_path}");

    // 공통 초기화 (모든 플랫폼 공유)
    let (state, broadcast_tx, remote_host_manager) = init_server()?;

    // 플랫폼별 수신 루프
    #[cfg(unix)]
    {
        loop {
            let (stream, _) = listener.accept().await?;
            log::info!("Client connected");
            spawn_client_handler(stream, state.clone(), broadcast_tx.subscribe(), remote_host_manager.clone());
        }
    }

    #[cfg(windows)]
    {
        let mut is_first = true;
        loop {
            let server = match ServerOptions::new()
                .first_pipe_instance(is_first)
                .create(socket_path)
            {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Failed to create named pipe instance: {}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            is_first = false;

            log::debug!("Waiting for client on named pipe...");
            if let Err(e) = server.connect().await {
                log::error!("Named pipe client connection failed: {}", e);
                continue;
            }

            log::info!("Client connected via Named Pipe");
            spawn_client_handler(server, state.clone(), broadcast_tx.subscribe(), remote_host_manager.clone());
        }
    }
}

async fn handle_client_io<R, W>(
    mut reader: R,
    writer: W,
    state: Arc<Mutex<ServerState>>,
    mut broadcast_rx: broadcast::Receiver<ServerMessage>,
    remote_host_manager: Arc<TokioMutex<crate::remote::server_host::RemoteHostManager>>,
) where
    R: tokio::io::AsyncReadExt + Unpin,
    W: tokio::io::AsyncWriteExt + Unpin + Send + 'static,
{

    // 브로드캐스트 메시지 (PtyOutput/PtyExit)를 이 클라이언트로 전달하는 태스크 생성.
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let writer_for_broadcast = writer.clone();

    let broadcast_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(msg) => {
                    const GREEN: &str = "\x1b[92m";
                    const RESET: &str = "\x1b[0m";

                    match &msg {
                        ServerMessage::PtyOutput { pane_id, data } => {
                            // PTY 출력 프리뷰 로깅
                            let preview = if data.len() > 100 {
                                format!("{}... ({} bytes)", String::from_utf8_lossy(&data[..100]), data.len())
                            } else {
                                format!("{:?} ({} bytes)", String::from_utf8_lossy(data), data.len())
                            };
                            log::trace!("{GREEN}Broadcasting:{RESET} PtyOutput {{ pane_id: {pane_id}, data: {preview} }}");
                        }
                        ServerMessage::PtyExit { pane_id } => {
                            log::info!("{GREEN}Broadcasting:{RESET} PtyExit {{ pane_id: {pane_id} }}");
                        }
                        _ => {
                            log::debug!("{GREEN}Broadcasting:{RESET} {:?}", msg);
                        }
                    }
                    let mut w = writer_for_broadcast.lock().await;
                    if write_frame(&mut *w, &msg).await.is_err() {
                        log::error!("Failed to broadcast message");
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("Client lagged, skipped {n} messages");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // 클라이언트 메시지 수신 및 응답.
    loop {
        match read_frame::<_, ClientMessage>(&mut reader).await {
            Ok(Some(msg)) => {
                // WriteToPty/ResizePty는 클라이언트가 send()로 호출 (응답 불필요)
                let is_fire_and_forget = matches!(
                    msg,
                    ClientMessage::WriteToPty { .. } | ClientMessage::ResizePty { .. } | ClientMessage::RemoteResizePty { .. } | ClientMessage::UpdateWatchedPaths { .. }
                );
                // 호스팅 메시지는 handle_message()를 거치지 않고 직접 async 처리
                let response = match msg {
                    ClientMessage::StartHosting => {
                        let mut mgr = remote_host_manager.lock().await;
                        match mgr.start(crate::remote::DEFAULT_SIGNALING_URL).await {
                            Ok(pairing_code) => ServerMessage::HostingStarted { pairing_code },
                            Err(e) => ServerMessage::Error {
                                code: ErrorCode::InternalError,
                                message: e,
                            },
                        }
                    }
                    ClientMessage::StopHosting => {
                        let mut mgr = remote_host_manager.lock().await;
                        mgr.stop().await;
                        ServerMessage::HostingStopped
                    }
                    ClientMessage::GetHostingStatus => {
                        let mgr = remote_host_manager.lock().await;
                        let (status, pairing_code) = mgr.get_status();
                        ServerMessage::HostingStatus { status, pairing_code }
                    }
                    ClientMessage::StartAccountHosting { jwt, device_name } => {
                        let mut mgr = remote_host_manager.lock().await;
                        match mgr.start_account_based(crate::remote::DEFAULT_SIGNALING_URL, &jwt, &device_name).await {
                            Ok(()) => ServerMessage::Ok,
                            Err(e) => ServerMessage::Error {
                                code: ErrorCode::InternalError,
                                message: e,
                            },
                        }
                    }
                    ClientMessage::ApproveAccountConnection { room_code, approved } => {
                        let mgr = remote_host_manager.lock().await;
                        mgr.approve_connection(&room_code, approved);
                        ServerMessage::Ok
                    }
                    other => {
                        let mut s = state.lock();
                        s.handle_message(other)
                    }
                };
                // WriteToPty/ResizePty는 클라이언트가 send()로 호출하므로 응답 불필요 → skip
                // StartAccountHosting/ApproveAccountConnection은 request()로 호출하므로 반드시 전송
                if is_fire_and_forget && matches!(response, ServerMessage::Ok) {
                    continue;
                }
                log::trace!("Sending response to client");
                let mut w = writer.lock().await;
                if write_frame(&mut *w, &response).await.is_err() {
                    log::error!("Failed to send response to client");
                    break;
                }

                // 세션 연결 시, 해당 PTY의 히스토리 출력 전송.
                if let ServerMessage::SessionAttached { session } = &response {
                    let pty_ids = session.root_pane.pty_ids();
                    for pty_id in pty_ids {
                        let history = {
                            let s = state.lock();
                            s.get_pty_history(&pty_id)
                        };
                        if let Some(data) = history {
                            if !data.is_empty() {
                                let history_msg = ServerMessage::PtyOutput {
                                    pane_id: pty_id,
                                    data,
                                };
                                if write_frame(&mut *w, &history_msg).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }

                // 세션 생성 시에도 해당 PTY의 히스토리 출력 전송.
                if let ServerMessage::SessionCreated { session } = &response {
                    let pty_ids = session.root_pane.pty_ids();
                    for pty_id in pty_ids {
                        let history = {
                            let s = state.lock();
                            s.get_pty_history(&pty_id)
                        };
                        if let Some(data) = history {
                            if !data.is_empty() {
                                let history_msg = ServerMessage::PtyOutput {
                                    pane_id: pty_id,
                                    data,
                                };
                                if write_frame(&mut *w, &history_msg).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(None) => {
                log::info!("Client disconnected");
                break;
            }
            Err(e) => {
                log::error!("Error reading client message: {e}");
                break;
            }
        }
    }

    broadcast_task.abort();
}

#[cfg(test)]
mod pane_validator_tests {
    use super::*;
    use crate::layout::PaneNode;

    fn make_leaf(pane_id: &str, pty_id: &str) -> PaneNode {
        PaneNode::Leaf {
            id: pane_id.to_string(),
            pty_id: pty_id.to_string(),
            shell: None,
            cwd: None,
            last_command: None,
        }
    }

    fn make_state_with_leaf(pane_id: &str, pty_id: &str) -> ServerState {
        let (tx, _rx) = broadcast::channel(16);
        let mut state = ServerState::new(tx);
        state.sessions.push(Session {
            id: "s1".to_string(),
            name: "s1".to_string(),
            root_pane: make_leaf(pane_id, pty_id),
            pane_count: 1,
            created_at: 0,
        });
        state
    }

    #[test]
    fn is_valid_pty_matches_pty_id_only() {
        let state = make_state_with_leaf("pane-abc", "pty-xyz");
        assert!(state.is_valid_pty("pty-xyz"));
        // Passing the pane-container id to is_valid_pty must NOT match,
        // otherwise TerminalInput and pane ops would share a namespace.
        assert!(!state.is_valid_pty("pane-abc"));
        assert!(!state.is_valid_pty("nope"));
    }

    #[test]
    fn is_valid_pane_matches_pane_container_id_only() {
        let state = make_state_with_leaf("pane-abc", "pty-xyz");
        assert!(state.is_valid_pane("pane-abc"));
        // Passing the pty id to is_valid_pane must NOT match.
        assert!(!state.is_valid_pane("pty-xyz"));
        assert!(!state.is_valid_pane("nope"));
    }
}

#[cfg(test)]
mod resize_tests {
    use super::*;

    fn make_state() -> (ServerState, broadcast::Receiver<ServerMessage>) {
        let (tx, rx) = broadcast::channel(16);
        (ServerState::new(tx), rx)
    }

    // --- effective_pty_size 단위 테스트 ---

    #[test]
    fn effective_size_defaults_when_no_entries() {
        let (state, _rx) = make_state();
        // 아무 엔트리도 없으면 기본값 (24, 80)
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));
    }

    #[test]
    fn effective_size_returns_host_when_no_remote() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        // 원격 없으면 호스트 사이즈 그대로
        assert_eq!(state.effective_pty_size("pty-0"), (50, 200));
    }

    #[test]
    fn effective_size_returns_min_of_host_and_remote() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        state.remote_pty_sizes.insert("pty-0".into(), (24, 80));
        // min(50,24)=24, min(200,80)=80
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));
    }

    #[test]
    fn effective_size_min_per_dimension() {
        let (mut state, _rx) = make_state();
        // 호스트 rows 작고 원격 cols 작은 경우 → 각 차원별 min
        state.host_pty_sizes.insert("pty-0".into(), (20, 200));
        state.remote_pty_sizes.insert("pty-0".into(), (40, 80));
        assert_eq!(state.effective_pty_size("pty-0"), (20, 80));
    }

    #[test]
    fn effective_size_remote_equal_to_host() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (30, 100));
        state.remote_pty_sizes.insert("pty-0".into(), (30, 100));
        assert_eq!(state.effective_pty_size("pty-0"), (30, 100));
    }

    #[test]
    fn effective_size_remote_larger_than_host() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (24, 80));
        state.remote_pty_sizes.insert("pty-0".into(), (50, 200));
        // min → 호스트가 더 작으므로 호스트 사이즈
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));
    }

    #[test]
    fn effective_size_independent_per_pane() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        state.host_pty_sizes.insert("pty-1".into(), (30, 120));
        state.remote_pty_sizes.insert("pty-0".into(), (24, 80));
        // pty-0: min 적용, pty-1: 원격 없으므로 호스트 그대로
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));
        assert_eq!(state.effective_pty_size("pty-1"), (30, 120));
    }

    // --- resize_pty / resize_pty_remote 사이즈 맵 테스트 ---

    #[test]
    fn resize_pty_updates_host_sizes() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (24, 80));
        // resize_pty는 PTY handle이 필요하므로 실패하지만, host_pty_sizes는 먼저 갱신됨
        let _ = state.resize_pty("pty-0", 50, 200);
        assert_eq!(state.host_pty_sizes.get("pty-0"), Some(&(50, 200)));
    }

    #[test]
    fn resize_pty_remote_updates_remote_sizes() {
        let (mut state, _rx) = make_state();
        let _ = state.resize_pty_remote("pty-0", 24, 80);
        assert_eq!(state.remote_pty_sizes.get("pty-0"), Some(&(24, 80)));
    }

    #[test]
    fn resize_pty_remote_then_effective_uses_min() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        let _ = state.resize_pty_remote("pty-0", 24, 80);
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));
    }

    // --- clear_all_remote_pty_sizes 테스트 ---

    #[test]
    fn clear_remote_sizes_restores_host_effective() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        state.remote_pty_sizes.insert("pty-0".into(), (24, 80));
        assert_eq!(state.effective_pty_size("pty-0"), (24, 80));

        state.clear_all_remote_pty_sizes();
        // 원격 해제 후 호스트 사이즈로 복원
        assert_eq!(state.effective_pty_size("pty-0"), (50, 200));
        assert!(state.remote_pty_sizes.is_empty());
    }

    #[test]
    fn clear_remote_sizes_clears_all_panes() {
        let (mut state, _rx) = make_state();
        state.host_pty_sizes.insert("pty-0".into(), (50, 200));
        state.host_pty_sizes.insert("pty-1".into(), (30, 120));
        state.remote_pty_sizes.insert("pty-0".into(), (24, 80));
        state.remote_pty_sizes.insert("pty-1".into(), (20, 60));

        state.clear_all_remote_pty_sizes();
        assert!(state.remote_pty_sizes.is_empty());
        assert_eq!(state.effective_pty_size("pty-0"), (50, 200));
        assert_eq!(state.effective_pty_size("pty-1"), (30, 120));
    }

    // --- PtyResized broadcast 테스트 (실제 PTY 사용) ---

    #[test]
    fn resize_pty_remote_broadcasts_pty_resized() {
        let (mut state, mut rx) = make_state();
        // 실제 PTY를 생성하여 resize + broadcast 검증
        let (pty_id, _) = state.spawn_pty(50, 200, None, None).unwrap();

        // 원격 클라이언트가 더 작은 사이즈 요청
        state.resize_pty_remote(&pty_id, 24, 80).unwrap();

        // broadcast 수신 확인
        let msg = rx.try_recv().unwrap();
        match msg {
            ServerMessage::PtyResized { pane_id, rows, cols } => {
                assert_eq!(pane_id, pty_id);
                assert_eq!(rows, 24);
                assert_eq!(cols, 80);
            }
            other => panic!("Expected PtyResized, got {:?}", other),
        }
    }

    #[test]
    fn resize_pty_remote_no_broadcast_when_size_unchanged() {
        let (mut state, mut rx) = make_state();
        let (pty_id, _) = state.spawn_pty(24, 80, None, None).unwrap();

        // 원격이 호스트와 같은 사이즈 요청 → PTY 사이즈 변경 없음
        state.resize_pty_remote(&pty_id, 24, 80).unwrap();

        // broadcast 없어야 함
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn host_resize_after_remote_keeps_min_and_broadcasts() {
        let (mut state, mut rx) = make_state();
        let (pty_id, _) = state.spawn_pty(50, 200, None, None).unwrap();

        // 1. 원격 연결 → min(50,24)=24, min(200,80)=80
        state.resize_pty_remote(&pty_id, 24, 80).unwrap();
        let _ = rx.try_recv(); // 첫 broadcast 소비

        // 2. 호스트 fitAddon.fit() → resize_pty(60, 150)
        //    effective = min(60,24)=24, min(150,80)=80 → PTY 미변경
        //    하지만 요청(60,150) ≠ effective(24,80)이므로 PtyResized broadcast 발생
        state.resize_pty(&pty_id, 60, 150).unwrap();

        let msg = rx.try_recv().unwrap();
        match msg {
            ServerMessage::PtyResized { pane_id, rows, cols } => {
                assert_eq!(pane_id, pty_id);
                assert_eq!(rows, 24);
                assert_eq!(cols, 80);
            }
            other => panic!("Expected PtyResized, got {:?}", other),
        }
        assert_eq!(state.effective_pty_size(&pty_id), (24, 80));
    }

    #[test]
    fn host_resize_no_extra_broadcast_when_no_remote() {
        let (mut state, mut rx) = make_state();
        let (pty_id, _) = state.spawn_pty(50, 200, None, None).unwrap();

        // 원격 없이 호스트 리사이즈 → 요청 == effective → 추가 broadcast 없음
        state.resize_pty(&pty_id, 60, 150).unwrap();

        // apply_pty_resize에서 1회 broadcast (PTY 변경됨)
        let msg = rx.try_recv().unwrap();
        match msg {
            ServerMessage::PtyResized { rows, cols, .. } => {
                assert_eq!(rows, 60);
                assert_eq!(cols, 150);
            }
            other => panic!("Expected PtyResized, got {:?}", other),
        }
        // 추가 broadcast 없음
        assert!(rx.try_recv().is_err());
    }
}

