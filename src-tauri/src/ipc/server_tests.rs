#[cfg(test)]
#[cfg(windows)]
mod tests {
    use std::io::Read;

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use crate::ipc::osc7::{extract_osc7_path, parse_osc7_from_stream};

    #[test]
    fn test_ps_dir_output_via_conpty() {
        // Run 'dir' through a real ConPTY and capture raw output bytes.
        // This tests whether ConPTY injects cursor parking sequences.
        let pty_system = native_pty_system();
        let rows: u16 = 30;
        let cols: u16 = 120;
        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        let pair = pty_system.openpty(size).expect("Failed to open PTY");

        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "dir $env:SystemRoot\\System32\\drivers\\etc; exit"]);

        let mut child = pair.slave.spawn_command(cmd).expect("Failed to spawn");
        drop(pair.slave);

        // ConPTY reader may not EOF when shell exits, so use a thread with timeout.
        let mut reader = pair.master.try_clone_reader().expect("Failed to clone reader");
        let reader_handle = std::thread::spawn(move || {
            let mut all_output = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => all_output.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            all_output
        });

        // Wait for child in a separate thread
        let child_handle = std::thread::spawn(move || {
            let _ = child.wait();
        });
        let _ = child_handle.join();
        // Small delay to let reader flush remaining data
        std::thread::sleep(std::time::Duration::from_millis(500));
        // Drop master to close the PTY, which signals EOF to reader.
        drop(pair.master);
        let all_output = match reader_handle.join() {
            Ok(data) => data,
            Err(_) => panic!("Reader thread panicked"),
        };

        let output_str = String::from_utf8_lossy(&all_output);

        // Check for cursor parking: ESC[{rows};{cols}H pattern
        let parking_pattern = format!("\x1b[{};{}H", rows, cols);
        let parking_count = output_str.matches(&parking_pattern).count();

        // Print diagnostic info
        eprintln!("--- ConPTY dir output ({} bytes) ---", all_output.len());
        eprintln!("Parking pattern '\\x1b[{};{}H' found {} times", rows, cols, parking_count);

        // Hex dump of first 2000 bytes for inspection
        let dump_len = all_output.len().min(2000);
        for chunk_start in (0..dump_len).step_by(16) {
            let chunk_end = (chunk_start + 16).min(dump_len);
            let hex: Vec<String> = all_output[chunk_start..chunk_end]
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();
            let ascii: String = all_output[chunk_start..chunk_end]
                .iter()
                .map(|&b| if (0x20..=0x7e).contains(&b) { b as char } else { '.' })
                .collect();
            eprintln!("{:04x}  {:48}  {}", chunk_start, hex.join(" "), ascii);
        }

        // Also look for any CUP (Cursor Position) sequences
        let cup_regex = regex_lite_find_all_cup(&all_output);
        eprintln!("\nAll CUP sequences found:");
        for (pos, seq) in &cup_regex {
            eprintln!("  offset {:04x}: {}", pos, seq);
        }

        // This test documents ConPTY behavior rather than asserting a fix.
        // If parking_count > 0, ConPTY IS injecting cursor parking.
        eprintln!("\n=== RESULT: ConPTY parking sequences present: {} ===", parking_count > 0);
    }

    #[test]
    fn test_ps_dir_output_large_pty() {
        // Test with large PTY size similar to user's actual terminal (50x196)
        run_conpty_dir_test(50, 196, false);
    }

    #[test]
    fn test_ps_dir_output_with_profile() {
        // Test WITH user profile loaded (no -NoProfile)
        run_conpty_dir_test(50, 196, true);
    }

    fn run_conpty_dir_test(rows: u16, cols: u16, load_profile: bool) {
        let pty_system = native_pty_system();
        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        let pair = pty_system.openpty(size).expect("Failed to open PTY");

        let mut cmd = CommandBuilder::new("powershell.exe");
        let mut args = vec!["-NoLogo"];
        if !load_profile {
            args.push("-NoProfile");
        }
        args.extend_from_slice(&["-NonInteractive", "-Command",
            "dir $env:SystemRoot\\System32\\drivers\\etc; exit"]);
        cmd.args(args);

        let mut child = pair.slave.spawn_command(cmd).expect("Failed to spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("Failed to clone reader");
        let reader_handle = std::thread::spawn(move || {
            let mut all_output = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => all_output.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            all_output
        });

        let child_handle = std::thread::spawn(move || {
            let _ = child.wait();
        });
        let _ = child_handle.join();
        std::thread::sleep(std::time::Duration::from_millis(500));
        drop(pair.master);
        let all_output = reader_handle.join().expect("Reader thread panicked");

        let output_str = String::from_utf8_lossy(&all_output);
        let parking_pattern = format!("\x1b[{};{}H", rows, cols);
        let parking_count = output_str.matches(&parking_pattern).count();

        eprintln!("\n--- ConPTY dir test ({}x{}, profile={}) ---", rows, cols, load_profile);
        eprintln!("Output: {} bytes, parking '\\x1b[{};{}H' count: {}", all_output.len(), rows, cols, parking_count);

        let cups = regex_lite_find_all_cup(&all_output);
        eprintln!("All CUP sequences ({}):", cups.len());
        for (pos, seq) in &cups {
            eprintln!("  offset {:04x}: {}", pos, seq);
        }

        // Also check for any CUP with row matching PTY height
        let row_str = format!("{}", rows);
        let suspicious: Vec<_> = cups.iter().filter(|(_, s)| {
            s.strip_prefix("ESC[")
                .and_then(|s| s.strip_suffix('H'))
                .and_then(|s| s.split(';').next())
                .map(|r| r == row_str)
                .unwrap_or(false)
        }).collect();
        if !suspicious.is_empty() {
            eprintln!("Suspicious CUP (row={}): {:?}", rows, suspicious);
        }
        eprintln!("=== RESULT: parking present={}, suspicious CUP={} ===\n", parking_count > 0, suspicious.len());
    }


    // ===== parse_osc7_from_stream / extract_osc7_path 테스트 =====

    #[test]
    fn test_parse_osc7_single_path() {
        // 완전한 OSC 7 시퀀스 하나: ESC ] 7 ; file://host/path BEL
        let data = b"\x1b]7;file://MYPC/C:/Users/test\x07";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], r"C:\Users\test");
    }

    #[test]
    fn test_parse_osc7_st_terminator() {
        // ST(ESC \) 종료: ESC가 오면 시퀀스 종료
        let data = b"\x1b]7;file://host/C:/work\x1b\\";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], r"C:\work");
    }

    #[test]
    fn test_parse_osc7_multiple_paths() {
        // 스트림에 OSC 7이 두 개
        let data = b"some output\x1b]7;file://h/C:/a\x07more\x1b]7;file://h/C:/b\x07";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], r"C:\a");
        assert_eq!(paths[1], r"C:\b");
    }

    #[test]
    fn test_parse_osc7_split_across_chunks() {
        // 청크 경계에서 분할: 첫 번째 청크에서 시퀀스 시작, 두 번째에서 종료
        let chunk1 = b"\x1b]7;file://host/C:/sp";
        let chunk2 = b"lit/path\x07";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();

        let paths1 = parse_osc7_from_stream(chunk1, &mut in_osc7, &mut osc_buf);
        assert!(paths1.is_empty(), "첫 청크에선 아직 완성 안 됨");
        assert!(in_osc7, "OSC 7 파싱 중 상태여야 함");

        let paths2 = parse_osc7_from_stream(chunk2, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths2.len(), 1);
        assert_eq!(paths2[0], r"C:\split\path");
        assert!(!in_osc7, "시퀀스 종료 후 false");
    }

    #[test]
    fn test_parse_osc7_no_sequence() {
        // OSC 7이 없는 일반 데이터
        let data = b"hello world\r\n\x1b[31mred\x1b[0m";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert!(paths.is_empty());
        assert!(!in_osc7);
    }

    #[test]
    fn test_parse_osc7_incomplete_prefix() {
        // ESC ] 까지만 있고 '7;'이 아닌 경우 (예: ESC ] 0 ; title)
        let data = b"\x1b]0;window title\x07";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert!(paths.is_empty());
    }

    #[test]
    fn test_parse_osc7_overflow_protection() {
        // 4096 바이트 초과 시 버퍼 리셋
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b]7;");
        data.extend_from_slice(&vec![b'A'; 5000]);
        data.push(0x07);
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(&data, &mut in_osc7, &mut osc_buf);
        assert!(paths.is_empty(), "4096 초과 시퀀스는 무시해야 함");
        assert!(!in_osc7);
    }

    #[test]
    fn test_parse_osc7_percent_encoded_path() {
        // 퍼센트 인코딩된 경로 (공백 = %20)
        let data = b"\x1b]7;file://host/C:/My%20Documents/work\x07";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], r"C:\My Documents\work");
    }

    #[test]
    fn test_parse_osc7_mixed_with_other_escapes() {
        // 다른 ESC 시퀀스와 섞인 경우
        let data = b"\x1b[32mgreen\x1b[0m\x1b]7;file://h/C:/ok\x07\x1b[1mtext";
        let mut in_osc7 = false;
        let mut osc_buf = Vec::new();
        let paths = parse_osc7_from_stream(data, &mut in_osc7, &mut osc_buf);
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0], r"C:\ok");
    }

    #[test]
    fn test_extract_osc7_path_basic() {
        let path = extract_osc7_path("file://hostname/C:/Users/test");
        assert_eq!(path, Some(r"C:\Users\test".to_string()));
    }

    #[test]
    fn test_extract_osc7_path_no_file_prefix() {
        let path = extract_osc7_path("http://example.com/path");
        assert_eq!(path, None);
    }

    #[test]
    fn test_extract_osc7_path_empty_path() {
        // file://hostname 만 있고 / 없음
        let path = extract_osc7_path("file://hostname");
        assert_eq!(path, None);
    }

    #[test]
    fn test_extract_osc7_path_percent_decode() {
        let path = extract_osc7_path("file://h/C:/My%20Dir/sub%2Fdir");
        assert_eq!(path, Some(r"C:\My Dir\sub\dir".to_string()));
    }

    /// Find all CSI H (CUP) sequences in raw bytes: ESC [ <params> H
    fn regex_lite_find_all_cup(data: &[u8]) -> Vec<(usize, String)> {
        let mut results = Vec::new();
        let mut i = 0;
        while i < data.len() {
            if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'[' {
                let start = i;
                i += 2;
                let mut params = String::new();
                while i < data.len() && (data[i].is_ascii_digit() || data[i] == b';') {
                    params.push(data[i] as char);
                    i += 1;
                }
                if i < data.len() && data[i] == b'H' {
                    results.push((start, format!("ESC[{}H", params)));
                    i += 1;
                } else {
                    i = start + 1; // backtrack, not a CUP
                }
            } else {
                i += 1;
            }
        }
        results
    }
}
