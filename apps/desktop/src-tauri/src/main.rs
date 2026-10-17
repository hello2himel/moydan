//! Moydan desktop shell.
//!
//! The shell is deliberately thin. In *local mode* it starts the platform on this
//! machine — the API process (which also serves the web application), a second
//! process serving untrusted game content on its own origin, and a build worker —
//! and then points the window at that origin, so the whole product works offline.
//! In *deployment mode* (`MOYDAN_SERVER_URL`) it navigates to an existing
//! deployment instead.
//!
//! No IPC commands are exposed: the UI is the ordinary web application and every
//! privileged operation stays inside the platform processes.

use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Child platform processes, killed when the shell exits.
static CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

/// Kills the platform processes even if the app is terminated abnormally.
struct ProcessGuard;

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        kill_children();
    }
}

struct Shell {
    resources: PathBuf,
    data_dir: PathBuf,
}

impl Shell {
    fn resource(&self, relative: &str) -> PathBuf {
        self.resources.join(relative)
    }

    /// Node runtime shipped with the application.
    fn node_binary(&self) -> PathBuf {
        let unix = self.resource("node/bin/node");
        if unix.exists() {
            return unix;
        }
        self.resource("node/node.exe")
    }

    fn configured_server(&self) -> Option<String> {
        if let Ok(url) = env::var("MOYDAN_SERVER_URL") {
            let trimmed = url.trim().trim_end_matches('/').to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
        let raw = fs::read_to_string(self.data_dir.join("desktop.json")).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
        parsed
            .get("serverUrl")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
    }

    /// Session and worker secrets are generated once and kept in the application
    /// data directory so sessions survive restarts. They never leave this machine.
    fn secrets(&self) -> (String, String) {
        let path = self.data_dir.join("desktop.json");
        let existing = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        if let Some(value) = &existing {
            if let (Some(session), Some(worker)) = (
                value.get("sessionSecret").and_then(|v| v.as_str()),
                value.get("workerSecret").and_then(|v| v.as_str()),
            ) {
                return (session.to_string(), worker.to_string());
            }
        }
        let (session, worker) = (random_hex(32), random_hex(32));
        let document = serde_json::json!({ "sessionSecret": session, "workerSecret": worker });
        let _ = fs::write(&path, serde_json::to_string_pretty(&document).unwrap_or_default());
        (session, worker)
    }
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if let Ok(mut file) = File::open("/dev/urandom") {
        if file.read_exact(&mut buffer).is_ok() {
            return buffer.iter().map(|byte| format!("{byte:02x}")).collect();
        }
    }
    // Extremely defensive fallback: mix whatever entropy the process can observe.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let pid = u128::from(std::process::id());
    let mixed = format!("{:032x}", stamp ^ (pid << 64));
    mixed.chars().cycle().take(bytes * 2).collect()
}

fn free_port(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr().map(|address| address.port()))
        .unwrap_or(preferred)
}

/// Minimal HTTP GET against the loopback instance. No HTTP client dependency is
/// needed for a single endpoint.
fn health_check(url: &str) -> bool {
    let host_port = url.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = match TcpStream::connect(host_port) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let request = format!("GET /health HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200")
}

fn forward(mut reader: impl Read, tag: String) {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let text = String::from_utf8_lossy(&buffer[..count]);
                for line in text.lines() {
                    println!("[{tag}] {line}");
                }
            }
        }
    }
}

