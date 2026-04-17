//! Cross-platform self-updater.
//!
//! Replaces Tauri's built-in updater so that `latest.json` can point directly
//! at raw platform artifacts (`.AppImage`, `.dmg`, `-setup.exe`) instead of
//! compressed wrappers (`.tar.gz`, `.nsis.zip`). This halves the release
//! asset count and removes the need for intermediary archive formats.
//!
//! ## Platform-specific install strategies
//!
//! | Platform | Artifact | Install method |
//! |----------|----------|----------------|
//! | Linux    | `.AppImage` | Atomic rename over the running binary |
//! | macOS    | `.dmg` | `hdiutil attach` → copy `.app` → detach |
//! | Windows  | `-setup.exe` | Run the NSIS installer with `/S` (silent) |

use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Write;
#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// The public key used to verify update signatures.
///
/// Must stay byte-identical to `plugins.updater.pubkey` in `tauri.conf.json`.
/// The consistency test `pubkey_matches_tauri_conf` enforces this — if you
/// rotate the signing key, update both locations and let the test confirm
/// they match.
const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI3NUQxQjI4OTk2RkQwRjkKUlVUNTBHK1pLQnRkdDRPVG1jLzVubkdPTWg5WDNFdHRFZHVTMHdpcC9jSzR6cE5wZUZYWk5yRHQK";

#[derive(Debug, Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct LatestManifest {
    version: String,
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    pub signature: String,
}

fn platform_key() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "linux-x86_64" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "linux-aarch64" }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-aarch64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "windows-x86_64" }
}

const ENDPOINT: &str =
    "https://github.com/racemo-dev/racemo/releases/latest/download/latest.json";

// ── Check ──

pub async fn check(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let manifest: LatestManifest = client
        .get(ENDPOINT)
        .send()
        .await
        .map_err(|e| format!("fetch latest.json: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse latest.json: {e}"))?;

    if !is_newer_version(&manifest.version, current_version) {
        return Ok(None);
    }

    let key = platform_key();
    let entry = manifest
        .platforms
        .get(key)
        .ok_or_else(|| format!("no entry for {key} in latest.json"))?;

    Ok(Some(UpdateInfo {
        version: manifest.version,
        url: entry.url.clone(),
        signature: entry.signature.clone(),
    }))
}

/// Compare versions numerically (e.g. "0.0.10" > "0.0.9").
fn is_newer_version(remote: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    let r = parse(remote);
    let c = parse(current);
    for i in 0..r.len().max(c.len()) {
        let rv = r.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if rv > cv { return true; }
        if rv < cv { return false; }
    }
    false
}

// ── Download + Verify + Install ──

pub async fn download_and_install(info: &UpdateInfo, app: &AppHandle) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let resp = client
        .get(&info.url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download returned {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let _ = app.emit("app-update-progress", serde_json::json!({
        "event": "Started", "total": total,
    }));

    // Stream to a temp file
    let tmp_dir = std::env::temp_dir().join("racemo-update");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir: {e}"))?;

    let filename = info
        .url
        .rsplit('/')
        .next()
        .unwrap_or("racemo-update-artifact");
    let tmp_path = tmp_dir.join(filename);

    let mut file =
        std::fs::File::create(&tmp_path).map_err(|e| format!("create temp: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("app-update-progress", serde_json::json!({
            "event": "Progress", "downloaded": downloaded, "total": total,
        }));
    }
    drop(file);

    // Verify signature
    verify_signature(&tmp_path, &info.signature)?;

    // Platform-specific install
    install_platform(&tmp_path)?;

    // Cleanup — skip on Windows where the detached batch script still needs the installer
    #[cfg(not(target_os = "windows"))]
    let _ = std::fs::remove_dir_all(&tmp_dir);

    log::info!("[updater] Updated to v{}", info.version);
    Ok(())
}

// ── Platform-specific Install ──

