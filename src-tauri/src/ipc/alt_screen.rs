//! Alternate screen buffer (smcup/rmcup) 상태 추적 파서.
//!
//! PTY 출력 바이트 스트림에서 DEC private mode 시퀀스를 파싱하여
//! 터미널이 메인 스크린/alt-screen 중 어느 상태인지 추적한다.
//!
//! 추적 대상 시퀀스 (모두 CSI ? <mode> h|l 형태):
//!   - `\e[?1049h` / `\e[?1049l` — 가장 흔함, cursor save/restore 포함
//!   - `\e[?47h`   / `\e[?47l`   — 구형 alt-buffer
//!   - `\e[?1047h` / `\e[?1047l` — clear 동반 alt-buffer
//!
//! 결합 파라미터(`\e[?1049;25h`)도 지원: alt-screen 부분만 제거하고
//! 나머지 모드(`\e[?25h`)는 그대로 출력에 포함시켜 cursor 표시 등이 깨지지 않게 한다.
//!
//! 용도: 서버의 PTY history 분리(메인 스크롤백 vs 현재 alt-screen 프레임).

const ALT_SCREEN_MODES: &[u32] = &[47, 1047, 1049];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum ParseState {
    #[default]
    Normal,
    AfterEsc,
    AfterCsi,
    InCsiPrivate,
    InCsiNormal,
}

#[derive(Default)]
pub struct AltScreenState {
    pub in_alt_screen: bool,
    parse: ParseState,
    /// 현재 CSI 시퀀스의 누적 바이트 (`\e[?...` 또는 `\e[...`).
    pending: Vec<u8>,
}

/// 한 청크 처리 결과. 메인/alt 히스토리에 어떤 바이트를 기록할지 결정하는 데 사용.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProcessResult {
    pub main_bytes: Vec<u8>,
    pub alt_bytes: Vec<u8>,
    /// 이 청크 처리 중 alt-screen에 새로 진입했다면 true.
    /// (호출자가 alt_history를 clear할지 판단)
    pub entered_alt: bool,
}

pub fn process_chunk(data: &[u8], state: &mut AltScreenState) -> ProcessResult {
    let mut result = ProcessResult::default();

    for &b in data {
        match state.parse {
            ParseState::Normal => {
                if b == 0x1b {
                    state.pending.push(b);
                    state.parse = ParseState::AfterEsc;
                } else if state.in_alt_screen {
                    result.alt_bytes.push(b);
                } else {
                    result.main_bytes.push(b);
                }
            }
            ParseState::AfterEsc => {
                state.pending.push(b);
                if b == b'[' {
                    state.parse = ParseState::AfterCsi;
                } else {
                    // CSI가 아님 — pending을 그대로 흘려보낸다.
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                }
            }
            ParseState::AfterCsi => {
                state.pending.push(b);
                if b == b'?' {
                    state.parse = ParseState::InCsiPrivate;
                } else if (0x40..=0x7e).contains(&b) {
                    // CSI 종료 바이트 (파라미터 없음).
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                } else if (0x30..=0x3f).contains(&b) {
                    // 파라미터/intermediate 바이트.
                    state.parse = ParseState::InCsiNormal;
                } else {
                    // 예상치 못한 바이트 — 그대로 흘리고 리셋.
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                }
            }
            ParseState::InCsiPrivate => {
                state.pending.push(b);
                if b == b'h' || b == b'l' {
                    // 종료 바이트. alt-screen 토글 여부 판단.
                    if let Some((toggle_enter, remainder)) = split_alt_screen(&state.pending) {
                        // alt-screen 토글이 먼저 적용된 뒤 나머지 모드가 새 화면에 반영되도록
                        // 순서를 (상태 전환 → 잔여 시퀀스 emit)으로 맞춘다.
                        let prev = state.in_alt_screen;
                        state.in_alt_screen = toggle_enter;
                        if !prev && toggle_enter {
                            result.entered_alt = true;
                        }
                        if let Some(rem) = remainder {
                            emit(&rem, state.in_alt_screen, &mut result);
                        }
                    } else {
                        // alt-screen과 무관한 private mode — 그대로 흘림.
                        flush_pending(state, &mut result);
                    }
                    state.pending.clear();
                    state.parse = ParseState::Normal;
                } else if (0x40..=0x7e).contains(&b) {
                    // 다른 종료 바이트 — 그대로 흘림.
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                } else if (0x30..=0x3b).contains(&b) {
                    // 파라미터 바이트 (숫자, `;`) — 계속 누적.
                    // pending 무한 증가 방지.
                    if state.pending.len() > 64 {
                        flush_pending(state, &mut result);
                        state.parse = ParseState::Normal;
                    }
                } else {
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                }
            }
            ParseState::InCsiNormal => {
                state.pending.push(b);
                if (0x40..=0x7e).contains(&b) || state.pending.len() > 64 {
                    flush_pending(state, &mut result);
                    state.parse = ParseState::Normal;
                }
            }
        }
    }

    result
}

