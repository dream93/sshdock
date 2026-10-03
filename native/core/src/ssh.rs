//! SSH transport. All network work runs without the core session-map lock.
use crate::input::InputQueue;
use crate::queue::EventQueue;
use crate::session::validate_size;
use crate::terminal::Terminal;
use crate::{CoreError, CoreResult};
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const OP_TIMEOUT: Duration = Duration::from_secs(20);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TREE_ENTRIES: usize = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostParams {
    pub host: String,
    pub port: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    pub expected_fingerprint: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub terminal_engine: bool,
}
impl Drop for ConnectParams {
    fn drop(&mut self) {
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
        if let Some(passphrase) = self.passphrase.as_mut() {
            passphrase.zeroize();
        }
    }
}
fn load_private_key(path: &str, passphrase: Option<&str>) -> CoreResult<russh::keys::PrivateKey> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|e| CoreError::new("key_load_failed", e.to_string()))?;
    if !file.metadata().map_err(CoreError::io)?.is_file() {
        return Err(CoreError::new(
            "key_load_failed",
            "private key must be a regular file",
        ));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| CoreError::new("key_load_failed", e.to_string()))?;
    if bytes.len() > 1024 * 1024 {
        return Err(CoreError::new(
            "key_load_failed",
            "private key exceeds 1 MiB",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|e| CoreError::new("key_load_failed", e.to_string()))?;
    decode_secret_key(text, passphrase)
        .map_err(|e| CoreError::new("key_load_failed", e.to_string()))
}

struct HostHandler {
    expected: Option<String>,
    observed: Arc<Mutex<Option<Value>>>,
}
impl client::Handler for HostHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public = key.public_key();
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        *self.observed.lock().unwrap_or_else(|e| e.into_inner()) = Some(json!({
            "fingerprint":fingerprint,"algorithm":public.algorithm().to_string()
        }));
        // Probe deliberately rejects the key before authentication. Trust is
        // always an explicit fingerprint supplied by the frontend.
        Ok(self.expected.as_deref() == Some(fingerprint.as_str()))
    }
}
fn network_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new("ssh_error", error.to_string())
}
fn sftp_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new("sftp_error", error.to_string())
}
fn validate_host(host: &str, port: u16) -> CoreResult<()> {
    if host.trim().is_empty() || host.contains('\0') || port == 0 {
        Err(CoreError::new(
            "invalid_params",
            "host and nonzero port are required",
        ))
    } else {
        Ok(())
    }
}
fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    })
}
// russh starts a protocol task during key exchange. Keeping a duplicate socket
// solely for shutdown ensures that dropping a timed-out handshake also stops
// that task, rather than leaving its socket alive until an inactivity timer.
struct SocketGuard(TcpStream);
impl SocketGuard {
    fn shutdown(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}
async fn connect_transport(
    host: &str,
    port: u16,
    handler: HostHandler,
) -> CoreResult<(client::Handle<HostHandler>, SocketGuard)> {
    let stream = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(CoreError::io)?;
    stream.set_nodelay(true).map_err(CoreError::io)?;
    let standard = stream.into_std().map_err(CoreError::io)?;
    let guard = SocketGuard(standard.try_clone().map_err(CoreError::io)?);
    let stream = tokio::net::TcpStream::from_std(standard).map_err(CoreError::io)?;
    let handle = client::connect_stream(config(), stream, handler)
        .await
        .map_err(network_error)?;
    Ok((handle, guard))
}
pub(crate) async fn host_key(params: HostParams, cancel: &CancellationToken) -> CoreResult<Value> {
    validate_host(&params.host, params.port)?;
    let observed = Arc::new(Mutex::new(None));
    let handler = HostHandler {
        expected: None,
        observed: observed.clone(),
    };
    let result = bounded(cancel, OP_TIMEOUT, async {
        connect_transport(&params.host, params.port, handler).await
    })
    .await;
    if let Some(key) = observed.lock().unwrap_or_else(|e| e.into_inner()).take() {
        return Ok(key);
    }
    result
        .map(|_| json!({}))
        .and_then(|_| Err(CoreError::new("ssh_error", "server sent no host key")))
}
async fn bounded<T>(
    cancel: &CancellationToken,
    timeout: Duration,
    future: impl Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(CoreError::new("session_closed", "SSH operation cancelled because the session is closed")),
        result = tokio::time::timeout(timeout, future) => result.unwrap_or_else(|_| Err(CoreError::new("ssh_timeout", "SSH operation timed out")))
    }
}

