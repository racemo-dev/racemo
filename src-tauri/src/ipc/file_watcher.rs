use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use notify::RecursiveMode;
use tokio::sync::broadcast;

use crate::ipc::protocol::FsChangeEvent;

/// Lightweight file system watcher that monitors only specified directories and files.
/// Uses non-recursive watching to minimize resource usage.
pub struct FileWatcher {
    debouncer: Debouncer<notify::RecommendedWatcher>,
    /// Directories successfully registered with the watcher.
    watched_dirs: HashSet<PathBuf>,
    watched_file: Option<PathBuf>,
}

impl FileWatcher {
    /// Create a new FileWatcher. Change events are broadcast via `event_tx`.
    pub fn new(event_tx: broadcast::Sender<Vec<FsChangeEvent>>) -> Result<Self, String> {
        let tx = event_tx.clone();
        let (notify_tx, notify_rx) = mpsc::channel();

        let debouncer = new_debouncer(Duration::from_millis(300), notify_tx)
            .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        // Spawn a thread to read debounced events and forward to broadcast
        std::thread::Builder::new()
            .name("fs-watcher".into())
            .spawn(move || {
                while let Ok(result) = notify_rx.recv() {
                    match result {
                        Ok(events) => {
                            let mut seen = HashSet::new();
                            let fs_events: Vec<FsChangeEvent> = events
                                .into_iter()
                                .filter_map(|e| {
                                    let path = e.path.to_string_lossy().to_string();
                                    if !seen.insert(path.clone()) {
                                        return None;
                                    }
                                    let kind = match e.kind {
                                        DebouncedEventKind::Any => "modified",
                                        _ => return None,
                                    };
                                    Some(FsChangeEvent {
                                        path,
                                        kind: kind.to_string(),
                                    })
                                })
                                .collect();
                            if !fs_events.is_empty() {
                                let _ = tx.send(fs_events);
                            }
                        }
                        Err(errs) => {
                            log::warn!("[fs-watcher] errors: {errs:?}");
                        }
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn watcher thread: {e}"))?;

        Ok(Self {
            debouncer,
            watched_dirs: HashSet::new(),
            watched_file: None,
        })
    }

    /// Update watched directories. Computes diff and only adds/removes changed paths.
    /// NOTE: On macOS, calling unwatch() on a path that was never successfully watched
    /// triggers CFRelease(NULL) inside the FSEvents backend, causing a SIGTRAP crash.
    /// We track only successfully-watched paths to avoid this.
    pub fn update_dirs(&mut self, new_dirs: Vec<String>) {
        let new_set: HashSet<PathBuf> = new_dirs.into_iter().map(PathBuf::from).collect();

        // Unwatch removed dirs — only those in watched_dirs (i.e. successfully watched)
        let to_remove: Vec<PathBuf> = self.watched_dirs.difference(&new_set).cloned().collect();
        for dir in &to_remove {
            if let Err(e) = self.debouncer.watcher().unwatch(dir) {
                log::trace!("[fs-watcher] unwatch failed for {}: {e}", dir.display());
            }
            self.watched_dirs.remove(dir);
        }

        // Watch new dirs (non-recursive) — only add to watched_dirs on success
        let to_add: Vec<PathBuf> = new_set.difference(&self.watched_dirs).cloned().collect();
        for dir in to_add {
            if dir.is_dir() {
                match self.debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive) {
                    Ok(()) => {
                        self.watched_dirs.insert(dir);
                    }
                    Err(e) => {
                        log::trace!("[fs-watcher] watch failed for {}: {e}", dir.display());
                    }
                }
            }
        }
    }

    /// Update watched editor file.
    pub fn update_file(&mut self, file: Option<String>) {
        let new_path = file.map(PathBuf::from);

        // Unwatch old file (only if currently watched)
        if let Some(ref old) = self.watched_file {
            if new_path.as_ref() != Some(old) {
                let _ = self.debouncer.watcher().unwatch(old);
            }
        }

        // Watch new file — only store on success
        let mut actually_watched = None;
        if let Some(ref path) = new_path {
            if self.watched_file.as_ref() != Some(path) && path.is_file() {
                match self.debouncer.watcher().watch(path, RecursiveMode::NonRecursive) {
                    Ok(()) => actually_watched = new_path,
                    Err(e) => {
                        log::trace!("[fs-watcher] watch file failed for {}: {e}", path.display());
                    }
                }
            } else {
                // Path unchanged or not a file — keep previous state
                actually_watched = new_path;
            }
        }

        self.watched_file = actually_watched;
    }

    /// Clear all watches.
    pub fn clear(&mut self) {
        for dir in self.watched_dirs.drain() {
            let _ = self.debouncer.watcher().unwatch(&dir);
        }
        if let Some(file) = self.watched_file.take() {
            let _ = self.debouncer.watcher().unwatch(&file);
        }
    }
}

impl Drop for FileWatcher {
    fn drop(&mut self) {
        self.clear();
    }
}
