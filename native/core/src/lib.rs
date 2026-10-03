//! Native session core, ABI v1. See `native/include/sshdock_core.h`.

mod input;
mod queue;
mod session;
mod ssh;
mod terminal;
#[cfg(windows)]
mod windows_job;

use base64::{Engine, engine::general_purpose::STANDARD};
use queue::EventQueue;
use serde::Deserialize;
use serde_json::{Value, json};
use session::{CreateParams, Session};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};
use tokio::runtime::Runtime;
use tokio_util::sync::CancellationToken;

type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug)]
struct CoreError {
    code: &'static str,
    message: String,
}

impl CoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(error: std::io::Error) -> Self {
        Self::new("io_error", error.to_string())
    }
}

#[derive(Deserialize)]
struct Request {
    method: String,
    #[serde(default = "empty_params")]
    params: Value,
}

fn empty_params() -> Value {
    json!({})
}

pub struct Core {
    sessions: Mutex<BTreeMap<String, Arc<ManagedSession>>>,
    queue: Arc<EventQueue>,
    runtime: Runtime,
    cancel: CancellationToken,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            sessions: Mutex::default(),
            queue: Arc::default(),
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("sshdock-ssh-runtime")
                .build()
                .expect("create SSH runtime"),
            cancel: CancellationToken::new(),
        }
    }
}

enum ManagedSession {
    Local(Session),
    Ssh(ssh::SshSession),
}
impl ManagedSession {
    fn id(&self) -> &str {
        match self {
            Self::Local(s) => s.id(),
            Self::Ssh(s) => s.id(),
        }
    }
    fn info(&self) -> Value {
        match self {
            Self::Local(s) => s.info(),
            Self::Ssh(s) => s.info(),
        }
    }
    fn disposable(&self) -> bool {
        match self {
            Self::Local(s) => s.disposable(),
            Self::Ssh(s) => s.disposable(),
        }
    }
    fn input(&self, bytes: &[u8]) -> CoreResult<()> {
        match self {
            Self::Local(s) => s.input(bytes),
            Self::Ssh(s) => s.input(bytes),
        }
    }
    fn resize(&self, cols: u16, rows: u16) -> CoreResult<()> {
        match self {
            Self::Local(s) => s.resize(cols, rows),
            Self::Ssh(s) => s.resize(cols, rows),
        }
    }
    fn close(&self) -> CoreResult<()> {
        match self {
            Self::Local(s) => s.close(),
            Self::Ssh(s) => {
                s.close();
                Ok(())
            }
        }
    }
    fn snapshot(&self) -> CoreResult<Value> {
        match self {
            Self::Local(s) => s.snapshot(),
            Self::Ssh(s) => s.snapshot(),
        }
    }
    fn scroll(&self, delta: Option<i32>) -> CoreResult<()> {
        match self {
            Self::Local(s) => s.scroll(delta),
            Self::Ssh(s) => s.scroll(delta),
        }
    }
}

