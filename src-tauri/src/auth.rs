use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const SERVICE_NAME: &str = "com.racemo.app";

// ── Types ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub github_id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub plan: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenResponse {
    pub status: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub user: Option<AuthUser>,
    pub message: Option<String>,
}

#[derive(Debug)]
pub enum AuthError {
    Connection(String),
    InvalidToken(String),
    Server(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Connection(e) => write!(f, "Connection error: {e}"),
            AuthError::InvalidToken(e) => write!(f, "Invalid token: {e}"),
            AuthError::Server(e) => write!(f, "Server error: {e}"),
        }
    }
}

// ── Token Storage (Encrypted File) ──
//
// Tokens are AEAD-encrypted with a key derived from the machine's unique ID.
// This avoids the macOS Keychain password prompt on every dev rebuild while
// still preventing copy-paste attacks (the file cannot be decrypted on another
// machine). Threat model matches Chrome's Safe Storage on Linux: any attacker
// with local read access to both the binary and the token file can decrypt.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

const HKDF_INFO: &[u8] = b"racemo-token-vault-v1";
const NONCE_LEN: usize = 12;

#[derive(Serialize, Deserialize)]
struct TokenVault {
    access_token: Option<String>,
    refresh_token: Option<String>,
    #[serde(default)]
    extras: std::collections::BTreeMap<String, String>,
}

impl TokenVault {
    fn empty() -> Self {
        Self {
            access_token: None,
            refresh_token: None,
            extras: std::collections::BTreeMap::new(),
        }
    }
}

fn token_file_path() -> Result<std::path::PathBuf, String> {
    let dir = dirs::data_local_dir()
        .ok_or_else(|| "no data_local_dir".to_string())?
        .join("racemo");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create vault dir: {e}"))?;
    Ok(dir.join("tokens.bin"))
}

fn derive_key(machine_id: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(SERVICE_NAME.as_bytes()), machine_id.as_bytes());
    let mut okm = [0u8; 32];
    // HKDF-Expand with a 32-byte output never fails for SHA-256.
    hk.expand(HKDF_INFO, &mut okm).expect("HKDF expand");
    okm
}

fn machine_key() -> Result<[u8; 32], String> {
    let id = machine_uid::get().map_err(|e| format!("machine-uid: {e}"))?;
    Ok(derive_key(&id))
}

fn encrypt_vault(key: &[u8; 32], vault: &TokenVault) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = serde_json::to_vec(vault).map_err(|e| format!("serialize vault: {e}"))?;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("encrypt: {e}"))?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_vault(key: &[u8; 32], blob: &[u8]) -> Result<TokenVault, String> {
    if blob.len() < NONCE_LEN {
        return Err("vault blob too short".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt: {e}"))?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("deserialize vault: {e}"))
}

fn read_vault() -> TokenVault {
    let path = match token_file_path() {
        Ok(p) => p,
        Err(e) => {
            log::debug!(target: "auth::vault", "vault path unavailable: {e}");
            return TokenVault::empty();
        }
    };
    let blob = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TokenVault::empty(),
        Err(e) => {
            log::warn!(target: "auth::vault", "failed to read vault file: {e}");
            return TokenVault::empty();
        }
    };
    let key = match machine_key() {
        Ok(k) => k,
        Err(e) => {
            log::warn!(target: "auth::vault", "machine key unavailable: {e}");
            return TokenVault::empty();
        }
    };
    decrypt_vault(&key, &blob).unwrap_or_else(|e| {
        log::warn!(
            target: "auth::vault",
            "vault decrypt failed; treating as empty (user may need to re-login): {e}"
        );
        TokenVault::empty()
    })
}

fn write_vault(vault: &TokenVault) -> Result<(), String> {
    let path = token_file_path()?;
    let key = machine_key()?;
    let blob = encrypt_vault(&key, vault)?;
    // 원자적 교체: .tmp 로 쓰고 rename.
    let tmp_path = path.with_extension("bin.tmp");

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("open vault: {e}"))?;
        std::io::Write::write_all(&mut f, &blob).map_err(|e| format!("write vault: {e}"))?;
        // 디렉토리 권한도 제한(0700) — 부모 디렉토리 리스팅 방지.
        if let Some(parent) = path.parent() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    #[cfg(windows)]
    {
        write_vault_windows(&tmp_path, &blob)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::write(&tmp_path, &blob).map_err(|e| format!("write vault: {e}"))?;
    }

    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("rename vault: {e}"))?;
    Ok(())
}