#[cfg(target_os = "linux")]
fn install_platform(artifact: &std::path::Path) -> Result<(), String> {
    let original = std::env::var("APPIMAGE")
        .map(PathBuf::from)
        .map_err(|_| "APPIMAGE env not set — not running as AppImage".to_string())?;

    let install_dir = original.parent()
        .ok_or_else(|| "cannot determine AppImage directory".to_string())?;
    let dest = install_dir.join("Racemo.AppImage");

    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(artifact, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("chmod: {e}"))?;

    // Rename the running AppImage out of the way ONLY at the last moment,
    // so we can recover if anything fails earlier (download, signature, etc.).
    // `prepare_update` may have already done this — check before renaming.
    let original_bak = original.with_extension("bak");
    if original.exists() {
        let _ = std::fs::remove_file(&original_bak);
        std::fs::rename(&original, &original_bak)
            .map_err(|e| format!("rename running AppImage: {e}"))?;
        log::info!("[updater:linux] Moved running binary: {} → {}", original.display(), original_bak.display());
    }
    // Also move dest if it differs from original and exists
    let dest_bak = dest.with_extension("bak");
    if dest != original && dest.exists() {
        let _ = std::fs::remove_file(&dest_bak);
        let _ = std::fs::rename(&dest, &dest_bak);
    }

    // Copy artifact to dest (rename likely fails: /tmp is usually a different fs)
    let install_result = std::fs::rename(artifact, &dest)
        .or_else(|_| {
            std::fs::copy(artifact, &dest).map(|_| ()).map_err(|e| format!("copy: {e}"))
        });

    if let Err(e) = install_result {
        // ROLLBACK: restore the original binary
        log::error!("[updater:linux] Install failed, rolling back: {e}");
        if original_bak.exists() {
            let _ = std::fs::rename(&original_bak, &original);
        }
        if dest_bak.exists() && !dest.exists() {
            let _ = std::fs::rename(&dest_bak, &dest);
        }
        return Err(format!("install failed (rolled back): {e}"));
    }

    // Success — clean up .bak files and old versioned AppImage
    let _ = std::fs::remove_file(&original_bak);
    let _ = std::fs::remove_file(&dest_bak);
    if original != dest && original.exists() {
        let _ = std::fs::remove_file(&original);
    }
    // Clean up temp artifact if copy was used (rename would have moved it)
    if artifact.exists() {
        let _ = std::fs::remove_file(artifact);
    }

    log::info!("[updater:linux] Installed to {}", dest.display());
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_platform(artifact: &std::path::Path) -> Result<(), String> {
    let mount = std::env::temp_dir().join("racemo-dmg-mount");
    let _ = std::fs::create_dir_all(&mount);

    let art = artifact.to_str().unwrap_or("");
    let mnt = mount.to_str().unwrap_or("");

    // Mount DMG
    let status = std::process::Command::new("hdiutil")
        .args(["attach", art, "-mountpoint", mnt, "-nobrowse", "-quiet"])
        .status()
        .map_err(|e| format!("hdiutil attach: {e}"))?;
    if !status.success() {
        return Err("hdiutil attach failed".to_string());
    }

    let app_src = mount.join("Racemo.app");
    if !app_src.exists() {
        let _ = std::process::Command::new("hdiutil")
            .args(["detach", mnt, "-quiet"])
            .status();
        return Err("Racemo.app not found in DMG".to_string());
    }

    let dest = PathBuf::from("/Applications/Racemo.app");
    let backup = std::env::temp_dir().join("racemo-app-backup");

    // Backup current app before replacing (rollback on failure)
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&backup);
        if let Err(e) = std::fs::rename(&dest, &backup) {
            log::warn!("[updater:macos] Backup rename failed ({e}), trying rm+ditto without privileges");
            // Try rm+ditto without privilege escalation first (works when user owns /Applications/Racemo.app)
            // ditto preserves code signatures and extended attributes unlike cp -R
            // Use separate Command calls to avoid shell injection via sh -c
            let rm_ok = std::process::Command::new("rm")
                .args(["-rf", dest.to_str().unwrap()])
                .status()
                .is_ok_and(|s| s.success());
            let ditto_ok = rm_ok && std::process::Command::new("ditto")
                .args([app_src.to_str().unwrap(), dest.to_str().unwrap()])
                .status()
                .is_ok_and(|s| s.success());
            if ditto_ok {
                let _ = std::process::Command::new("hdiutil")
                    .args(["detach", mnt, "-quiet"])
                    .status();
                let _ = std::fs::remove_dir_all(&backup);
                let _ = std::process::Command::new("touch").arg(dest.to_str().unwrap()).status();
                log::info!("[updater:macos] Installed via rm+ditto {}", dest.display());
                return Ok(());
            }
            if rm_ok {
                // rm succeeded but ditto failed — restore backup to avoid data loss
                log::error!("[updater:macos] ditto failed after rm, restoring backup");
                let restore = std::process::Command::new("ditto")
                    .args([backup.to_str().unwrap(), dest.to_str().unwrap()])
                    .status();
                if restore.as_ref().map_or(true, |s| !s.success()) {
                    log::error!("[updater:macos] Rollback also failed! Manual recovery: {}", backup.display());
                }
            }
            // Last resort: AppleScript privilege escalation
            log::warn!("[updater:macos] rm+ditto failed, escalating with osascript");
            let script = format!(
                "do shell script \"rm -rf '{dest}' && ditto '{src}' '{dest}'\" with administrator privileges",
                dest = dest.display(),
                src = app_src.display(),
            );
            let osa = std::process::Command::new("osascript")
                .args(["-e", &script])
                .status()
                .map_err(|e| format!("osascript: {e}"))?;
            let _ = std::process::Command::new("hdiutil")
                .args(["detach", mnt, "-quiet"])
                .status();
            if !osa.success() {
                return Err("Failed to install with administrator privileges".to_string());
            }
            let _ = std::fs::remove_dir_all(&backup);
            let _ = std::process::Command::new("touch").arg(dest.to_str().unwrap()).status();
            log::info!("[updater:macos] Installed via osascript {}", dest.display());
            return Ok(());
        }
    }

    // Copy new app (ditto preserves code signatures and extended attributes)
    let cp = std::process::Command::new("ditto")
        .args([app_src.to_str().unwrap(), dest.to_str().unwrap()])
        .status()
        .map_err(|e| format!("cp: {e}"))?;

    // Unmount
    let _ = std::process::Command::new("hdiutil")
        .args(["detach", mnt, "-quiet"])
        .status();

    if !cp.success() {
        // ROLLBACK: restore backup
        if backup.exists() {
            log::error!("[updater:macos] cp failed, rolling back");
            let _ = std::fs::rename(&backup, &dest);
        }
        return Err("Failed to copy Racemo.app".to_string());
    }

    // Success — remove backup and update modification time
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::process::Command::new("touch").arg(dest.to_str().unwrap()).status();

    log::info!("[updater:macos] Installed {}", dest.display());
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_platform(artifact: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe path: {e}"))?;

    // Write a temporary batch script that:
    // 1. Runs the NSIS installer silently (blocks until completion)
    // 2. Launches the newly installed exe
    // 3. Deletes itself
    //
    // This script is spawned as a DETACHED process so it survives when
    // NSIS kills our process during installation (nsProcess::KillProcess).
    let bat = artifact.with_extension("bat");
    let content = format!(
        "@echo off\r\n\"{installer}\" /S\r\nstart \"\" \"{exe}\"\r\ndel \"%~f0\"\r\n",
        installer = artifact.display(),
        exe = exe.display(),
    );
    std::fs::write(&bat, &content)
        .map_err(|e| format!("Failed to write update script: {e}"))?;

    std::process::Command::new("cmd")
        .arg("/C")
        .arg(&bat)
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn update script: {e}"))?;

    log::info!("[updater:windows] Spawned detached installer + relaunch script");
    Ok(())
}