fn emit(bytes: &[u8], in_alt: bool, result: &mut ProcessResult) {
    if in_alt {
        result.alt_bytes.extend_from_slice(bytes);
    } else {
        result.main_bytes.extend_from_slice(bytes);
    }
}

fn flush_pending(state: &mut AltScreenState, result: &mut ProcessResult) {
    emit(&state.pending, state.in_alt_screen, result);
    state.pending.clear();
}

/// `\e[?<params><h|l>` 시퀀스를 파싱.
/// alt-screen 모드가 포함되어 있으면 `(enter, remaining_seq)`를 반환한다.
/// `remaining_seq`는 alt-screen 외 모드만 남긴 시퀀스(필요한 경우)이며,
/// 모든 파라미터가 alt-screen이면 `None`.
/// alt-screen 모드가 전혀 없으면 `None`을 반환.
fn split_alt_screen(pending: &[u8]) -> Option<(bool, Option<Vec<u8>>)> {
    if pending.len() < 4 {
        return None;
    }
    if pending[0] != 0x1b || pending[1] != b'[' || pending[2] != b'?' {
        return None;
    }
    let last = *pending.last()?;
    let enter = match last {
        b'h' => true,
        b'l' => false,
        _ => return None,
    };
    let params_bytes = &pending[3..pending.len() - 1];
    let params_str = std::str::from_utf8(params_bytes).ok()?;

    let mut alt_found = false;
    let mut remaining: Vec<&str> = Vec::new();
    for p in params_str.split(';') {
        let n: u32 = p.parse().ok()?;
        if ALT_SCREEN_MODES.contains(&n) {
            alt_found = true;
        } else {
            remaining.push(p);
        }
    }
    if !alt_found {
        return None;
    }
    let remainder = if remaining.is_empty() {
        None
    } else {
        let joined = remaining.join(";");
        let mut v = Vec::with_capacity(joined.len() + 4);
        v.extend_from_slice(b"\x1b[?");
        v.extend_from_slice(joined.as_bytes());
        v.push(last);
        Some(v)
    };
    Some((enter, remainder))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> (Vec<u8>, Vec<u8>, bool) {
        let mut state = AltScreenState::default();
        let mut main = Vec::new();
        let mut alt = Vec::new();
        for c in chunks {
            let r = process_chunk(c, &mut state);
            main.extend(r.main_bytes);
            alt.extend(r.alt_bytes);
        }
        (main, alt, state.in_alt_screen)
    }

    #[test]
    fn plain_text_goes_to_main() {
        let (main, alt, in_alt) = run(&[b"hello world"]);
        assert_eq!(main, b"hello world");
        assert!(alt.is_empty());
        assert!(!in_alt);
    }

    #[test]
    fn enter_alt_screen_basic() {
        let (main, alt, in_alt) = run(&[b"prefix\x1b[?1049hvim content"]);
        assert_eq!(main, b"prefix");
        assert_eq!(alt, b"vim content");
        assert!(in_alt);
    }

    #[test]
    fn enter_then_exit_returns_to_main() {
        let (main, alt, in_alt) = run(&[b"a\x1b[?1049hVIM\x1b[?1049lb"]);
        assert_eq!(main, b"ab");
        assert_eq!(alt, b"VIM");
        assert!(!in_alt);
    }

    #[test]
    fn mode_47_and_1047_also_recognized() {
        let (main, alt, in_alt) = run(&[b"A\x1b[?47hB\x1b[?47lC\x1b[?1047hD\x1b[?1047lE"]);
        assert_eq!(main, b"ACE");
        assert_eq!(alt, b"BD");
        assert!(!in_alt);
    }

    #[test]
    fn split_across_chunks_esc() {
        let (main, alt, in_alt) = run(&[b"main\x1b", b"[?1049halt"]);
        assert_eq!(main, b"main");
        assert_eq!(alt, b"alt");
        assert!(in_alt);
    }

    #[test]
    fn split_across_chunks_params() {
        let (main, alt, in_alt) = run(&[b"\x1b[?10", b"49halt"]);
        assert!(main.is_empty());
        assert_eq!(alt, b"alt");
        assert!(in_alt);
    }

    #[test]
    fn combined_params_keeps_other_modes() {
        // \e[?1049;25h → alt-screen + 25(DECTCEM cursor visible). alt-screen만 제거.
        let (main, alt, in_alt) = run(&[b"A\x1b[?1049;25hB"]);
        assert_eq!(main, b"A");
        assert_eq!(alt, b"\x1b[?25hB");
        assert!(in_alt);
    }

    #[test]
    fn combined_params_exit_keeps_other_modes() {
        let (main, alt, in_alt) = run(&[b"A\x1b[?1049hX\x1b[?1049;25lB"]);
        assert_eq!(main, b"A\x1b[?25lB");
        assert_eq!(alt, b"X");
        assert!(!in_alt);
    }

    #[test]
    fn unrelated_private_mode_passes_through() {
        // \e[?25l (cursor hide) — alt-screen과 무관, 그대로 흘림.
        let (main, alt, in_alt) = run(&[b"A\x1b[?25lB"]);
        assert_eq!(main, b"A\x1b[?25lB");
        assert!(alt.is_empty());
        assert!(!in_alt);
    }

    #[test]
    fn normal_csi_passes_through() {
        // \e[H (cursor home), \e[2J (clear).
        let (main, alt, in_alt) = run(&[b"\x1b[H\x1b[2Jhello"]);
        assert_eq!(main, b"\x1b[H\x1b[2Jhello");
        assert!(alt.is_empty());
        assert!(!in_alt);
    }

    #[test]
    fn entered_alt_flag_set_on_transition() {
        let mut state = AltScreenState::default();
        let r1 = process_chunk(b"main\x1b[?1049halt", &mut state);
        assert!(r1.entered_alt);
        let r2 = process_chunk(b"more alt", &mut state);
        assert!(!r2.entered_alt);
        let r3 = process_chunk(b"\x1b[?1049lback", &mut state);
        assert!(!r3.entered_alt);
        let r4 = process_chunk(b"\x1b[?1049hagain", &mut state);
        assert!(r4.entered_alt);
    }

    #[test]
    fn esc_followed_by_non_csi_flushes_pending() {
        // \e\\ (ST) — not CSI.
        let (main, _alt, _) = run(&[b"\x1b\\hello"]);
        assert_eq!(main, b"\x1b\\hello");
    }

    #[test]
    fn lone_esc_then_normal_byte() {
        // \e followed by 'A' is not CSI — ESC + A.
        let (main, _alt, _) = run(&[b"\x1bAB"]);
        assert_eq!(main, b"\x1bAB");
    }

    #[test]
    fn multiple_transitions_in_one_chunk() {
        let (main, alt, in_alt) = run(&[b"a\x1b[?1049hb\x1b[?1049lc\x1b[?1049hd"]);
        assert_eq!(main, b"ac");
        assert_eq!(alt, b"bd");
        assert!(in_alt);
    }

    #[test]
    fn overflow_protection_in_private_csi() {
        // 매우 긴 파라미터(64 초과)는 흘려보낸다.
        let mut payload = b"\x1b[?".to_vec();
        payload.extend(std::iter::repeat(b'1').take(100));
        payload.push(b'h');
        payload.extend_from_slice(b"after");
        let (main, _alt, _) = run(&[&payload]);
        // pending이 흘려지므로 'after'가 main에 포함됨.
        assert!(main.ends_with(b"after"));
    }

    #[test]
    fn vim_typical_sequence() {
        // tput smcup 유사: \e[?1049h\e[22;0;0t\e[?25h
        // 22;0;0t는 window state, 25h는 cursor show.
        let (main, alt, in_alt) = run(&[
            b"shell prompt $ ",
            b"\x1b[?1049h\x1b[22;0;0t\x1b[?25h",
            b"VIM SCREEN",
        ]);
        assert_eq!(main, b"shell prompt $ ");
        // 22;0;0t와 ?25h는 alt 진입 후의 바이트이므로 alt에 들어감.
        assert!(alt.starts_with(b"\x1b[22;0;0t\x1b[?25h"));
        assert!(alt.ends_with(b"VIM SCREEN"));
        assert!(in_alt);
    }
}