/// Windows에서 토큰 파일을 CurrentUser 전용으로 기록.
/// - `icacls`로 상속 끊고 소유자에게만 접근 부여.
/// - 실패해도 write 자체는 진행 (기본 사용자 프로필 ACL로 fallback).
///   프로필 디렉토리는 일반적으로 SYSTEM/Administrators/해당 사용자만 접근 가능.
#[cfg(windows)]
fn write_vault_windows(tmp_path: &std::path::Path, blob: &[u8]) -> Result<(), String> {
    std::fs::write(tmp_path, blob).map_err(|e| format!("write vault: {e}"))?;

    // icacls 로 ACL 제한: 상속 제거, SYSTEM과 현재 사용자만 Full Control.
    let path_str = tmp_path
        .to_str()
        .ok_or_else(|| "vault path not utf-8".to_string())?;

    // 현재 사용자명을 %USERNAME% 환경변수에서 가져옴. 없으면 기본 ACL 유지.
    // Windows 사용자명은 일반적으로 [A-Za-z0-9 .-_]만 허용. 비정상 문자가 있으면
    // icacls에 이상하게 파싱될 수 있으므로 화이트리스트 이외는 skip(기본 ACL 사용).
    if let Ok(user) = std::env::var("USERNAME") {
        if !user.is_empty() && is_safe_windows_username(&user) {
            use std::process::Command;
            // 상속 제거 (/inheritance:r), 기존 ACL 제거, SYSTEM / 사용자에게만 F(Full) 부여.
            // Command::args는 배열로 전달되므로 shell quoting 문제는 없으나,
            // icacls 자체의 args 파싱 안전성을 위해 username은 사전 검증.
            match Command::new("icacls")
                .args([
                    path_str,
                    "/inheritance:r",
                    "/grant:r",
                    &format!("{user}:(F)"),
                    "/grant:r",
                    "SYSTEM:(F)",
                ])
                .output()
            {
                Ok(out) if !out.status.success() => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    log::warn!(
                        target: "auth::vault",
                        code = ?out.status.code(),
                        "icacls failed to tighten vault ACL; file may be world-readable: {stderr}"
                    );
                }
                Err(e) => {
                    log::warn!(
                        target: "auth::vault",
                        "could not spawn icacls; vault ACL not hardened: {e}"
                    );
                }
                Ok(_) => {}
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_safe_windows_username(s: &str) -> bool {
    // SAM 계정명 규칙: 길이 1-20, 제어 문자·`" / \ [ ] : ; | = , + * ? < >` 금지.
    // 보수적으로 영숫자/공백/점/하이픈/언더스코어만 허용.
    if s.len() > 64 {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_')
    })
}

fn save_tokens(_app: &AppHandle, access_token: &str, refresh_token: &str) -> Result<(), String> {
    let mut vault = read_vault();
    vault.access_token = Some(access_token.to_string());
    vault.refresh_token = Some(refresh_token.to_string());
    write_vault(&vault)
}

fn load_tokens(_app: &AppHandle) -> (Option<String>, Option<String>) {
    let vault = read_vault();
    (vault.access_token, vault.refresh_token)
}

fn clear_tokens(_app: &AppHandle) {
    if let Ok(path) = token_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn set_extra(key: &str, value: &str) -> Result<(), String> {
    let mut vault = read_vault();
    vault.extras.insert(key.to_string(), value.to_string());
    write_vault(&vault)
}

// ── JWT Decode (client-side, UNVERIFIED — display/UI hints only) ──
//
// SECURITY WARNING: 이 파일의 JWT 디코딩 함수들은 **서명을 검증하지 않습니다**.
// 클라이언트가 자신의 토큰에서 `login`/`plan` 등의 정보를 꺼내는 용도로만 사용합니다.
//
// 절대 해선 안 되는 것:
//   - 이 값으로 기능 게이팅(예: "pro만 허용") 결정
//   - 이 값으로 보안 경계 판단(권한, 쿼터)
//   - 다른 사용자의 JWT를 받아 해석
//
// 모든 권한 결정은 서버가 서명을 검증한 후 내려주는 응답에 기반해야 합니다.

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let b64 = input.replace('-', "+").replace('_', "/");
    let padded = match b64.len() % 4 {
        2 => format!("{b64}=="),
        3 => format!("{b64}="),
        _ => b64,
    };

    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for &byte in padded.as_bytes() {
        if byte == b'=' {
            break;
        }
        let val = TABLE.iter().position(|&c| c == byte)? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(output)
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let bytes = base64url_decode(parts[1])?;
    serde_json::from_slice(&bytes).ok()
}

fn jwt_to_user(token: &str) -> Option<AuthUser> {
    let json = decode_jwt_payload(token)?;
    let obj = json.as_object()?;

    Some(AuthUser {
        id: obj.get("sub")?.as_i64()?,
        github_id: obj.get("github_id")?.as_i64()?,
        login: obj.get("login")?.as_str()?.to_string(),
        name: obj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
        avatar_url: obj.get("avatar_url").and_then(|v| v.as_str()).map(|s| s.to_string()),
        plan: obj.get("plan")?.as_str()?.to_string(),
    })
}

pub fn jwt_expired(token: &str) -> bool {
    let json = match decode_jwt_payload(token) {
        Some(j) => j,
        None => return true,
    };
    let exp = match json.get("exp").and_then(|v| v.as_i64()) {
        Some(e) => e,
        None => return true,
    };
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return true, // clock error → treat as expired
    };
    exp <= now
}

/// Decode the login (GitHub username) from a JWT without verification.
/// UI 표시용입니다. 권한 결정에 절대 사용 금지.
pub fn login_from_jwt(jwt: &str) -> Option<String> {
    jwt_to_user(jwt).map(|u| u.login)
}

/// Decode the plan from a JWT without verification.
///
/// SECURITY: 이 값은 서명 검증 없이 페이로드를 그대로 디코드한 것이므로
/// 공격자가 자기 토큰을 조작하면 `pro`/`enterprise`로 위조할 수 있습니다.
/// 반드시 UI 힌트·로깅 용도로만 사용하세요. 실제 쿼터/권한은 서버가 검증해서
/// 응답 메시지(DeviceRegistered 등)에 포함해 내려주는 값을 사용해야 합니다.
pub fn plan_from_jwt(jwt: &str) -> Option<String> {
    jwt_to_user(jwt).map(|u| u.plan)
}

pub fn get_device_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| {
            // macOS/Linux: read /etc/hostname or use "Racemo Desktop"
            std::fs::read_to_string("/etc/hostname")
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| "Racemo Desktop".to_string())
        })
}

