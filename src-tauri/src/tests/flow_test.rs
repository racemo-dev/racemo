//! PTY 출력 흐름 제어(backpressure) 테스트.
//!
//! 클라이언트가 소비(ack)하지 못한 바이트가 HIGH_WATERMARK에 도달하면
//! 서버의 PTY 리더가 read를 멈추고, LOW_WATERMARK 미만으로 내려가면 재개한다.
//! PTY 커널 버퍼가 차면 셸이 write에서 블록되므로 자연스러운 backpressure가 형성된다.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;

use crate::ipc::flow::{PtyFlowControl, HIGH_WATERMARK, LOW_WATERMARK};
use crate::ipc::protocol::*;
use crate::ipc::server::ServerState;

// ── PtyFlowControl 단위 테스트 ──────────────────────────────────

#[test]
fn high_watermark_pauses_pty() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);

    flow.on_sent(1, "pty-a", HIGH_WATERMARK - 1);
    assert!(!flow.is_paused("pty-a"), "HIGH 미만에서는 일시정지 금지");

    flow.on_sent(1, "pty-a", 1);
    assert!(flow.is_paused("pty-a"), "HIGH 도달 시 일시정지");
}

#[test]
fn ack_below_low_watermark_resumes_with_hysteresis() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    // LOW까지 ack해도 아직 정지 유지 (재개 조건은 LOW 미만)
    flow.on_ack(1, "pty-a", HIGH_WATERMARK - LOW_WATERMARK);
    assert!(flow.is_paused("pty-a"), "unacked == LOW에서는 정지 유지");

    // LOW 미만으로 내려가면 재개
    flow.on_ack(1, "pty-a", 1);
    assert!(!flow.is_paused("pty-a"), "unacked < LOW에서 재개");
}

#[test]
fn pause_state_is_per_pty() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    flow.on_sent(1, "pty-b", 100);
    assert!(flow.is_paused("pty-a"));
    assert!(!flow.is_paused("pty-b"), "다른 PTY는 영향 없음");
}

#[test]
fn slowest_of_multiple_conns_gates_resume() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.register_conn(2);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    flow.on_sent(2, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    // conn 1만 전부 ack — conn 2가 여전히 밀려 있으므로 정지 유지
    flow.on_ack(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"), "가장 느린 연결이 재개를 결정");

    flow.on_ack(2, "pty-a", HIGH_WATERMARK);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn unregister_conn_resumes_paused_pty() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    // 연결 종료 시 해당 연결의 미ack 잔량은 무효 — 리더 영구 정지 금지
    flow.unregister_conn(1);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn reset_conn_clears_counters_but_stays_registered() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    // 웹뷰 리로드 복구: 카운터만 리셋, 연결은 유지되어 이후 on_sent 추적 계속
    flow.reset_conn(1);
    assert!(!flow.is_paused("pty-a"));

    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"), "리셋 후에도 새 전송은 계속 추적");
}

#[test]
fn pty_close_clears_flow_state() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.register_conn(2);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    flow.on_sent(2, "pty-a", 10);
    assert!(flow.is_paused("pty-a"));

    flow.on_pty_closed("pty-a");
    assert!(!flow.is_paused("pty-a"));

    // 닫힌 PTY에 대한 늦은 ack는 무해해야 함
    flow.on_ack(1, "pty-a", 1024);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn unregistered_conn_sends_are_ignored() {
    let flow = PtyFlowControl::new();
    // register_conn 없이 on_sent — 등록되지 않은 연결은 흐름 제어에 참여하지 않음
    flow.on_sent(99, "pty-a", HIGH_WATERMARK * 2);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn on_broadcast_counts_all_registered_conns() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.register_conn(2);
    flow.on_broadcast("pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"), "broadcast 계측으로 일시정지");

    // 한 연결만 ack — 다른 연결이 밀려 있으므로 정지 유지
    flow.on_ack(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    flow.on_ack(2, "pty-a", HIGH_WATERMARK);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn on_broadcast_without_conns_is_noop() {
    let flow = PtyFlowControl::new();
    // 연결이 없으면(헤드리스 서버) 흐름 제어 비활성 — PTY는 자유롭게 흐른다
    flow.on_broadcast("pty-a", HIGH_WATERMARK * 10);
    assert!(!flow.is_paused("pty-a"));
}

#[test]
fn over_ack_saturates_at_zero() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", 100);
    // 보낸 것보다 많은 ack (히스토리 replay 경계 등) — 패닉/언더플로 금지
    flow.on_ack(1, "pty-a", 10_000);
    assert!(!flow.is_paused("pty-a"));

    // 이후 정상 추적 계속
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));
}

