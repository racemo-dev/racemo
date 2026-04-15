/// Minimal HTTP REST API server for the Tauri frontend.
/// Runs on 127.0.0.1:7399/api alongside the Unix-socket IPC server.
use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

const HTTP_PORT: u16 = 7399;
const MAX_RECENT_DIRS: usize = 10;

/// Mutex to protect recent_dirs file from concurrent read-modify-write races.
static RECENT_DIRS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

#[derive(Serialize)]
struct HomeDirResponse {
    path: String,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    #[serde(rename = "type")]
    entry_type: String,
}

struct ApiError(String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        log::warn!("HTTP API error: {}", self.0);
        (StatusCode::BAD_REQUEST, "Bad request").into_response()
    }
}

/// 서버 사이드 recent_dirs JSON 파일 경로
fn recent_dirs_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("racemo")
        .join("recent_dirs.json")
}

fn load_recent_dirs() -> Vec<String> {
    let path = recent_dirs_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
            return list;
        }
    }
    vec![]
}

fn save_recent_dirs(dirs: &[String]) {
    let path = recent_dirs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(dirs) {
        let _ = std::fs::write(&path, json);
    }
}

/// Validate that the requested path is under the user's home directory.
fn validate_path(path: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let requested = std::path::Path::new(path)
        .canonicalize()
        .map_err(|_| "Invalid path".to_string())?;
    if !requested.starts_with(&home) {
        return Err("Access denied".to_string());
    }
    Ok(requested)
}

async fn handle_home_dir() -> Json<HomeDirResponse> {
    let path = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string());
    Json(HomeDirResponse { path })
}

async fn handle_list_directory(Query(params): Query<PathQuery>) -> Result<Json<Vec<DirEntry>>, ApiError> {
    use std::fs;
    let dir = validate_path(&params.path).map_err(ApiError)?;
    if !dir.is_dir() {
        return Ok(Json(vec![]));
    }
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                dirs.push(DirEntry { name, entry_type: "dir".into() });
            } else {
                files.push(DirEntry { name, entry_type: "file".into() });
            }
        }
    }
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(Json(dirs))
}

async fn handle_git_info(
    Query(params): Query<PathQuery>,
) -> Result<Json<crate::git::GitRepoInfo>, ApiError> {
    let validated = validate_path(&params.path).map_err(ApiError)?;
    crate::git::get_repo_info(&validated.to_string_lossy())
        .map(Json)
        .map_err(ApiError)
}

async fn handle_git_status(
    Query(params): Query<PathQuery>,
) -> Result<Json<crate::git::GitFileStatuses>, ApiError> {
    let validated = validate_path(&params.path).map_err(ApiError)?;
    crate::git::get_file_statuses(&validated.to_string_lossy())
        .map(Json)
        .map_err(ApiError)
}

/// GET /api/recent_dirs — 탭으로 열었던 폴더 목록 반환
async fn handle_get_recent_dirs() -> Json<Vec<String>> {
    let _guard = RECENT_DIRS_LOCK.lock().await;
    Json(load_recent_dirs())
}

#[derive(Deserialize)]
struct AddRecentDirBody {
    path: String,
}

/// POST /api/recent_dirs — 새 폴더를 목록 맨 앞에 추가
async fn handle_post_recent_dirs(Json(body): Json<AddRecentDirBody>) -> StatusCode {
    let dir = body.path.trim().to_string();
    if dir.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = RECENT_DIRS_LOCK.lock().await;
    let mut list = load_recent_dirs();
    list.retain(|d| !d.eq_ignore_ascii_case(&dir));
    list.insert(0, dir);
    list.truncate(MAX_RECENT_DIRS);
    save_recent_dirs(&list);
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct DeleteRecentDirBody {
    path: String,
}

/// DELETE /api/recent_dirs — 특정 폴더를 목록에서 제거
async fn handle_delete_recent_dirs(Json(body): Json<DeleteRecentDirBody>) -> StatusCode {
    let dir = body.path.trim().to_string();
    if dir.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let _guard = RECENT_DIRS_LOCK.lock().await;
    let mut list = load_recent_dirs();
    list.retain(|d| !d.eq_ignore_ascii_case(&dir));
    save_recent_dirs(&list);
    StatusCode::NO_CONTENT
}

pub async fn run_http_server() {
    let cors = CorsLayer::new()
        .allow_origin([
            "tauri://localhost".parse().expect("valid origin"),
            "https://tauri.localhost".parse().expect("valid origin"),
        ])
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/api/home_dir", get(handle_home_dir))
        .route("/api/recent_dirs", get(handle_get_recent_dirs).post(handle_post_recent_dirs).delete(handle_delete_recent_dirs))
        .route("/api/list_directory", get(handle_list_directory))
        .route("/api/git/info", get(handle_git_info))
        .route("/api/git/status", get(handle_git_status))
        .layer(cors);

    let addr = format!("127.0.0.1:{}", HTTP_PORT);
    log::info!("HTTP API server starting on http://{}", addr);
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("HTTP server error: {e}");
            }
        }
        Err(e) => {
            log::warn!("HTTP server failed to bind to {}: {e}", addr);
        }
    }
}
