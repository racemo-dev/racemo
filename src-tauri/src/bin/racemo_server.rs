// Hide console window on Windows (always)
#![cfg_attr(windows, windows_subsystem = "windows")]

use racemo_lib::ipc::protocol::default_socket_path;
use racemo_lib::ipc::server::run_server;

fn main() {
    // Windows: log to file in AppData
    #[cfg(windows)]
    {
        use std::io::Write;
        struct FlushingWriter<W: Write>(W);
        impl<W: Write> Write for FlushingWriter<W> {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let n = self.0.write(buf)?;
                let _ = self.0.flush();
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.0.flush()
            }
        }

        let log_path = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("racemo")
            .join("server.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            env_logger::Builder::from_env(
                env_logger::Env::default().default_filter_or("info"),
            )
            .format(|buf, record| {
                use std::io::Write;
                writeln!(
                    buf,
                    "{} [{}] - {}",
                    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S"),
                    record.level(),
                    record.args()
                )
            })
            .target(env_logger::Target::Pipe(Box::new(FlushingWriter(file))))
            .init();
            log::info!("=== racemo-server log started (flushing): {:?} ===", log_path);
        }
    }

    // Unix: log to file so the daemon's output is captured even when spawned
    // by Tauri with stdout/stderr redirected to /dev/null.
    #[cfg(not(windows))]
    {
        use std::io::Write;
        struct FlushingWriter<W: Write>(W);
        impl<W: Write> Write for FlushingWriter<W> {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let n = self.0.write(buf)?;
                let _ = self.0.flush();
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.0.flush()
            }
        }

        let log_path = dirs::data_local_dir()
            .or_else(dirs::data_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("racemo")
            .join("server.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let target = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map(|file| env_logger::Target::Pipe(Box::new(FlushingWriter(file))))
            .unwrap_or(env_logger::Target::Stdout);

        env_logger::Builder::from_env(
            env_logger::Env::default().default_filter_or("info"),
        )
        .format(|buf, record| {
            use std::io::Write;
            writeln!(
                buf,
                "{} [{}] {} - {}",
                chrono::Local::now().format("%Y-%m-%dT%H:%M:%S"),
                record.level(),
                record.target(),
                record.args()
            )
        })
        .target(target)
        .init();
        log::info!("=== racemo-server log started: {:?} ===", log_path);
    }

    let socket_path = default_socket_path();
    log::info!("Starting racemo-server on {socket_path}");

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    log::info!("Tokio runtime created, entering block_on");
    rt.block_on(async {
        tokio::spawn(async {
            racemo_lib::http_api::run_http_server().await;
        });

        if let Err(e) = run_server(&socket_path).await {
            log::error!("Server error: {e}");
            std::process::exit(1);
        }
    });
}