struct Shared {
    id: String,
    title: String,
    input: InputQueue,
    terminal: Mutex<Option<Terminal>>,
    queue: Arc<EventQueue>,
    cancel: CancellationToken,
    finished: AtomicBool,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    connection: tokio::sync::Mutex<client::Handle<HostHandler>>,
    socket: SocketGuard,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
    transfers: Mutex<BTreeMap<String, CancellationToken>>,
}
pub(crate) struct SshSession {
    shared: Arc<Shared>,
    runtime: Handle,
    workers: Vec<JoinHandle<()>>,
}
impl SshSession {
    pub async fn connect(
        params: ConnectParams,
        queue: Arc<EventQueue>,
        runtime: Handle,
        core_cancel: &CancellationToken,
    ) -> CoreResult<Self> {
        validate_host(&params.host, params.port)?;
        validate_size(params.cols, params.rows)?;
        if params.username.trim().is_empty() || params.expected_fingerprint.is_empty() {
            return Err(CoreError::new(
                "invalid_params",
                "username and trusted expectedFingerprint are required",
            ));
        }
        if params.auth_type != "password" && params.auth_type != "key" {
            return Err(CoreError::new(
                "invalid_params",
                "authType must be password or key",
            ));
        }
        // Read/decrypt before starting the connection, so a malformed key never
        // leaves an authenticated network task behind. Do not log credentials.
        let private_key = if params.auth_type == "key" {
            let path = params
                .key_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| CoreError::new("invalid_params", "keyPath is required"))?;
            Some(load_private_key(
                path,
                params.passphrase.as_deref().filter(|p| !p.is_empty()),
            )?)
        } else {
            None
        };
        let observed = Arc::new(Mutex::new(None));
        let handler = HostHandler {
            expected: Some(params.expected_fingerprint.clone()),
            observed: observed.clone(),
        };
        let connection_result = bounded(core_cancel, OP_TIMEOUT, async {
            connect_transport(&params.host, params.port, handler).await
        })
        .await;
        let (mut connection, socket) = match connection_result {
            Ok(connection) => connection,
            Err(error) => {
                if let Some(actual) = observed.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                    && actual["fingerprint"] != params.expected_fingerprint
                {
                    return Err(CoreError::new(
                        "host_key_mismatch",
                        "SSH host key differs from the trusted fingerprint; verify the server identity",
                    ));
                }
                return Err(error);
            }
        };
        let setup_result = bounded(core_cancel, OP_TIMEOUT, async {
            let auth = if let Some(key) = private_key {
                let hash = connection
                    .best_supported_rsa_hash()
                    .await
                    .map_err(network_error)?
                    .flatten();
                connection
                    .authenticate_publickey(
                        &params.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(network_error)?
            } else {
                connection
                    .authenticate_password(
                        &params.username,
                        params.password.as_deref().unwrap_or_default(),
                    )
                    .await
                    .map_err(network_error)?
            };
            if !auth.success() {
                return Err(CoreError::new(
                    "ssh_auth_failed",
                    "SSH authentication was rejected",
                ));
            }
            let mut channel = connection
                .channel_open_session()
                .await
                .map_err(network_error)?;
            channel
                .request_pty(
                    true,
                    "xterm-256color",
                    u32::from(params.cols),
                    u32::from(params.rows),
                    0,
                    0,
                    &[],
                )
                .await
                .map_err(network_error)?;
            expect_success(&mut channel).await?;
            channel.request_shell(true).await.map_err(network_error)?;
            expect_success(&mut channel).await?;
            Ok(channel)
        })
        .await;
        let channel = match setup_result {
            Ok(channel) => channel,
            Err(error) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    connection.disconnect(Disconnect::ByApplication, "setup failed", "en"),
                )
                .await;
                return Err(error);
            }
        };
        let (mut reader, writer) = channel.split();
        let title = format!("{}@{}", params.username, params.host);
        let shared = Arc::new(Shared {
            id: Uuid::new_v4().to_string(),
            title: title.clone(),
            input: InputQueue::default(),
            terminal: Mutex::new(
                params
                    .terminal_engine
                    .then(|| Terminal::new(params.cols, params.rows, &title)),
            ),
            queue,
            cancel: core_cancel.child_token(),
            finished: AtomicBool::new(false),
            writer: Arc::new(writer),
            connection: tokio::sync::Mutex::new(connection),
            socket,
            sftp: tokio::sync::Mutex::new(None),
            transfers: Mutex::new(BTreeMap::new()),
        });
        let read_shared = shared.clone();
        let read_runtime = runtime.clone();
        let read_worker = std::thread::Builder::new().name("sshdock-ssh-read".into()).spawn(move || {
            let mut exit = None;
            read_runtime.block_on(async {
                loop {
                    let message = tokio::select! { biased; _ = read_shared.cancel.cancelled() => break, message = reader.wait() => message };
                    match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let replies = read_shared.terminal.lock().unwrap_or_else(|e| e.into_inner()).as_mut().map(|t| t.feed(&data)).unwrap_or_default();
                            for reply in replies {
                                if let Err(error) = read_shared.input.try_push(reply.as_bytes()) {
                                    read_shared.queue.push_cancellable(json!({"type":"error","sessionId":read_shared.id,"code":error.code,"message":error.message}), || read_shared.cancel.is_cancelled());
                                }
                            }
                            if !read_shared.queue.push_cancellable(json!({"type":"output","sessionId":read_shared.id,"data":STANDARD.encode(&data)}), || read_shared.cancel.is_cancelled()) { break; }
                        },
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                read_shared.cancel.cancel();
                read_shared.input.shutdown();
                let connection = read_shared.connection.lock().await;
                let _ = tokio::time::timeout(Duration::from_secs(1), connection.disconnect(Disconnect::ByApplication, "session closed", "en")).await;
            });
            read_shared.socket.shutdown();
            read_shared.queue.push(json!({"type":"closed","sessionId":read_shared.id,"exitCode":exit}));
            read_shared.finished.store(true, Ordering::Release);
        }).map_err(CoreError::io)?;
        let write_shared = shared.clone();
        let write_runtime = runtime.clone();
        let write_worker = match std::thread::Builder::new().name("sshdock-ssh-write".into()).spawn(move || {
            while let Some(bytes) = write_shared.input.pop() {
                let result = write_runtime.block_on(bounded(&write_shared.cancel, IO_TIMEOUT, async {
                    write_shared.writer.data(bytes.as_slice()).await.map_err(network_error)
                }));
                if let Err(error) = result {
                    if !write_shared.cancel.is_cancelled() {
                        write_shared.queue.push_cancellable(json!({"type":"error","sessionId":write_shared.id,"code":error.code,"message":error.message}), || write_shared.cancel.is_cancelled());
                    }
                    write_shared.cancel.cancel(); write_shared.input.shutdown(); break;
                }
            }
        }) {
            Ok(worker) => worker,
            Err(error) => { shared.cancel.cancel(); let _ = read_worker.join(); return Err(CoreError::io(error)); }
        };
        Ok(Self {
            shared,
            runtime,
            workers: vec![read_worker, write_worker],
        })
    }
    pub fn id(&self) -> &str {
        &self.shared.id
    }
    pub fn info(&self) -> Value {
        json!({"sessionId":self.shared.id,"title":self.shared.title,"cwd":".","kind":"ssh","closed":self.shared.finished.load(Ordering::Acquire)})
    }
    pub fn disposable(&self) -> bool {
        self.shared.cancel.is_cancelled() && self.shared.finished.load(Ordering::Acquire)
    }
    pub fn input(&self, data: &[u8]) -> CoreResult<()> {
        self.shared.input.try_push(data)
    }
    pub fn close(&self) {
        self.shared.cancel.cancel();
        self.shared.input.shutdown();
        self.shared.socket.shutdown();
    }
    pub fn resize(&self, cols: u16, rows: u16) -> CoreResult<()> {
        validate_size(cols, rows)?;
        self.runtime
            .block_on(bounded(&self.shared.cancel, OP_TIMEOUT, async {
                self.shared
                    .writer
                    .window_change(u32::from(cols), u32::from(rows), 0, 0)
                    .await
                    .map_err(network_error)
            }))?;
        if let Some(terminal) = self
            .shared
            .terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            terminal.resize(cols, rows);
        }
        Ok(())
    }
    pub fn snapshot(&self) -> CoreResult<Value> {
        self.shared
            .terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Terminal::snapshot)
            .ok_or_else(|| {
                CoreError::new(
                    "terminal_disabled",
                    "create the session with terminalEngine: true",
                )
            })
    }
    pub fn scroll(&self, delta: Option<i32>) -> CoreResult<()> {
        let mut terminal = self
            .shared
            .terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let terminal = terminal
            .as_mut()
            .ok_or_else(|| CoreError::new("terminal_disabled", "terminal engine is disabled"))?;
        if let Some(delta) = delta {
            terminal.scroll(delta);
        } else {
            terminal.reset_scroll();
        }
        Ok(())
    }
    pub fn request(&self, method: &str, params: &Value) -> CoreResult<Value> {
        if method == "sftp.cancel" {
            let id = string(params, "transferId")?;
            if let Some(cancel) = self
                .shared
                .transfers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(id)
            {
                cancel.cancel();
            }
            return Ok(json!({}));
        }
        if method == "sftp.upload" || method == "sftp.download" {
            return self.transfer(method, params);
        }
        self.runtime.block_on(bounded(&self.shared.cancel, OP_TIMEOUT, async {
            if method == "stats.sample" { return sample_stats(&self.shared).await; }
            let sftp = get_sftp(&self.shared).await?;
            match method {
                "sftp.home" => Ok(json!({"path":sftp.canonicalize(".").await.map_err(sftp_error)?})),
                "sftp.list" => {
                    let path = sftp.canonicalize(string(params, "path")?).await.map_err(sftp_error)?;
                    let mut entries = vec![];
                    for entry in sftp.read_dir(&path).await.map_err(sftp_error)? {
                        safe_remote_name(&entry.file_name())?;
                        let attr = entry.metadata();
                        entries.push(json!({"name":entry.file_name(),"path":entry.path(),"isDirectory":attr.is_dir(),"isSymlink":attr.is_symlink(),"size":attr.size.unwrap_or(0),"modified":attr.mtime}));
                        if entries.len() > MAX_TREE_ENTRIES { return Err(CoreError::new("sftp_limit", "directory exceeds 100000 entries")); }
                    }
                    Ok(json!({"path":path,"entries":entries}))
                },
                "sftp.mkdir" => { sftp.create_dir(string(params,"path")?).await.map_err(sftp_error)?; Ok(json!({})) },
                "sftp.remove" => { remove_tree(&sftp, string(params,"path")?).await?; Ok(json!({})) },
                _ => Err(CoreError::new("unknown_method", "unsupported method"))
            }
        }))
    }
    fn transfer(&self, method: &str, params: &Value) -> CoreResult<Value> {
        let transfer_id = string(params, "transferId")?.to_owned();
        let local = PathBuf::from(string(params, "localPath")?);
        let remote = string(params, "remotePath")?.to_owned();
        let cancel = self.shared.cancel.child_token();
        {
            let mut transfers = self
                .shared
                .transfers
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if transfers.contains_key(&transfer_id) {
                return Err(CoreError::new(
                    "transfer_exists",
                    "transferId is already active",
                ));
            }
            transfers.insert(transfer_id.clone(), cancel.clone());
        }
        let mut progress = Progress {
            shared: &self.shared,
            cancel: &cancel,
            id: &transfer_id,
            transferred: 0,
            total: 0,
            last: Instant::now(),
        };
        let result = self.runtime.block_on(async {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(CoreError::new("transfer_cancelled", "file transfer cancelled; partial destinations may remain")),
                result = transfer_tree(method == "sftp.upload", &self.shared, &local, &remote, &mut progress) => result
            }
        });
        self.shared
            .transfers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&transfer_id);
        progress.emit(
            if result.is_ok() {
                "completed"
            } else {
                "failed"
            },
            result.as_ref().err().map(|e| e.message.as_str()),
        );
        result.map(|_| json!({"transferred":progress.transferred,"total":progress.total}))
    }
}
impl Drop for SshSession {
    fn drop(&mut self) {
        self.close();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}
async fn expect_success(channel: &mut russh::Channel<client::Msg>) -> CoreResult<()> {
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Success => return Ok(()),
            ChannelMsg::Failure | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Err(CoreError::new(
        "ssh_request_failed",
        "server rejected the PTY or shell request",
    ))
}
async fn get_sftp(shared: &Shared) -> CoreResult<Arc<SftpSession>> {
    let mut cached = shared.sftp.lock().await;
    if let Some(sftp) = &*cached {
        return Ok(sftp.clone());
    }
    let channel = shared
        .connection
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(network_error)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(network_error)?;
    let sftp = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .map_err(sftp_error)?,
    );
    sftp.set_timeout(IO_TIMEOUT.as_secs());
    *cached = Some(sftp.clone());
    Ok(sftp)
}
fn string<'a>(params: &'a Value, name: &str) -> CoreResult<&'a str> {
    params[name]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .ok_or_else(|| {
            CoreError::new(
                "invalid_params",
                format!("{name} must be a nonempty string"),
            )
        })
}
fn safe_remote_name(name: &str) -> CoreResult<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains(':')
    {
        return Err(CoreError::new(
            "unsafe_filename",
            "remote filename cannot safely be represented locally",
        ));
    }
    Ok(())
}
fn safe_name(name: &str) -> CoreResult<()> {
    safe_remote_name(name)?;
    #[cfg(windows)]
    {
        // Windows device names remain reserved even with an extension. Trailing
        // spaces/dots alias other paths, so they cannot represent a unique file.
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches([' ', '.'])
            .to_ascii_uppercase();
        let serial_device = ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if name.ends_with([' ', '.'])
            || name
                .chars()
                .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || serial_device
        {
            return Err(CoreError::new(
                "unsafe_filename",
                "filename is reserved or aliases another path on Windows",
            ));
        }
    }
    Ok(())
}
fn remote_join(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}
async fn reject_local_symlink_ancestors(path: &Path) -> CoreResult<()> {
    for ancestor in path.ancestors() {
        match tokio::fs::symlink_metadata(ancestor).await {
            Ok(metadata) if metadata.is_symlink() => {
                return Err(CoreError::new(
                    "sftp_destination_type",
                    "refusing to write through a local symbolic link",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::io(error)),
        }
    }
    Ok(())
}
async fn remove_tree(sftp: &SftpSession, path: &str) -> CoreResult<()> {
    // An explicit tree stack avoids recursive futures and never traverses a symlink.
    let mut pending = vec![(path.to_owned(), false, 0usize)];
    let mut count = 0;
    while let Some((path, visited, depth)) = pending.pop() {
        count += 1;
        if count > MAX_TREE_ENTRIES * 2 || depth > 128 {
            return Err(CoreError::new("sftp_limit", "tree exceeds 100000 entries"));
        }
        if visited {
            sftp.remove_dir(path).await.map_err(sftp_error)?;
            continue;
        }
        let attr = sftp.symlink_metadata(&path).await.map_err(sftp_error)?;
        if attr.is_dir() && !attr.is_symlink() {
            pending.push((path.clone(), true, depth));
            for entry in sftp.read_dir(&path).await.map_err(sftp_error)? {
                safe_remote_name(&entry.file_name())?;
                pending.push((entry.path(), false, depth + 1));
            }
        } else {
            sftp.remove_file(path).await.map_err(sftp_error)?;
        }
    }
    Ok(())
}
struct Progress<'a> {
    shared: &'a Shared,
    cancel: &'a CancellationToken,
    id: &'a str,
    transferred: u64,
    total: u64,
    last: Instant,
}
impl Progress<'_> {
    fn emit(&mut self, state: &str, message: Option<&str>) {
        self.shared.queue.push_cancellable(json!({"type":"transfer","sessionId":self.shared.id,"transferId":self.id,"transferred":self.transferred,"total":self.total,"state":state,"message":message}), || self.cancel.is_cancelled());
        self.last = Instant::now();
    }
    fn add(&mut self, bytes: usize) {
        self.transferred += bytes as u64;
        if self.last.elapsed() >= Duration::from_millis(200) {
            self.emit("running", None);
        }
    }
}
async fn timed<T>(
    future: impl Future<Output = Result<T, impl std::fmt::Display>>,
) -> CoreResult<T> {
    tokio::time::timeout(IO_TIMEOUT, future)
        .await
        .map_err(|_| {
            CoreError::new(
                "ssh_timeout",
                "file transfer made no progress for 30 seconds",
            )
        })?
        .map_err(sftp_error)
}
async fn transfer_tree(
    upload: bool,
    shared: &Shared,
    local: &Path,
    remote: &str,
    progress: &mut Progress<'_>,
) -> CoreResult<()> {
    let sftp = bounded(&shared.cancel, OP_TIMEOUT, get_sftp(shared)).await?;
    // Resolve the user-selected parent once, including OS aliases such as
    // /tmp -> /private/tmp on macOS. Children derived from remote names never
    // use canonicalize; each existing descendant must be a real directory.
    let destination = if upload {
        local.to_path_buf()
    } else {
        let parent = local
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = tokio::fs::canonicalize(parent)
            .await
            .map_err(CoreError::io)?;
        let name = local.file_name().ok_or_else(|| {
            CoreError::new(
                "invalid_params",
                "download destination must have a filename",
            )
        })?;
        #[cfg(windows)]
        safe_name(name.to_str().ok_or_else(|| {
            CoreError::new("unsafe_filename", "download filename must be UTF-8")
        })?)?;
        let destination = parent.join(name);
        reject_local_symlink_ancestors(&destination).await?;
        destination
    };
    let mut pending = vec![(destination, remote.to_owned(), 0usize)];
    let mut files = vec![];
    let mut directories = vec![];
    let mut count = 0;
    while let Some((local, remote, depth)) = pending.pop() {
        count += 1;
        if count > MAX_TREE_ENTRIES || depth > 128 {
            return Err(CoreError::new("sftp_limit", "tree exceeds 100000 entries"));
        }
        if upload {
            let attr = tokio::fs::symlink_metadata(&local)
                .await
                .map_err(CoreError::io)?;
            if attr.is_symlink() {
                return Err(CoreError::new(
                    "symlink_transfer_unsupported",
                    "uploading symbolic links is not supported",
                ));
            }
            if attr.is_dir() {
                directories.push((local.clone(), remote.clone()));
                let mut entries = tokio::fs::read_dir(&local).await.map_err(CoreError::io)?;
                while let Some(entry) = entries.next_entry().await.map_err(CoreError::io)? {
                    let name = entry.file_name().into_string().map_err(|_| {
                        CoreError::new("unsafe_filename", "local filename must be UTF-8")
                    })?;
                    safe_name(&name)?;
                    pending.push((entry.path(), remote_join(&remote, &name), depth + 1));
                }
            } else if attr.is_file() {
                progress.total = progress.total.saturating_add(attr.len());
                files.push((local, remote));
            } else {
                return Err(CoreError::new(
                    "sftp_file_type",
                    "only regular files and directories may be transferred",
                ));
            }
        } else {
            let attr = timed(sftp.symlink_metadata(&remote)).await?;
            if attr.is_symlink() {
                return Err(CoreError::new(
                    "symlink_transfer_unsupported",
                    "downloading symbolic links is not supported",
                ));
            }
            if attr.is_dir() {
                directories.push((local.clone(), remote.clone()));
                for entry in timed(sftp.read_dir(&remote)).await? {
                    let name = entry.file_name();
                    safe_name(&name)?;
                    pending.push((local.join(&name), entry.path(), depth + 1));
                }
            } else if attr.is_regular() {
                progress.total = progress.total.saturating_add(attr.size.unwrap_or(0));
                files.push((local, remote));
            } else {
                return Err(CoreError::new(
                    "sftp_file_type",
                    "only regular files and directories may be transferred",
                ));
            }
        }
    }
    progress.emit("running", None);
    for (local, remote) in directories {
        if upload {
            // Never turn an existing remote symlink into a traversal destination.
            match timed(sftp.symlink_metadata(&remote)).await {
                Ok(attr) if attr.is_dir() && !attr.is_symlink() => {}
                Ok(_) => {
                    return Err(CoreError::new(
                        "sftp_destination_type",
                        "remote destination is not a directory",
                    ));
                }
                Err(_) => timed(sftp.create_dir(remote)).await?,
            }
        } else {
            match tokio::fs::symlink_metadata(&local).await {
                Ok(attr) if attr.is_dir() && !attr.is_symlink() => {}
                Ok(_) => {
                    return Err(CoreError::new(
                        "sftp_destination_type",
                        "local destination is not a directory",
                    ));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    tokio::fs::create_dir(&local).await.map_err(CoreError::io)?
                }
                Err(e) => return Err(CoreError::io(e)),
            }
        }
    }
    let mut buffer = vec![0; 64 * 1024];
    for (local, remote) in files {
        if upload {
            if let Ok(attr) = timed(sftp.symlink_metadata(&remote)).await
                && attr.is_symlink()
            {
                return Err(CoreError::new(
                    "sftp_destination_type",
                    "refusing to overwrite a remote symlink",
                ));
            }
            let mut source = tokio::fs::File::open(local).await.map_err(CoreError::io)?;
            let mut target = timed(sftp.create(remote)).await?;
            loop {
                let count = source.read(&mut buffer).await.map_err(CoreError::io)?;
                if count == 0 {
                    break;
                }
                timed(target.write_all(&buffer[..count])).await?;
                progress.add(count);
            }
            timed(target.shutdown()).await?;
        } else {
            if let Ok(attr) = tokio::fs::symlink_metadata(&local).await
                && attr.is_symlink()
            {
                return Err(CoreError::new(
                    "sftp_destination_type",
                    "refusing to overwrite a local symlink",
                ));
            }
            reject_local_symlink_ancestors(&local).await?;
            let mut source = timed(sftp.open(remote)).await?;
            let mut target = tokio::fs::File::create(local)
                .await
                .map_err(CoreError::io)?;
            loop {
                let count = timed(source.read(&mut buffer)).await?;
                if count == 0 {
                    break;
                }
                target
                    .write_all(&buffer[..count])
                    .await
                    .map_err(CoreError::io)?;
                progress.add(count);
            }
            target.flush().await.map_err(CoreError::io)?;
            timed(source.shutdown()).await?;
        }
    }
    Ok(())
}
async fn sample_stats(shared: &Shared) -> CoreResult<Value> {
    let mut channel = shared
        .connection
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(network_error)?;
    // No interpolated user values. Marker boundaries allow strict parsing and
    // a safe unsupported result for non-Linux hosts rather than bogus zeros.
    channel.exec(true, "if [ \"$(uname -s)\" = Linux ]; then printf 'SSHD_CPU\\n'; head -n 1 /proc/stat; printf 'SSHD_MEM\\n'; cat /proc/meminfo; printf 'SSHD_NET\\n'; cat /proc/net/dev; printf 'SSHD_LOAD\\n'; cat /proc/loadavg; else printf 'SSHD_UNSUPPORTED\\n'; fi").await.map_err(network_error)?;
    expect_success(&mut channel).await?;
    // ChannelStream owns a close-on-drop guard. A timeout therefore closes this
    // exec channel while preserving the interactive terminal connection.
    let mut stream = channel.into_stream();
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = stream.read(&mut chunk).await.map_err(CoreError::io)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 128 * 1024 {
            return Err(CoreError::new(
                "stats_invalid",
                "statistics response exceeds 128 KiB",
            ));
        }
    }
    parse_stats(&String::from_utf8_lossy(&bytes))
}
fn parse_stats(text: &str) -> CoreResult<Value> {
    if text.contains("SSHD_UNSUPPORTED") {
        return Ok(json!({"supported":false}));
    }
    let mut section = "";
    let (mut cpu_total, mut cpu_idle, mut mem_total, mut mem_available, mut rx, mut tx, mut load) =
        (None, None, None, None, 0u64, 0u64, None);
    for line in text.lines() {
        if line.starts_with("SSHD_") {
            section = line;
            continue;
        }
        if section == "SSHD_CPU" && line.starts_with("cpu ") {
            let values = line
                .split_whitespace()
                .skip(1)
                .take(8)
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| CoreError::new("stats_invalid", e.to_string()))?;
            if values.len() >= 4 {
                cpu_total = Some(
                    values
                        .iter()
                        .fold(0u64, |total, value| total.saturating_add(*value)),
                );
                cpu_idle = Some(values[3].saturating_add(values.get(4).copied().unwrap_or(0)));
            }
        } else if section == "SSHD_MEM" {
            let mut words = line.split_whitespace();
            let key = words.next().unwrap_or("");
            let value = words
                .next()
                .and_then(|n| n.parse::<u64>().ok())
                .and_then(|n| n.checked_mul(1024));
            if key == "MemTotal:" {
                mem_total = value;
            } else if key == "MemAvailable:" {
                mem_available = value;
            }
        } else if section == "SSHD_NET" {
            if let Some((interface, counters)) = line.split_once(':')
                && interface.trim() != "lo"
            {
                let values = counters.split_whitespace().collect::<Vec<_>>();
                rx = rx.saturating_add(values.first().and_then(|n| n.parse().ok()).unwrap_or(0));
                tx = tx.saturating_add(values.get(8).and_then(|n| n.parse().ok()).unwrap_or(0));
            }
        } else if section == "SSHD_LOAD" {
            load = line
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<f64>().ok());
        }
    }
    if cpu_total.is_none()
        || cpu_idle.is_none()
        || mem_total.is_none()
        || mem_available.is_none()
        || load.is_none()
    {
        return Ok(json!({"supported":false}));
    }
    Ok(
        json!({"supported":true,"cpuTotal":cpu_total,"cpuIdle":cpu_idle,"memTotal":mem_total,"memAvailable":mem_available,"rx":rx,"tx":tx,"load1":load}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statistics_units_and_guest_time_are_correct() {
        let value=parse_stats("SSHD_CPU\ncpu 10 20 30 40 5 6 7 8 9 10\nSSHD_MEM\nMemTotal: 1024 kB\nMemAvailable: 512 kB\nSSHD_NET\nlo: 99 0 0 0 0 0 0 0 88\neth0: 12 0 0 0 0 0 0 0 34\nSSHD_LOAD\n1.25 0 0\n").unwrap();
        assert_eq!(value["cpuTotal"], 126);
        assert_eq!(value["cpuIdle"], 45);
        assert_eq!(value["memTotal"], 1048576);
        assert_eq!(value["rx"], 12);
        assert_eq!(value["tx"], 34);
        assert_eq!(
            parse_stats("SSHD_UNSUPPORTED").unwrap(),
            json!({"supported":false})
        );
    }
    #[test]
    fn reject_remote_path_traversal_names() {
        for name in ["..", "../secret", "a/b", "a\\b", "C:secret", ""] {
            assert!(safe_name(name).is_err());
        }
        assert!(safe_name("中文文件.txt").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn reject_windows_devices_aliases_and_forbidden_characters() {
        for name in [
            "NUL",
            "nul.txt",
            "CON",
            "con.tar.gz",
            "PRN",
            "aux.log",
            "COM1",
            "com9.bin",
            "LPT1",
            "lpt9.txt",
            "COM¹",
            "LPT³.txt",
            "name.",
            "name ",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "a\u{001f}b",
        ] {
            assert!(safe_name(name).is_err(), "must reject {name:?}");
        }
        for name in ["COM10.txt", "console.txt", "中文.txt", ".hidden"] {
            assert!(safe_name(name).is_ok());
        }
        // Remote names must remain browsable/deletable even if not downloadable.
        assert!(safe_remote_name("NUL.txt").is_ok());
    }
    #[cfg(not(windows))]
    #[test]
    fn preserve_posix_filenames_which_windows_cannot_represent() {
        for name in [
            "NUL",
            "CON.txt",
            "COM1",
            "LPT9",
            "a<b",
            "a?b",
            "trailing.",
            "trailing ",
        ] {
            assert!(safe_name(name).is_ok());
        }
    }
}