// ── Signature Verification ──

fn verify_signature(file_path: &std::path::Path, sig_base64: &str) -> Result<(), String> {
    let sig_bytes = base64_decode(sig_base64)?;
    let sig_str =
        String::from_utf8(sig_bytes).map_err(|e| format!("signature not UTF-8: {e}"))?;
    let signature =
        Signature::decode(&sig_str).map_err(|e| format!("decode signature: {e}"))?;

    // UPDATER_PUBKEY may be base64-wrapped (Tauri format) or raw minisign.
    let pk_text = if UPDATER_PUBKEY.trim().starts_with("untrusted comment:") {
        UPDATER_PUBKEY.to_string()
    } else {
        let decoded = base64_decode(UPDATER_PUBKEY.trim())?;
        String::from_utf8(decoded).map_err(|e| format!("pubkey not UTF-8: {e}"))?
    };
    let pk_str = pk_text
        .lines()
        .find(|l| !l.starts_with("untrusted comment:") && !l.is_empty())
        .ok_or("no public key line found")?;
    let pk = PublicKey::from_base64(pk_str).map_err(|e| format!("decode pubkey: {e}"))?;

    let file_bytes =
        std::fs::read(file_path).map_err(|e| format!("read for verify: {e}"))?;
    pk.verify(&file_bytes, &signature, false)
        .map_err(|e| format!("signature verification failed: {e}"))?;

    log::info!("[updater] Signature verified OK");
    Ok(())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input = input.trim();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input.as_bytes() {
        if byte == b'=' { break; }
        if byte == b'\n' || byte == b'\r' || byte == b' ' { continue; }
        let val = TABLE
            .iter()
            .position(|&c| c == byte)
            .ok_or_else(|| format!("invalid base64: {}", byte as char))? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn check_app_update() -> Result<Option<UpdateInfo>, String> {
    let current = env!("CARGO_PKG_VERSION");
    log::info!("[updater] Checking for updates (current: v{current})");
    match check(current).await {
        Ok(Some(ref info)) => {
            log::info!("[updater] Update available: v{} -> {}", info.version, info.url);
            Ok(Some(info.clone()))
        }
        Ok(None) => {
            log::info!("[updater] Already up to date");
            Ok(None)
        }
        Err(ref e) => {
            log::error!("[updater] Check failed: {e}");
            Err(e.clone())
        }
    }
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    url: String,
    signature: String,
    version: String,
) -> Result<(), String> {
    log::info!("[updater] Installing update v{version} from {url}");
    let info = UpdateInfo { version, url, signature };
    download_and_install(&info, &app).await
}

/// Relaunch the app after update.
/// - Linux: exec the normalized Racemo.AppImage path (original may have been versioned)
/// - Windows: no-op — let NSIS kill us; the detached batch script handles relaunch
/// - macOS: standard restart
#[tauri::command]
#[allow(unused_variables)]
pub fn relaunch_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(appimage) = std::env::var("APPIMAGE") {
            let original = PathBuf::from(&appimage);
            let install_dir = original.parent().unwrap_or(std::path::Path::new("."));
            let normalized = install_dir.join("Racemo.AppImage");
            if normalized.exists() && normalized != original {
                log::info!("[updater] Relaunching from {}", normalized.display());
                match std::process::Command::new(&normalized).spawn() {
                    Ok(_) => { app.exit(0); return Ok(()); }
                    Err(e) => {
                        log::error!("[updater] Failed to spawn {}: {e}", normalized.display());
                        // Fall through to default restart
                    }
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows, don't exit here. Let NSIS kill our process — it does
        // so right before replacing files, which minimizes the visible gap
        // between the old app disappearing and the new app launching.
        // The detached batch script (from install_platform) handles relaunch.
        log::info!("[updater] Windows: waiting for NSIS to terminate us");
        return Ok(());
    }
    // macOS: use `open` to launch the app in foreground (app.restart() leaves it in background)
    #[cfg(target_os = "macos")]
    {
        log::info!("[updater] macOS: relaunching via open");
        match std::process::Command::new("open")
            .args(["-a", "Racemo", "--new", "--fresh"])
            .spawn()
        {
            Ok(_) => { app.exit(0); return Ok(()); }
            Err(e) => {
                log::error!("[updater] open -a Racemo failed: {e}");
            }
        }
    }
    // Fallback
    #[allow(unreachable_code)]
    {
        app.restart();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decode_works() {
        assert_eq!(base64_decode("SGVsbG8gV29ybGQ=").unwrap(), b"Hello World");
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
    }

    #[test]
    fn pubkey_decodes_successfully() {
        let pk_text = if UPDATER_PUBKEY.trim().starts_with("untrusted comment:") {
            UPDATER_PUBKEY.to_string()
        } else {
            let decoded = base64_decode(UPDATER_PUBKEY.trim()).expect("base64 decode");
            String::from_utf8(decoded).expect("utf8")
        };
        eprintln!("pk_text: {:?}", pk_text);
        let pk_str = pk_text
            .lines()
            .find(|l| !l.starts_with("untrusted comment:") && !l.is_empty())
            .expect("key line");
        eprintln!("pk_str: {:?}", pk_str);
        let _pk = PublicKey::from_base64(pk_str).expect("decode pubkey");
    }

    #[test]
    fn version_comparison_is_numeric() {
        assert!(is_newer_version("0.0.10", "0.0.9"));
        assert!(is_newer_version("0.1.0", "0.0.99"));
        assert!(is_newer_version("1.0.0", "0.99.99"));
        assert!(!is_newer_version("0.0.6", "0.0.6"));
        assert!(!is_newer_version("0.0.5", "0.0.6"));
        assert!(is_newer_version("0.0.7", "0.0.6"));
    }

    #[test]
    fn platform_key_is_known() {
        let key = platform_key();
        assert!(
            ["linux-x86_64", "linux-aarch64", "darwin-aarch64", "darwin-x86_64", "windows-x86_64"]
                .contains(&key),
            "unexpected: {key}"
        );
    }

    /// Guards against rotating the signing key in `tauri.conf.json` without
    /// updating `UPDATER_PUBKEY` (or vice versa). If this fails after a key
    /// rotation, sync both values to the new key.
    #[test]
    fn pubkey_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("parse tauri.conf.json");
        let conf_pubkey = conf["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("plugins.updater.pubkey must be a string");
        assert_eq!(
            UPDATER_PUBKEY.trim(),
            conf_pubkey.trim(),
            "UPDATER_PUBKEY must match plugins.updater.pubkey in tauri.conf.json"
        );
    }
}
