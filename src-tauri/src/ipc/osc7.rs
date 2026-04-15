/// 바이트 스트림에서 OSC 7 (CWD 지정: ESC ] 7 ; file://host/path BEL/ST) 시퀀스를 스캔.
/// 발견된 모든 유효한 경로를 Vec으로 반환. 호스트명 필터링 및 퍼센트 디코딩은 extract_osc7_path에서 수행.
pub(crate) fn parse_osc7_from_stream(
    data: &[u8],
    in_osc7: &mut bool,
    osc_buf: &mut Vec<u8>,
) -> Vec<String> {
    let mut paths = Vec::new();
    for &b in data {
        if *in_osc7 {
            if b == 0x07 || b == 0x1b { // BEL 또는 ESC (ST의 시작)
                if let Ok(url_str) = std::str::from_utf8(osc_buf) {
                    if let Some(path) = extract_osc7_path(url_str) {
                        paths.push(path);
                    }
                }
                osc_buf.clear();
                *in_osc7 = false;
            } else {
                osc_buf.push(b);
                // 안전 제한 (너무 긴 시퀀스는 무시)
                if osc_buf.len() > 4096 {
                    osc_buf.clear();
                    *in_osc7 = false;
                }
            }
        } else if b == 0x1b {
            // ESC ] 7 ; 의 시작일 수 있음 -- 후속 바이트 확인을 위해 초기화 및 적재
            osc_buf.clear();
            osc_buf.push(b);
        } else if !osc_buf.is_empty() {
            osc_buf.push(b);
            // ESC ] 7 ; 시퀀스 완성 여부 확인
            if osc_buf.len() == 4 {
                if osc_buf == b"\x1b]7;" {
                    *in_osc7 = true;
                    osc_buf.clear();
                } else {
                    osc_buf.clear();
                }
            }
        }
    }
    paths
}

/// OSC 7 URL ("file://hostname/path/to/dir")에서 경로를 추출.
#[allow(dead_code)]
pub(crate) fn extract_osc7_path(url: &str) -> Option<String> {
    if let Some(rest) = url.strip_prefix("file://") {
        // 호스트네임 부분 건너뛰기 ("file://" 이후 첫 번째 '/' 앞 부분)
        if let Some(slash_pos) = rest.find('/') {
            let mut path = rest[slash_pos..].to_string();
            // 경로 퍼센트 디코딩
            path = percent_decode(&path);

            if !path.is_empty() {
                #[cfg(windows)]
                {
                    // "/C:/Users/..."를 "C:/Users/..."로 변환
                    if path.starts_with('/') && path.len() > 2 && path.as_bytes()[2] == b':' {
                        path.remove(0);
                    }
                    // 백슬래시 정규화 (URL은 보통 슬래시이나 혹시 모를 경우)
                    path = path.replace('/', "\\");
                }
                return Some(path);
            }
        }
    }
    None
}

/// 파일 경로용 간단한 퍼센트 디코딩.
#[allow(dead_code)]
fn percent_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                if let Ok(byte) = u8::from_str_radix(
                    &format!("{}{}", h as char, l as char),
                    16,
                ) {
                    result.push(byte as char);
                    continue;
                }
            }
            result.push('%');
        } else {
            result.push(b as char);
        }
    }
    result
}
