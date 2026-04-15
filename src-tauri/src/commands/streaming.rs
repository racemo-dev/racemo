use crate::process_util::SilentCommandExt;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

fn pids() -> &'static Mutex<HashMap<String, u32>> {
    PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(channel_id: &str, pid: u32) {
    if let Ok(mut map) = pids().lock() {
        map.insert(channel_id.to_string(), pid);
    }
}

pub fn unregister(channel_id: &str) {
    if let Ok(mut map) = pids().lock() {
        map.remove(channel_id);
    }
}

pub fn kill(channel_id: &str) {
    let pid = {
        if let Ok(mut map) = pids().lock() {
            map.remove(channel_id)
        } else {
            return;
        }
    };
    if let Some(pid) = pid {
        kill_pid(pid);
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .silent()
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .silent()
            .output();
    }
}