impl Core {
    pub fn request(&self, json: &str) -> Value {
        let result = serde_json::from_str::<Request>(json)
            .map_err(|e| CoreError::new("invalid_json", e.to_string()))
            .and_then(|request| self.dispatch(request));
        match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => error_response(error),
        }
    }

    pub fn poll(&self) -> Value {
        Value::Array(self.queue.drain())
    }

    fn dispatch(&self, request: Request) -> CoreResult<Value> {
        if request.method == "core.info" {
            return Ok(json!({"abiVersion":1,"version":env!("CARGO_PKG_VERSION")}));
        }
        if request.method == "core.shutdown" {
            self.cancel.cancel();
            self.queue.shutdown();
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for session in sessions {
                let _ = session.close();
            }
            return Ok(json!({}));
        }
        if self.cancel.is_cancelled() {
            return Err(CoreError::new("CORE_STOPPED", "core has shut down"));
        }
        if request.method == "ssh.hostKey" {
            let params = serde_json::from_value(request.params)
                .map_err(|e| CoreError::new("invalid_params", e.to_string()))?;
            return self.runtime.block_on(ssh::host_key(params, &self.cancel));
        }
        if request.method == "local.create" || request.method == "ssh.connect" {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            // Closed tabs release their terminal history after the final event.
            sessions.retain(|_, session| !session.disposable());
            if sessions.len() >= 32 {
                return Err(CoreError::new(
                    "session_limit",
                    "close an existing session before creating another",
                ));
            }
            drop(sessions);
            let session = if request.method == "local.create" {
                let params: CreateParams = serde_json::from_value(request.params)
                    .map_err(|e| CoreError::new("invalid_params", e.to_string()))?;
                ManagedSession::Local(Session::create(params, self.queue.clone())?)
            } else {
                let params = serde_json::from_value(request.params)
                    .map_err(|e| CoreError::new("invalid_params", e.to_string()))?;
                ManagedSession::Ssh(self.runtime.block_on(ssh::SshSession::connect(
                    params,
                    self.queue.clone(),
                    self.runtime.handle().clone(),
                    &self.cancel,
                ))?)
            };
            let info = session.info();
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if sessions.len() >= 32 || self.cancel.is_cancelled() {
                let _ = session.close();
                return Err(CoreError::new(
                    "session_limit",
                    "core shut down or session limit reached",
                ));
            }
            sessions.insert(session.id().to_owned(), Arc::new(session));
            return Ok(info);
        }
        if request.method == "sessions.list" {
            let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            return Ok(Value::Array(sessions.values().map(|s| s.info()).collect()));
        }
        const METHODS: &[&str] = &[
            "sessions.input",
            "sessions.resize",
            "sessions.close",
            "terminal.snapshot",
            "terminal.scroll",
            "terminal.resetScroll",
            "sftp.home",
            "sftp.list",
            "sftp.mkdir",
            "sftp.remove",
            "sftp.upload",
            "sftp.download",
            "sftp.cancel",
            "stats.sample",
        ];
        if !METHODS.contains(&request.method.as_str()) {
            return Err(CoreError::new("unknown_method", "unsupported method"));
        }
        let id = request.params["sessionId"]
            .as_str()
            .ok_or_else(|| CoreError::new("invalid_params", "sessionId must be a string"))?;
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| CoreError::new("session_not_found", "session does not exist"))?;
        if request.method.starts_with("sftp.") || request.method == "stats.sample" {
            return match &*session {
                ManagedSession::Ssh(s) => s.request(&request.method, &request.params),
                ManagedSession::Local(_) => Err(CoreError::new(
                    "ssh_required",
                    "this operation requires an SSH session",
                )),
            };
        }
        match request.method.as_str() {
            "sessions.input" => {
                let data = request.params["data"].as_str().ok_or_else(|| {
                    CoreError::new("invalid_params", "data must contain base64 bytes")
                })?;
                if data.len() > 1_400_000 {
                    return Err(CoreError::new("invalid_params", "input exceeds 1 MiB"));
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|e| CoreError::new("invalid_params", e.to_string()))?;
                if bytes.len() > 1024 * 1024 {
                    return Err(CoreError::new("invalid_params", "input exceeds 1 MiB"));
                }
                session.input(&bytes)?;
            }
            "sessions.resize" => {
                let cols = dimension(&request.params, "cols")?;
                let rows = dimension(&request.params, "rows")?;
                session.resize(cols, rows)?;
            }
            "sessions.close" => session.close()?,
            "terminal.snapshot" => return session.snapshot(),
            "terminal.scroll" => {
                let delta = request.params["delta"]
                    .as_i64()
                    .and_then(|v| i32::try_from(v).ok())
                    .ok_or_else(|| {
                        CoreError::new("invalid_params", "delta must be a signed 32-bit integer")
                    })?;
                session.scroll(Some(delta))?;
            }
            "terminal.resetScroll" => session.scroll(None)?,
            _ => unreachable!(),
        }
        Ok(json!({}))
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // Wake blocked producers before joining sessions; no consumer remains.
        self.queue.shutdown();
        self.cancel.cancel();
        self.sessions
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

fn dimension(params: &Value, name: &'static str) -> CoreResult<u16> {
    params[name]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .ok_or_else(|| {
            CoreError::new(
                "invalid_params",
                format!("{name} must be an unsigned 16-bit integer"),
            )
        })
}

fn error_response(error: CoreError) -> Value {
    json!({"ok":false,"error":{"code":error.code,"message":error.message}})
}

fn result_string(value: Value) -> *mut c_char {
    // JSON escapes embedded NUL characters and therefore is always a C string.
    CString::new(value.to_string())
        .expect("JSON contains no NUL")
        .into_raw()
}

fn ffi_result(operation: impl FnOnce() -> Value) -> *mut c_char {
    let value = catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        error_response(CoreError::new(
            "internal_error",
            "native core operation panicked",
        ))
    });
    result_string(value)
}

/// Create an independently owned ABI v1 core. Returns null on allocation panic.
#[unsafe(no_mangle)]
pub extern "C" fn sshdock_core_create() -> *mut c_void {
    catch_unwind(|| Box::into_raw(Box::new(Core::default())).cast()).unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `core` is a live handle from create; `json` points to a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sshdock_core_request(
    core: *mut c_void,
    json: *const c_char,
) -> *mut c_char {
    ffi_result(|| {
        if core.is_null() || json.is_null() {
            return error_response(CoreError::new(
                "invalid_argument",
                "core and json must not be null",
            ));
        }
        let request = match unsafe { CStr::from_ptr(json) }.to_str() {
            Ok(request) => request,
            Err(_) => {
                return error_response(CoreError::new("invalid_argument", "json must be UTF-8"));
            }
        };
        unsafe { &*core.cast::<Core>() }.request(request)
    })
}

/// # Safety
/// `core` is a live handle from create, with no concurrent destruction.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sshdock_core_poll(core: *mut c_void) -> *mut c_char {
    ffi_result(|| {
        if core.is_null() {
            return error_response(CoreError::new("invalid_argument", "core must not be null"));
        }
        unsafe { &*core.cast::<Core>() }.poll()
    })
}

/// # Safety
/// `string` is null or an allocation returned by request/poll, released once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sshdock_core_string_free(string: *mut c_char) {
    if !string.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
            drop(CString::from_raw(string));
        }));
    }
}

/// # Safety
/// `core` is null or a live handle from create. Destroy exactly once, with all
/// requests/polls complete and no future use of the handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sshdock_core_destroy(core: *mut c_void) {
    if !core.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
            drop(Box::from_raw(core.cast::<Core>()));
        }));
    }
}