#[test]
fn wait_capacity_blocks_while_paused_and_wakes_on_ack() {
    let flow = Arc::new(PtyFlowControl::new());
    flow.register_conn(1);
    flow.on_sent(1, "pty-a", HIGH_WATERMARK);
    assert!(flow.is_paused("pty-a"));

    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let flow2 = flow.clone();
    std::thread::spawn(move || {
        flow2.wait_capacity("pty-a");
        let _ = done_tx.send(());
    });

    // 일시정지 중에는 블록되어야 함
    assert!(
        done_rx.recv_timeout(Duration::from_millis(150)).is_err(),
        "paused 상태에서 wait_capacity가 즉시 반환되면 안 됨"
    );

    // 전부 ack → LOW 미만 → 즉시 깨어남
    flow.on_ack(1, "pty-a", HIGH_WATERMARK);
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("ack 후 wait_capacity가 깨어나야 함");
}

#[test]
fn wait_capacity_returns_immediately_when_not_paused() {
    let flow = PtyFlowControl::new();
    flow.register_conn(1);
    let start = std::time::Instant::now();
    flow.wait_capacity("pty-a");
    assert!(start.elapsed() < Duration::from_millis(100));
}

// ── 프로토콜 직렬화 테스트 ──────────────────────────────────────

#[tokio::test]
async fn ack_pty_output_roundtrips_through_frame() {
    let (mut a, mut b) = tokio::io::duplex(64 * 1024);
    write_frame(
        &mut a,
        &ClientMessage::AckPtyOutput { pane_id: "p-1".into(), bytes: 4096 },
    )
    .await
    .unwrap();
    let msg: Option<ClientMessage> = read_frame(&mut b).await.unwrap();
    match msg {
        Some(ClientMessage::AckPtyOutput { pane_id, bytes }) => {
            assert_eq!(pane_id, "p-1");
            assert_eq!(bytes, 4096);
        }
        other => panic!("Expected AckPtyOutput, got {other:?}"),
    }
}

#[tokio::test]
async fn reset_pty_acks_roundtrips_through_frame() {
    let (mut a, mut b) = tokio::io::duplex(64 * 1024);
    write_frame(&mut a, &ClientMessage::ResetPtyAcks).await.unwrap();
    let msg: Option<ClientMessage> = read_frame(&mut b).await.unwrap();
    assert!(matches!(msg, Some(ClientMessage::ResetPtyAcks)));
}

// ── ServerState 통합 테스트 ─────────────────────────────────────

#[test]
fn kill_pty_clears_flow_state() {
    let (tx, _rx) = broadcast::channel(64);
    let mut state = ServerState::new(tx);
    let flow = state.flow_control();
    flow.register_conn(1);

    let (pty_id, _) = state.spawn_pty(24, 80, None, None).expect("spawn pty");
    flow.on_sent(1, &pty_id, HIGH_WATERMARK);
    assert!(flow.is_paused(&pty_id));

    state.kill_pty(&pty_id);
    assert!(!flow.is_paused(&pty_id), "PTY 종료 시 흐름 상태 정리");
}

/// 바이트 슬라이스에서 부분 수열 검색.
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn count_crlf(data: &[u8]) -> usize {
    data.windows(2).filter(|w| *w == b"\r\n").count()
}