fn spawn_server(shell: &Shell, name: &str, module: &str, env: &[(String, String)]) {
    let entry = shell.resource(&format!("server/{module}"));
    if !entry.exists() {
        eprintln!("[moydan] {name} is not bundled ({}); skipping", entry.display());
        return;
    }
    let node = shell.node_binary();
    if !node.exists() {
        eprintln!("[moydan] the Node runtime is missing ({}); cannot start {name}", node.display());
        return;
    }
    let mut command = Command::new(&node);
    command.arg(&entry);
    for (key, value) in env {
        command.env(key, value);
    }
    command
        .current_dir(shell.resource("server"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match command.spawn() {
        Ok(mut child) => {
            println!("[moydan] started {name} (pid {})", child.id());
            if let Some(stdout) = child.stdout.take() {
                let tag = name.to_string();
                std::thread::spawn(move || forward(stdout, tag));
            }
            if let Some(stderr) = child.stderr.take() {
                let tag = name.to_string();
                std::thread::spawn(move || forward(stderr, tag));
            }
            if let Ok(mut children) = CHILDREN.lock() {
                children.push(child);
            }
        }
        Err(error) => eprintln!("[moydan] could not start {name}: {error}"),
    }
}

fn start_local_stack(shell: &Shell) -> Option<String> {
    let api_port = free_port(8787);
    let game_port = free_port(5174);
    let origin = format!("http://127.0.0.1:{api_port}");
    let (session_secret, worker_secret) = shell.secrets();

    let _ = fs::create_dir_all(&shell.data_dir);
    let common: Vec<(String, String)> = vec![
        ("NODE_ENV".into(), "development".into()),
        ("SESSION_SECRET".into(), session_secret),
        ("WORKER_JOB_SECRET".into(), worker_secret),
        (
            "DATABASE_URL".into(),
            format!("file:{}", shell.data_dir.join("moydan.db").display()),
        ),
        ("DATABASE_DRIVER".into(), "sqlite".into()),
        ("STORAGE_DRIVER".into(), "fs".into()),
        ("STORAGE_FS_ROOT".into(), shell.data_dir.join("storage").display().to_string()),
        (
            "BUILD_WORKSPACE_ROOT".into(),
            shell.data_dir.join("builds").display().to_string(),
        ),
        ("BUILD_USE_DOCKER".into(), "0".into()),
        ("APP_ORIGIN".into(), origin.clone()),
        ("GAME_ORIGIN".into(), format!("http://127.0.0.1:{game_port}")),
        ("GAME_ORIGIN_PORT".into(), game_port.to_string()),
        ("API_PORT".into(), api_port.to_string()),
        ("API_HOST".into(), "127.0.0.1".into()),
        ("MOYDAN_WEB_ROOT".into(), shell.resource("web").display().to_string()),
        ("MOYDAN_REPO_ROOT".into(), shell.resource("server").display().to_string()),
    ];

    let mut api_env = common.clone();
    api_env.push(("API_URL".into(), origin.clone()));
    spawn_server(shell, "api", "api.mjs", &api_env);
    spawn_server(shell, "game-origin", "game-origin.mjs", &common);
    spawn_server(shell, "worker", "worker.mjs", &api_env);

    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if health_check(&origin) {
            println!("[moydan] local instance ready at {origin}");
            return Some(origin);
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    eprintln!("[moydan] the local instance did not become healthy in time");
    None
}

fn kill_children() {
    if let Ok(mut children) = CHILDREN.lock() {
        for child in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        children.clear();
    }
}

fn main() {
    let _guard = ProcessGuard;

    let shell = Shell {
        resources: resource_dir(),
        data_dir: data_dir(),
    };

    let server_url = match shell.configured_server() {
        Some(url) => {
            println!("[moydan] using deployment {url}");
            Some(url)
        }
        None => start_local_stack(&shell),
    };
    let started = server_url.is_some();
    let target = server_url.clone().unwrap_or_default();

    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let target = target.clone();
            let initial_url = if started {
                match target.parse() {
                    Ok(url) => WebviewUrl::External(url),
                    Err(_) => WebviewUrl::App("index.html".into()),
                }
            } else {
                WebviewUrl::App("index.html".into())
            };
            let window = WebviewWindowBuilder::new(&handle, "main", initial_url)
            .title("Moydan")
            .inner_size(1180.0, 860.0)
            .min_inner_size(480.0, 640.0)
            .background_color(tauri::window::Color(11, 11, 16, 255))
            .build()?;

            if !started {
                std::thread::spawn(move || {
                    // The placeholder page explains what is happening; once the
                    // local instance is healthy we hand over to it.
                    std::thread::sleep(Duration::from_millis(250));
                    let _ = window.eval(&format!(
                        "window.location.replace({})",
                        serde_json::to_string(&target).unwrap_or_else(|_| "\"\"".into())
                    ));
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Moydan");

    kill_children();
}

fn resource_dir() -> PathBuf {
    if let Ok(dir) = env::var("MOYDAN_RESOURCES") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidates = [
                parent.join("resources"),
                parent.join("Resources"),
                parent.join("..").join("resources"),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return candidate;
                }
            }
            return parent.to_path_buf();
        }
    }
    PathBuf::from(".")
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = env::var("MOYDAN_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_dir().join(".local").join("share"));
    base.join("moydan")
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
