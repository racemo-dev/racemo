pub mod claudelog;
pub mod codexlog;
pub mod geminilog;
pub mod history;
pub mod hooklog;
pub mod opencodelog;
pub mod remote;
pub mod session;
pub mod util;
pub mod git;
pub mod streaming;

pub use claudelog::*;
pub use codexlog::*;
pub use geminilog::*;
pub use history::*;
pub use hooklog::*;
pub use opencodelog::*;
pub use remote::*;
pub use session::*;
pub use util::*;
pub use git::*;

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use crate::ipc::client::IpcClient;

pub type IpcState = Arc<TokioMutex<Option<IpcClient>>>;

/// Helper: lock the IPC state and return the client, or error if not connected.
pub async fn ipc(state: &IpcState) -> Result<impl std::ops::Deref<Target = IpcClient> + '_, String> {
    let mut guard = state.lock().await;
    if let Some(client) = guard.as_ref() {
        if !client.is_connected() {
            log::warn!("IPC client detected as disconnected, clearing state");
            *guard = None;
        }
    }
    if guard.is_none() {
        return Err("Not connected to server yet".to_string());
    }
    Ok(tokio::sync::MutexGuard::map(guard, |opt| opt.as_mut().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ipc_none_state_returns_error() {
        let state: IpcState = Arc::new(TokioMutex::new(None));
        // Extract the error in an inner block so the MutexGuard (Ok case) is
        // dropped before `state` goes out of scope, satisfying the borrow checker.
        let err = {
            let r = ipc(&state).await;
            match r {
                Err(e) => e,
                Ok(_) => panic!("Expected error when IPC state is None"),
            }
        };
        assert_eq!(err, "Not connected to server yet");
    }
}
