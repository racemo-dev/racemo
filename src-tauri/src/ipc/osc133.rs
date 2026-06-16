//! OSC 133 (FinalTerm shell integration) 파싱.
//!
//! 셸이 출력하는 prompt/command 마커를 PTY 바이트 스트림에서 추출한다.
//! 우리가 사용하는 시퀀스는 두 가지뿐:
//!   - `ESC ] 133 ; C ST`            — 명령 실행 시작
//!   - `ESC ] 133 ; D [ ; <exit> ] ST` — 명령 종료 (exit code 선택)
//!
//! ST(string terminator)는 BEL(0x07) 또는 `ESC \`(0x1b 0x5c) 둘 다 지원.
//!
//! `133;A`(prompt 시작), `133;B`(입력 위치)는 푸시 알림과 무관하므로 무시한다.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Osc133Event {
    /// 명령 실행 시작 (`133;C`)
    CommandStart,
    /// 명령 종료 (`133;D[;<exit>]`)
    CommandFinished { exit_code: Option<i32> },
}

#[derive(Default)]
pub(crate) struct Osc133State {
    /// prefix 매칭 중이거나 payload를 누적 중인 바이트 버퍼.
    buf: Vec<u8>,
    /// `]133;` 프리픽스를 다 받아 payload를 모으는 중이면 true.
    in_payload: bool,
}

const PREFIX: &[u8] = b"\x1b]133;";
const MAX_PAYLOAD: usize = 64; // "D;<i32>" 정도라 64바이트로 충분

pub(crate) fn parse_osc133_from_stream(
    data: &[u8],
    state: &mut Osc133State,
) -> Vec<Osc133Event> {
    let mut events = Vec::new();
    for &b in data {
        if state.in_payload {
            // BEL 또는 ESC(ST의 시작)면 payload 종료.
            if b == 0x07 || b == 0x1b {
                if let Some(ev) = parse_payload(&state.buf) {
                    events.push(ev);
                }
                state.buf.clear();
                state.in_payload = false;
                // ESC라면 새 OSC 시퀀스의 시작일 수도 있으니 prefix 매칭 재개.
                if b == 0x1b {
                    state.buf.push(0x1b);
                }
            } else {
                state.buf.push(b);
                if state.buf.len() > MAX_PAYLOAD {
                    state.buf.clear();
                    state.in_payload = false;
                }
            }
            continue;
        }

        // prefix 매칭 시도.
        if state.buf.is_empty() {
            if b == 0x1b {
                state.buf.push(b);
            }
            continue;
        }

        let next_idx = state.buf.len();
        if next_idx < PREFIX.len() && b == PREFIX[next_idx] {
            state.buf.push(b);
            if state.buf.len() == PREFIX.len() {
                state.buf.clear();
                state.in_payload = true;
            }
            continue;
        }

        // 매칭 실패. 현재 바이트가 ESC면 새 시도 시작.
        state.buf.clear();
        if b == 0x1b {
            state.buf.push(b);
        }
    }
    events
}

fn parse_payload(payload: &[u8]) -> Option<Osc133Event> {
    let s = std::str::from_utf8(payload).ok()?;
    let mut parts = s.split(';');
    let kind = parts.next()?;
    match kind {
        "C" => Some(Osc133Event::CommandStart),
        "D" => {
            let exit_code = parts.next().and_then(|v| v.trim().parse::<i32>().ok());
            Some(Osc133Event::CommandFinished { exit_code })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(chunks: &[&[u8]]) -> Vec<Osc133Event> {
        let mut state = Osc133State::default();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(parse_osc133_from_stream(c, &mut state));
        }
        out
    }

    #[test]
    fn command_start_with_bel() {
        let evs = parse_all(&[b"\x1b]133;C\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandStart]);
    }

    #[test]
    fn command_finished_with_exit_zero_bel() {
        let evs = parse_all(&[b"\x1b]133;D;0\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: Some(0) }]);
    }

    #[test]
    fn command_finished_with_st_terminator() {
        let evs = parse_all(&[b"\x1b]133;D;127\x1b\\"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: Some(127) }]);
    }

    #[test]
    fn command_finished_without_exit_code() {
        let evs = parse_all(&[b"\x1b]133;D\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: None }]);
    }

    #[test]
    fn negative_exit_code() {
        let evs = parse_all(&[b"\x1b]133;D;-1\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: Some(-1) }]);
    }

    #[test]
    fn ignores_a_and_b_markers() {
        let evs = parse_all(&[b"\x1b]133;A\x07\x1b]133;B\x07"]);
        assert!(evs.is_empty());
    }

    #[test]
    fn split_across_chunks() {
        // ESC가 한 청크 끝, 나머지는 다음 청크.
        let evs = parse_all(&[b"some output\x1b", b"]133;C\x07trailing"]);
        assert_eq!(evs, vec![Osc133Event::CommandStart]);
    }

    #[test]
    fn split_in_payload() {
        let evs = parse_all(&[b"\x1b]133;D;", b"42\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: Some(42) }]);
    }

    #[test]
    fn embedded_in_text() {
        let evs = parse_all(&[b"before\x1b]133;C\x07middle\x1b]133;D;0\x07after"]);
        assert_eq!(
            evs,
            vec![
                Osc133Event::CommandStart,
                Osc133Event::CommandFinished { exit_code: Some(0) },
            ]
        );
    }

    #[test]
    fn osc7_does_not_trigger() {
        // OSC 7 (CWD)이 섞여도 OSC 133만 검출.
        let evs = parse_all(&[
            b"\x1b]7;file:///home/user\x07\x1b]133;C\x07\x1b]7;file:///tmp\x07",
        ]);
        assert_eq!(evs, vec![Osc133Event::CommandStart]);
    }

    #[test]
    fn malformed_exit_code_treated_as_none() {
        let evs = parse_all(&[b"\x1b]133;D;abc\x07"]);
        assert_eq!(evs, vec![Osc133Event::CommandFinished { exit_code: None }]);
    }

    #[test]
    fn unknown_kind_ignored() {
        let evs = parse_all(&[b"\x1b]133;Z;junk\x07"]);
        assert!(evs.is_empty());
    }

    #[test]
    fn payload_overflow_guard() {
        let mut payload = b"\x1b]133;D;".to_vec();
        payload.extend(std::iter::repeat(b'9').take(200));
        payload.push(0x07);
        let evs = parse_all(&[&payload]);
        // 64바이트 초과 시 폐기되어 이벤트 없음.
        assert!(evs.is_empty());
    }

    #[test]
    fn esc_terminator_starts_new_sequence() {
        // 첫 시퀀스의 ESC 종료자가 곧바로 두 번째 OSC 133의 시작이 되는 경우.
        let evs = parse_all(&[b"\x1b]133;C\x1b]133;D;0\x07"]);
        assert_eq!(
            evs,
            vec![
                Osc133Event::CommandStart,
                Osc133Event::CommandFinished { exit_code: Some(0) },
            ]
        );
    }
}
