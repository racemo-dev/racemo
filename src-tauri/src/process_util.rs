//! Cross-platform helpers for spawning child processes.
//!
//! The main reason this module exists: on Windows, spawning a console-subsystem
//! program (git, gh, taskkill, powershell, ...) from a GUI app flashes a `cmd`
//! window unless you set `CREATE_NO_WINDOW`. Forgetting that flag has shipped
//! real flicker bugs to users multiple times, so this module centralises the
//! pattern behind a single `.silent()` call on `std::process::Command`.
//!
//! Usage:
//! ```ignore
//! use crate::process_util::SilentCommandExt;
//!
//! let output = std::process::Command::new("git")
//!     .args(["status", "--porcelain"])
//!     .silent()          // <- hides the console window on Windows, no-op elsewhere
//!     .output()?;
//! ```
//!
//! When adding any new child-process spawn, prefer `.silent()` over writing
//! `#[cfg(windows)] cmd.creation_flags(...)` blocks by hand. The trait makes it
//! impossible to forget a platform branch, and it reads correctly on every OS.

use std::process::Command;

/// `CREATE_NO_WINDOW` from `winbase.h`. Keeps the Windows-specific constant
/// inside this module so call sites never have to spell it out.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Extension on `std::process::Command` that hides the console window on
/// Windows. On other platforms this is a no-op so cross-platform call sites
/// can use it unconditionally.
pub trait SilentCommandExt {
    /// Suppress the child process's console window.
    ///
    /// - **Windows**: sets the `CREATE_NO_WINDOW` creation flag, preventing a
    ///   `cmd.exe` host window from briefly flashing when the child is a
    ///   console subsystem program (git, gh, taskkill, powershell, ...).
    /// - **Other platforms**: no-op, returns `self` unchanged.
    ///
    /// Returns `&mut Self` so it can be chained with the rest of the
    /// `Command` builder API (`args`, `env`, `current_dir`, `output`, ...).
    fn silent(&mut self) -> &mut Self;
}

impl SilentCommandExt for Command {
    #[cfg(windows)]
    fn silent(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn silent(&mut self) -> &mut Self {
        self
    }
}

