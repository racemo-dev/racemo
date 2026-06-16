//! PTY 출력 흐름 제어 (backpressure).
//!
//! 클라이언트 연결별로 "리더가 broadcast한 PTY 출력 바이트 − 클라이언트가
//! 소비(ack)한 바이트"를 추적한다. 어느 연결이라도 [`HIGH_WATERMARK`] 이상
//! 밀리면 해당 PTY의 리더 스레드가 [`PtyFlowControl::wait_capacity`]에서
//! 멈추고, 모든 연결이 [`LOW_WATERMARK`] 미만으로 따라잡으면 재개한다. 리더가 멈추면 PTY
//! 커널 버퍼가 차면서 셸이 write(2)에서 블록되므로, 추가 버퍼 없이 자연스러운
//! backpressure가 형성된다.
//!
//! ack를 보내지 않는 소비자(broadcast를 직접 구독하는 원격 호스팅 브리지 등)는
//! 등록되지 않으므로 흐름 제어에 참여하지 않는다.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use parking_lot::{Condvar, Mutex};

/// (연결, PTY)별 미ack 바이트가 이 값에 도달하면 해당 PTY의 read를 일시정지.
pub const HIGH_WATERMARK: usize = 512 * 1024;
/// 모든 연결의 미ack 바이트가 이 값 미만으로 내려가면 read 재개 (히스테리시스).
pub const LOW_WATERMARK: usize = 128 * 1024;

#[derive(Default)]
struct FlowInner {
    /// conn_id → (pty_id → 미ack 바이트)
    conns: HashMap<u64, HashMap<String, usize>>,
    /// 현재 read가 일시정지된 PTY 집합.
    paused: HashSet<String>,
}

/// 서버 전역에서 공유되는 PTY 흐름 제어 상태.
#[derive(Default)]
pub struct PtyFlowControl {
    inner: Mutex<FlowInner>,
    resumed: Condvar,
}

impl PtyFlowControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// 클라이언트 연결 시작 — 이 연결을 흐름 제어 대상으로 등록.
    pub fn register_conn(&self, conn_id: u64) {
        self.inner.lock().conns.insert(conn_id, HashMap::new());
    }

    /// 연결 종료 — 미ack 잔량을 무효화하고 멈춰 있던 리더를 깨운다.
    pub fn unregister_conn(&self, conn_id: u64) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        if let Some(panes) = inner.conns.remove(&conn_id) {
            for pty_id in panes.keys() {
                Self::reeval_pause(inner, pty_id);
            }
            self.resumed.notify_all();
        }
    }

    /// 이 연결의 카운터만 리셋 (등록은 유지). 웹뷰 리로드로 ack가 유실됐을 때
    /// 클라이언트가 보내는 ResetPtyAcks 처리용.
    pub fn reset_conn(&self, conn_id: u64) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some(panes) = inner.conns.get_mut(&conn_id) else { return };
        let pty_ids: Vec<String> = panes.keys().cloned().collect();
        panes.clear();
        for pty_id in &pty_ids {
            Self::reeval_pause(inner, pty_id);
        }
        self.resumed.notify_all();
    }

    /// PTY 리더가 출력을 broadcast한 직후 호출 — 등록된 모든 연결에 대해 계측.
    ///
    /// 소켓 write 시점이 아닌 broadcast 시점에 계측해야 한다: 다운스트림
    /// (소켓 버퍼/웹뷰)이 막히면 per-conn 전달 태스크가 write에서 블록되어
    /// write 시점 계측은 멈추고, 리더가 워터마크에 도달하지 못한 채 무제한
    /// read를 계속해 broadcast 채널 overflow(데이터 유실)가 발생한다.
    pub fn on_broadcast(&self, pty_id: &str, bytes: usize) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let mut hit_high = false;
        for panes in inner.conns.values_mut() {
            let unacked = panes.entry(pty_id.to_string()).or_insert(0);
            *unacked += bytes;
            if *unacked >= HIGH_WATERMARK {
                hit_high = true;
            }
        }
        if hit_high {
            inner.paused.insert(pty_id.to_string());
        }
    }

    /// 히스토리 replay처럼 broadcast를 거치지 않고 특정 연결의 소켓에
    /// 직접 쓴 PTY 출력을 계측할 때 호출.
    pub fn on_sent(&self, conn_id: u64, pty_id: &str, bytes: usize) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some(panes) = inner.conns.get_mut(&conn_id) else { return };
        let unacked = panes.entry(pty_id.to_string()).or_insert(0);
        *unacked += bytes;
        if *unacked >= HIGH_WATERMARK {
            inner.paused.insert(pty_id.to_string());
        }
    }

    /// 클라이언트가 소비 완료를 보고(ack)했을 때 호출.
    pub fn on_ack(&self, conn_id: u64, pty_id: &str, bytes: usize) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        {
            let Some(panes) = inner.conns.get_mut(&conn_id) else { return };
            let Some(unacked) = panes.get_mut(pty_id) else { return };
            *unacked = unacked.saturating_sub(bytes);
        }
        if Self::reeval_pause(inner, pty_id) {
            self.resumed.notify_all();
        }
    }

    /// PTY 종료/킬 시 호출 — 관련 상태를 정리하고 멈춰 있던 리더를 깨운다.
    pub fn on_pty_closed(&self, pty_id: &str) {
        let mut guard = self.inner.lock();
        for panes in guard.conns.values_mut() {
            panes.remove(pty_id);
        }
        guard.paused.remove(pty_id);
        self.resumed.notify_all();
    }

    pub fn is_paused(&self, pty_id: &str) -> bool {
        self.inner.lock().paused.contains(pty_id)
    }

    /// PTY 리더 스레드: 일시정지 상태인 동안 블록.
    /// notify 유실에 대비해 500ms 주기로 조건을 재확인한다.
    pub fn wait_capacity(&self, pty_id: &str) {
        let mut guard = self.inner.lock();
        while guard.paused.contains(pty_id) {
            self.resumed.wait_for(&mut guard, Duration::from_millis(500));
        }
    }

    /// 일시정지 해제 조건 재평가. 해제했으면 true.
    /// 해제 조건: 모든 등록된 연결의 미ack 바이트가 LOW_WATERMARK 미만.
    fn reeval_pause(inner: &mut FlowInner, pty_id: &str) -> bool {
        if !inner.paused.contains(pty_id) {
            return false;
        }
        let still_behind = inner
            .conns
            .values()
            .any(|panes| panes.get(pty_id).copied().unwrap_or(0) >= LOW_WATERMARK);
        if still_behind {
            false
        } else {
            inner.paused.remove(pty_id);
            true
        }
    }
}