/// E2E: 실제 PTY에서 대량 출력 시
/// 1) ack 없이는 리더가 HIGH_WATERMARK 부근에서 정지 (무제한 push 금지)
/// 2) ack를 흘려주면 재개되어 데이터가 순서대로 전부 도착 (유실 0)
#[test]
fn pty_reader_pauses_without_acks_and_resumes_losslessly() {
    // seq 1 100000 출력: 488,895 bytes + CRLF 변환으로 줄당 +1 = 688,895 bytes
    const SEQ_TOTAL_BYTES: usize = 688_895;
    const SEQ_LINES: usize = 100_000;

    let (tx, rx) = broadcast::channel::<ServerMessage>(4096);
    let mut state = ServerState::new(tx);
    let flow = state.flow_control();
    const CONN: u64 = 7;
    flow.register_conn(CONN);

    let (pty_id, _) = state.spawn_pty(40, 120, None, None).expect("spawn pty");

    // 클라이언트 연결 핸들러를 모사하는 소비 태스크: broadcast에서 PtyOutput을
    // 수신해 테스트 본문으로 전달. (계측은 리더 스레드가 on_broadcast로 수행)
    let (data_tx, data_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let consumer_pty = pty_id.clone();
    let mut rx = rx;
    std::thread::spawn(move || loop {
        match rx.blocking_recv() {
            Ok(ServerMessage::PtyOutput { pane_id, data }) => {
                if pane_id != consumer_pty {
                    continue;
                }
                if data_tx.send(data).is_err() {
                    break;
                }
            }
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    });

    // 셸 프롬프트가 뜰 때까지 대기 (첫 출력 수신)
    let first = data_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("셸 첫 출력(프롬프트)이 도착해야 함");
    let mut received: Vec<u8> = first;
    // 프롬프트 잔여 출력 소진
    while let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(500)) {
        received.extend_from_slice(&chunk);
    }
    let noise_before_cmd = received.len();

    state
        .write_pty(&pty_id, b"seq 1 100000\r")
        .expect("write command");

    // ── Phase 1: ack 없이 수신 → 리더가 HIGH_WATERMARK 부근에서 정지해야 함
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !flow.is_paused(&pty_id) {
        assert!(
            std::time::Instant::now() < deadline,
            "ack 없이 {}바이트 출력 중인데 리더가 일시정지하지 않음 (수신 {}바이트)",
            SEQ_TOTAL_BYTES,
            received.len()
        );
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(100)) {
            received.extend_from_slice(&chunk);
        }
    }
    // 정지 후 잔여 in-flight 청크 소진
    while let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(500)) {
        received.extend_from_slice(&chunk);
    }
    assert!(
        received.len() < noise_before_cmd + SEQ_TOTAL_BYTES,
        "일시정지 상태인데 전체 출력({SEQ_TOTAL_BYTES})이 모두 도착 — 흐름 제어 미작동"
    );
    assert!(
        received.len() <= noise_before_cmd + HIGH_WATERMARK + 256 * 1024,
        "일시정지 후에도 수신량이 워터마크를 크게 초과: {}",
        received.len()
    );

    // ── Phase 2: 수신분을 ack하며 소비 → 재개되어 끝까지 유실 없이 도착해야 함
    flow.on_ack(CONN, &pty_id, received.len());
    // macOS CI 러너 변동성 마진. 데이터 유실이라면 어떤 timeout도 fail이라 검증 강도는 유지된다.
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    while !contains_subslice(&received, b"\r\n100000\r\n") {
        assert!(
            std::time::Instant::now() < deadline,
            "ack를 흘려도 출력이 끝까지 도착하지 않음 (수신 {}바이트)",
            received.len()
        );
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
            flow.on_ack(CONN, &pty_id, chunk.len());
            received.extend_from_slice(&chunk);
        }
    }

    // 유실 검증: seq 라인 수 이상의 CRLF + 총 바이트
    assert!(
        count_crlf(&received) >= SEQ_LINES,
        "CRLF 수 {} < {SEQ_LINES} — 중간 청크 유실 의심",
        count_crlf(&received)
    );
    assert!(
        received.len() >= noise_before_cmd + SEQ_TOTAL_BYTES,
        "총 수신 {}바이트 < 기대 {} — 데이터 유실",
        received.len(),
        noise_before_cmd + SEQ_TOTAL_BYTES
    );

    // 전부 ack된 상태이므로 최종적으로 일시정지가 풀려 있어야 함
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while flow.is_paused(&pty_id) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!flow.is_paused(&pty_id), "전체 ack 후에도 일시정지 유지");

    state.kill_pty(&pty_id);
}