/// Return the device name used when registering with the signaling server.
#[tauri::command]
pub fn get_current_device_name() -> String {
    get_device_name()
}

// ── Tauri Commands ──

/// Start GitHub Device Flow.
#[tauri::command]
pub async fn auth_start_device_flow() -> Result<DeviceCodeResponse, String> {
    let base_url = crate::remote::DEFAULT_SIGNALING_BASE_URL;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    let res = client
        .post(format!("{base_url}/auth/device-code"))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Server error: {body}"));
    }

    res.json::<DeviceCodeResponse>()
        .await
        .map_err(|e| format!("Parse error: {e}"))
}

/// Poll for token after user enters code in browser.
#[tauri::command]
pub async fn auth_poll_token(
    app: AppHandle,
    device_code: String,
) -> Result<TokenResponse, String> {
    let base_url = crate::remote::DEFAULT_SIGNALING_BASE_URL;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    let res = client
        .post(format!("{base_url}/auth/token"))
        .json(&serde_json::json!({
            "device_code": device_code,
            "device_name": get_device_name()
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let token_res: TokenResponse = res
        .json()
        .await
        .map_err(|e| format!("Parse error: {e}"))?;

    if let (Some(ref access), Some(ref refresh)) =
        (&token_res.access_token, &token_res.refresh_token)
    {
        save_tokens(&app, access, refresh)?;
    }

    Ok(token_res)
}

/// Get current authenticated user from stored JWT.
#[tauri::command]
pub async fn auth_get_current_user(
    app: AppHandle,
) -> Result<Option<AuthUser>, String> {
    let (access, refresh) = load_tokens(&app);

    // Try existing access token
    if let Some(ref token) = access {
        if !jwt_expired(token) {
            if let Some(user) = jwt_to_user(token) {
                return Ok(Some(user));
            }
        }
    }

    // Token expired — try refresh
    if let Some(ref refresh_token) = refresh {
        match try_refresh(&app, refresh_token).await {
            Ok(user) => return Ok(Some(user)),
            Err(AuthError::InvalidToken(_)) => clear_tokens(&app),
            Err(e) => {
                log::error!("Auth check failed: {}", e);
                // Keep tokens if it's a connection or server error
            }
        }
    }

    Ok(None)
}

/// Logout.
#[tauri::command]
pub async fn auth_logout(app: AppHandle) -> Result<(), String> {
    let (_, refresh) = load_tokens(&app);

    if let Some(ref refresh_token) = refresh {
        let base_url = crate::remote::DEFAULT_SIGNALING_BASE_URL;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .map_err(|e| format!("Failed to create client: {e}"))?;
        let _ = client
            .post(format!("{base_url}/auth/logout"))
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await;
    }

    clear_tokens(&app);
    Ok(())
}


// ── Account-based Device Commands ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub os: Option<String>,
    pub online: bool,
    pub sessions: Vec<serde_json::Value>,
}

/// Get a valid access token (refreshing if needed).
pub async fn get_valid_access_token(app: &AppHandle) -> Result<String, String> {
    let (access, refresh) = load_tokens(app);

    if let Some(ref token) = access {
        if !jwt_expired(token) {
            return Ok(token.clone());
        }
    }

    // Token expired — try refresh
    if let Some(ref refresh_token) = refresh {
        match try_refresh(app, refresh_token).await {
            Ok(_) => {
                let (new_access, _) = load_tokens(app);
                return new_access.ok_or_else(|| "No access token after refresh".to_string());
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    Err("Not authenticated".to_string())
}

/// Fetch user's online devices from signaling server.
#[tauri::command]
pub async fn fetch_my_devices(
    app: AppHandle,
) -> Result<Vec<RemoteDevice>, String> {
    let access_token = get_valid_access_token(&app).await?;
    let base_url = crate::remote::DEFAULT_SIGNALING_BASE_URL;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create client: {e}"))?;

    let res = client
        .get(format!("{base_url}/auth/me/devices"))
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Server error: {body}"));
    }

    res.json::<Vec<RemoteDevice>>()
        .await
        .map_err(|e| format!("Parse error: {e}"))
}

/// Connect to a specific device (account-based, for the frontend to call).
/// The actual WS connection happens in the remote module, this just stores the intent.
#[tauri::command]
pub async fn connect_to_device(
    app: AppHandle,
    device_id: String,
) -> Result<(), String> {
    let access_token = get_valid_access_token(&app).await?;
    // Stash alongside tokens in the encrypted vault.
    set_extra("pending_access_token", &access_token)?;
    set_extra("pending_device_id", &device_id)?;
    Ok(())
}

/// Get the current access token (for remote module to establish WS with JWT).
#[tauri::command]
pub async fn auth_get_access_token(
    app: AppHandle,
) -> Result<Option<String>, String> {
    match get_valid_access_token(&app).await {
        Ok(token) => Ok(Some(token)),
        Err(_) => Ok(None),
    }
}

// ── Internal ──

async fn try_refresh(app: &AppHandle, refresh_token: &str) -> Result<AuthUser, AuthError> {
    let base_url = crate::remote::DEFAULT_SIGNALING_BASE_URL;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| AuthError::Server(format!("Failed to create client: {e}")))?;

    let res = client
        .post(format!("{base_url}/auth/refresh"))
        .json(&serde_json::json!({
            "refresh_token": refresh_token,
            "device_name": get_device_name()
        }))
        .send()
        .await
        .map_err(|e| AuthError::Connection(e.to_string()))?;

    if res.status() == axum::http::StatusCode::UNAUTHORIZED {
        return Err(AuthError::InvalidToken("Refresh token expired or invalid".to_string()));
    }

    if !res.status().is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AuthError::Server(body));
    }

    let token_res: TokenResponse = res
        .json()
        .await
        .map_err(|e| AuthError::Server(format!("Parse error: {e}")))?;

    if let (Some(ref access), Some(ref refresh)) =
        (&token_res.access_token, &token_res.refresh_token)
    {
        save_tokens(app, access, refresh).map_err(AuthError::Server)?;
    }

    token_res.user.ok_or_else(|| AuthError::Server("No user in response".to_string()))
}

#[cfg(test)]
mod vault_tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = derive_key("machine-A");
        let vault = TokenVault {
            access_token: Some("access-abc".to_string()),
            refresh_token: Some("refresh-xyz".to_string()),
            extras: [("pending_device_id".to_string(), "dev-1".to_string())]
                .into_iter()
                .collect(),
        };
        let blob = encrypt_vault(&key, &vault).unwrap();
        let decrypted = decrypt_vault(&key, &blob).unwrap();
        assert_eq!(decrypted.access_token.as_deref(), Some("access-abc"));
        assert_eq!(decrypted.refresh_token.as_deref(), Some("refresh-xyz"));
        assert_eq!(decrypted.extras.get("pending_device_id").map(String::as_str), Some("dev-1"));
    }

    #[test]
    fn different_machine_key_cannot_decrypt() {
        let key_a = derive_key("machine-A");
        let key_b = derive_key("machine-B");
        let vault = TokenVault {
            access_token: Some("secret".to_string()),
            refresh_token: None,
            extras: Default::default(),
        };
        let blob = encrypt_vault(&key_a, &vault).unwrap();
        assert!(decrypt_vault(&key_b, &blob).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = derive_key("machine-A");
        let vault = TokenVault {
            access_token: Some("secret".to_string()),
            refresh_token: None,
            extras: Default::default(),
        };
        let mut blob = encrypt_vault(&key, &vault).unwrap();
        // Flip a byte in the ciphertext (after the 12-byte nonce).
        blob[NONCE_LEN + 2] ^= 0xff;
        assert!(decrypt_vault(&key, &blob).is_err());
    }

    #[test]
    fn blob_shorter_than_nonce_errors() {
        let key = derive_key("machine-A");
        let blob = vec![0u8; 5];
        assert!(decrypt_vault(&key, &blob).is_err());
    }

    #[test]
    fn derive_key_is_deterministic() {
        assert_eq!(derive_key("same"), derive_key("same"));
        assert_ne!(derive_key("a"), derive_key("b"));
    }
}
