/// rows와 cols를 하나의 u32로 패킹. 상위 16비트 = rows, 하위 16비트 = cols.
pub(crate) fn pack_pty_size(rows: u16, cols: u16) -> u32 {
    ((rows as u32) << 16) | (cols as u32)
}

/// 패킹된 u32에서 rows와 cols를 추출.
pub(crate) fn unpack_pty_size(packed: u32) -> (u16, u16) {
    ((packed >> 16) as u16, packed as u16)
}

/// ConPTY의 마지막 행(pty_rows) CUP 시퀀스를 변환/제거 (Windows 전용).
///
/// CJK trailing space 제거로 줄바꿈이 방지되면, ConPTY 내부 버퍼와 xterm.js의
/// 행 레이아웃이 달라진다. ConPTY가 마지막 행 기준으로 보내는 절대 CUP 좌표를
/// xterm.js에 맞게 변환한다.
///
/// row == pty_rows인 CUP 처리:
/// - col > pty_cols / 2: "파킹" → CUP + trailing LF 제거
/// - col == 1: 프롬프트 위치 지정 → `\r\n`으로 대체
/// - 1 < col <= pty_cols / 2: PSReadLine 커서 위치 → `ESC[colG` (CHA)로 대체
///
/// `skip_next_lf`는 호출 간 유지되는 상태: 청크 끝에서 파킹 CUP를 제거했을 때
/// 뒤따르는 LF가 다음 청크에 올 수 있다.
#[cfg(windows)]
pub fn strip_conpty_cursor_parking(data: &[u8], pty_rows: u16, pty_cols: u16, skip_next_lf: &mut bool) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut i = 0;

    // 이전 호출에서 파킹 CUP를 제거하여 다음 LF를 건너뛰어야 하는 경우 처리
    if *skip_next_lf && !data.is_empty() {
        if data[0] == b'\n' {
            i += 1;
        }
        *skip_next_lf = false;
    }

    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'[' {
            // CSI (ESC [) 시작 발견
            let start = i;
            let mut j = i + 2;

            // 파라미터 영역 (숫자와 ;) 탐색
            while j < data.len() && (data[j].is_ascii_digit() || data[j] == b';') {
                j += 1;
            }

            if j < data.len() && data[j] == b'H' {
                // CUP 시퀀스 완성: ESC[...H
                let params = &data[start + 2..j];
                if let Some((row, col)) = parse_cup_params(params) {
                    if row == pty_rows && col > pty_cols / 2 {
                        // "파킹" CUP → 제거 (기존 동작)
                        i = j + 1;

                        // 시퀀스 뒤의 줄바꿈 제거 시도
                        if i < data.len() {
                            if data[i] == b'\n' {
                                i += 1;
                            } else if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
                                i += 2;
                                if i < data.len() && data[i] == b'\n' {
                                    i += 1;
                                } else if i == data.len() {
                                    *skip_next_lf = true;
                                }
                            }
                        } else {
                            *skip_next_lf = true;
                        }
                        continue;
                    } else if row == pty_rows && col == 1 {
                        // 프롬프트 위치 지정 CUP → \r\n으로 대체
                        result.push(b'\r');
                        result.push(b'\n');
                        i = j + 1;
                        continue;
                    } else if row == pty_rows {
                        // PSReadLine 커서 위치 CUP → CHA(Cursor Character Absolute)로 대체
                        // ESC[colG: 현재 행에서 col 열로 이동
                        let cha = format!("\x1b[{}G", col);
                        result.extend_from_slice(cha.as_bytes());
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        // 제거 대상이 아니면 결과에 추가
        result.push(data[i]);
        i += 1;
    }

    result
}

/// CUP 파라미터 "row;col"을 바이트에서 파싱. (row, col)을 1-based로 반환.
#[cfg(windows)]
#[allow(dead_code)]
fn parse_cup_params(params: &[u8]) -> Option<(u16, u16)> {
    let s = std::str::from_utf8(params).ok()?;
    let mut parts = s.split(';');
    let row: u16 = parts.next()?.parse().ok()?;
    let col: u16 = parts.next()?.parse().ok()?;
    // 추가 파라미터가 없는지 확인
    if parts.next().is_some() {
        return None;
    }
    Some((row, col))
}

/// ConPTY의 CJK 문자 너비 오계산으로 인한 아티팩트를 제거 (Windows 전용).
///
/// PowerShell이 CJK(한글 등) 문자를 1칸으로 계산하여 줄 패딩이 터미널 너비를 초과하면:
/// 1. 줄 끝 trailing space가 자동 줄바꿈을 유발 → `\r\n` 앞의 trailing space 제거
/// 2. 줄바꿈(wrap) 시 ConPTY가 스크롤용 bare `\n`을 삽입 → `\r\n` 직후의 bare `\n` 제거
/// 3. 공백만으로 된 빈 줄(화면 채움용)은 `\r\n`까지 통째로 제거
///
/// 주의: CUP→\r\n 변환은 strip_conpty_cursor_parking에서 먼저 수행되므로,
/// 이 함수에서는 trailing space + \r\n 패턴으로 자연스럽게 처리됨.
///
/// 상태 변수:
/// - `trailing_spaces`: 청크 끝 보류 공백 수
/// - `after_crlf`: 이전 출력이 `\r\n`으로 끝났는지 (다음 bare `\n` 제거 판단용)
/// - `line_has_content`: 현재 줄에 공백 외 내용이 있는지 (빈 줄 판단용)
#[cfg(windows)]
pub fn strip_trailing_spaces(
    data: &[u8],
    trailing_spaces: &mut usize,
    after_crlf: &mut bool,
    line_has_content: &mut bool,
) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut i = 0;

    // 이전 청크에서 보류된 trailing space 처리
    if *trailing_spaces > 0 {
        if !data.is_empty() && (data[0] == b'\r' || data[0] == b'\n') {
            // 개행이 따라옴 → 보류 공백 삭제
        } else {
            // 개행이 아님 → 보류 공백 복원
            result.resize(*trailing_spaces, b' ');
        }
        *trailing_spaces = 0;
    }

    // 이전 청크가 \r\n으로 끝났고 현재 청크가 \n으로 시작 → 스크롤 LF 제거
    if *after_crlf && !data.is_empty() && data[0] == b'\n' {
        i = 1;
    }
    *after_crlf = false;

    while i < data.len() {
        if data[i] == b' ' {
            // 연속 공백 구간 탐색
            let start = i;
            while i < data.len() && data[i] == b' ' {
                i += 1;
            }

            if i >= data.len() {
                // 청크 끝 → 다음 청크에서 개행 여부 확인을 위해 보류
                *trailing_spaces = i - start;
            } else if data[i] == b'\r' || data[i] == b'\n' {
                // 개행 직전 → trailing space 삭제
            } else {
                // 개행이 아닌 내용 → 공백 유지
                *line_has_content = true;
                result.extend_from_slice(&data[start..i]);
            }
        } else if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            if *line_has_content {
                // 실제 내용이 있는 줄 → \r\n 유지
                result.push(b'\r');
                result.push(b'\n');
            }
            // 공백만 있던 줄 → \r\n도 제거 (아무것도 출력하지 않음)
            i += 2;
            *line_has_content = false;
            // \r\n 직후 bare \n이 오면 스크롤 LF → 제거
            if i < data.len() && data[i] == b'\n' {
                i += 1;
            } else if i == data.len() {
                // 청크 끝이 \r\n → 다음 청크에서 \n 확인
                *after_crlf = true;
            }
        } else {
            *line_has_content = true;
            result.push(data[i]);
            i += 1;
        }
    }

    result
}
