//! Real encrypted SSH/SFTP protocol fixtures, independent of a system sshd.
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::keys::{
    PrivateKey, PublicKey,
    ssh_key::{Algorithm, LineEnding},
};
use russh::server::{Auth, Session};
use russh::{Channel, ChannelId, server};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode,
};
use serde_json::{Value, json};
use sshdock_core::Core;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

struct Fixture {
    runtime: tokio::runtime::Runtime,
    port: u16,
    root: tempfile::TempDir,
    key: PrivateKey,
    auth_calls: Arc<AtomicUsize>,
    size: Arc<Mutex<(u32, u32)>>,
}
impl Fixture {
    fn new() -> Self {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let server_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let config = Arc::new(server::Config {
            keys: vec![server_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let auth_calls = Arc::new(AtomicUsize::new(0));
        let size = Arc::new(Mutex::new((0, 0)));
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let path = root.path().to_owned();
        let public = key.public_key().clone();
        let auth = auth_calls.clone();
        let sizes = size.clone();
        runtime.spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = FixtureSsh {
                    channels: HashMap::new(),
                    shells: HashSet::new(),
                    root: path.clone(),
                    public: public.clone(),
                    auth_calls: auth.clone(),
                    size: sizes.clone(),
                };
                let config = config.clone();
                tokio::spawn(async move {
                    let _ = server::run_stream(config, stream, handler).await;
                });
            }
        });
        Self {
            runtime,
            port,
            root,
            key,
            auth_calls,
            size,
        }
    }
    fn params(&self, core: &Core) -> Value {
        let host = result(
            core,
            "ssh.hostKey",
            json!({"host":"127.0.0.1","port":self.port}),
        );
        assert_eq!(
            self.auth_calls.load(Ordering::Acquire),
            0,
            "probe must never authenticate"
        );
        json!({"host":"127.0.0.1","port":self.port,"username":"fixture","authType":"password","password":"secret","expectedFingerprint":host["fingerprint"],"cols":80,"rows":24,"terminalEngine":true})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = &self.runtime;
    }
}
struct FixtureSsh {
    channels: HashMap<ChannelId, Channel<server::Msg>>,
    shells: HashSet<ChannelId>,
    root: PathBuf,
    public: PublicKey,
    auth_calls: Arc<AtomicUsize>,
    size: Arc<Mutex<(u32, u32)>>,
}
impl server::Handler for FixtureSsh {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.auth_calls.fetch_add(1, Ordering::AcqRel);
        Ok(if user == "fixture" && password == "secret" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        self.auth_calls.fetch_add(1, Ordering::AcqRel);
        Ok(if user == "fixture" && *key == self.public {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.size.lock().unwrap() = (cols, rows);
        session.channel_success(channel)?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        cols: u32,
        rows: u32,
        _pw: u32,
        _ph: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.size.lock().unwrap() = (cols, rows);
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.shells.insert(channel);
        session.channel_success(channel)?;
        session.data(channel, b"fixture ready\r\n".to_vec())?;
        Ok(())
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.shells.contains(&channel) {
            return Ok(());
        }
        if data.contains(&3) {
            session.data(channel, b"interrupted\r\n".to_vec())?;
        } else if data.starts_with(b"exit") {
            session.exit_status_request(channel, 7)?;
            session.eof(channel)?;
            session.close(channel)?;
        } else if data.starts_with(b"flood") {
            for _ in 0..600 {
                session.data(channel, vec![b'x'; 16 * 1024])?;
            }
            if data.starts_with(b"floodexit") {
                session.exit_status_request(channel, 7)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
        } else {
            session.data(channel, b"executed: \xe4\xb8\xad\xe6\x96\x87\r\n".to_vec())?;
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"SSHD_UNSUPPORTED\n".to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            session.channel_success(channel)?;
            let channel = self.channels.remove(&channel).unwrap();
            let fixture = FixtureSftp {
                root: self.root.clone(),
                files: HashMap::new(),
                read_dirs: HashSet::new(),
            };
            tokio::spawn(russh_sftp::server::run(channel.into_stream(), fixture));
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }
}
struct FixtureSftp {
    root: PathBuf,
    files: HashMap<String, std::fs::File>,
    read_dirs: HashSet<String>,
}
fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: "en".into(),
    }
}
fn ioerr(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        StatusCode::NoSuchFile
    } else {
        StatusCode::Failure
    }
}
impl FixtureSftp {
    fn path(&self, path: &str) -> Result<PathBuf, StatusCode> {
        let relative = path.trim_start_matches('/');
        if Path::new(relative).components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        }) {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(self.root.join(relative))
    }
}
impl russh_sftp::server::Handler for FixtureSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(if path == "." { "/".into() } else { path })],
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let attrs = std::fs::symlink_metadata(self.path(&path)?).map_err(ioerr)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&attrs),
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let attrs = std::fs::metadata(self.path(&path)?).map_err(ioerr)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&attrs),
        })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.path(&path)?).map_err(ioerr)?;
        Ok(status(id))
    }
    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.path(&path)?).map_err(ioerr)?;
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.path(&path)?).map_err(ioerr)?;
        Ok(status(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        std::fs::read_dir(self.path(&path)?).map_err(ioerr)?;
        self.read_dirs.remove(&path);
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        if !self.read_dirs.insert(handle.clone()) {
            return Err(StatusCode::Eof);
        }
        if handle == "/evil" {
            return Ok(Name {
                id,
                files: vec![File::new("../escape", FileAttributes::default())],
            });
        }
        let mut files = vec![];
        for entry in std::fs::read_dir(self.path(&handle)?).map_err(ioerr)? {
            let entry = entry.map_err(ioerr)?;
            let attr = std::fs::symlink_metadata(entry.path()).map_err(ioerr)?;
            files.push(File::new(
                entry.file_name().to_string_lossy().into_owned(),
                FileAttributes::from(&attr),
            ));
        }
        Ok(Name { id, files })
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let file = std::fs::OpenOptions::new()
            .read(flags.contains(OpenFlags::READ))
            .write(flags.contains(OpenFlags::WRITE))
            .create(flags.contains(OpenFlags::CREATE))
            .truncate(flags.contains(OpenFlags::TRUNCATE))
            .open(self.path(&filename)?)
            .map_err(ioerr)?;
        let handle = format!("file-{id}");
        self.files.insert(handle.clone(), file);
        Ok(Handle { id, handle })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        Ok(status(id))
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let attrs = self
            .files
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .metadata()
            .map_err(ioerr)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes::from(&attrs),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(ioerr)?;
        let mut data = vec![0; len as usize];
        let count = file.read(&mut data).map_err(ioerr)?;
        if count == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(count);
        Ok(Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        tokio::time::sleep(Duration::from_millis(3)).await;
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(ioerr)?;
        file.write_all(&data).map_err(ioerr)?;
        Ok(status(id))
    }
}
fn request(core: &Core, method: &str, params: Value) -> Value {
    core.request(&json!({"method":method,"params":params}).to_string())
}
fn result(core: &Core, method: &str, params: Value) -> Value {
    let response = request(core, method, params);
    assert_eq!(response["ok"], true, "{method}: {response}");
    response["result"].clone()
}
fn input(core: &Core, id: &str, data: &[u8]) {
    result(
        core,
        "sessions.input",
        json!({"sessionId":id,"data":STANDARD.encode(data)}),
    );
}
fn wait_output(core: &Core, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut bytes = vec![];
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["type"] == "output" {
                bytes.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            }
        }
        if String::from_utf8_lossy(&bytes).contains(needle) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "missing output {needle}: {}",
        String::from_utf8_lossy(&bytes)
    );
}

#[test]
fn encrypted_ssh_authentication_pty_resize_and_exit() {
    let fixture = Fixture::new();
    let core = Core::default();
    let mut params = fixture.params(&core);
    let good_fingerprint = params["expectedFingerprint"].clone();
    params["expectedFingerprint"] = json!("SHA256:untrusted");
    assert_eq!(
        request(&core, "ssh.connect", params.clone())["error"]["code"],
        "host_key_mismatch"
    );
    assert_eq!(fixture.auth_calls.load(Ordering::Acquire), 0);
    params["expectedFingerprint"] = good_fingerprint;
    params["password"] = json!("wrong");
    assert_eq!(
        request(&core, "ssh.connect", params.clone())["error"]["code"],
        "ssh_auth_failed"
    );
    params["password"] = json!("secret");
    let id = result(&core, "ssh.connect", params.clone())["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_output(&core, "fixture ready");
    input(&core, &id, b"command\r");
    wait_output(&core, "executed: 中文");
    input(&core, &id, b"\x03");
    wait_output(&core, "interrupted");
    result(
        &core,
        "sessions.resize",
        json!({"sessionId":id,"cols":121,"rows":39}),
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while *fixture.size.lock().unwrap() != (121, 39) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(*fixture.size.lock().unwrap(), (121, 39));
    assert_eq!(
        result(&core, "stats.sample", json!({"sessionId":id}))["supported"],
        false
    );
    input(&core, &id, b"exit\r");
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut closed = false;
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["type"] == "closed" && event["sessionId"] == id {
                assert_eq!(event["exitCode"], 7);
                closed = true;
            }
        }
        if closed {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(closed);
    let key_path = fixture.root.path().join("encrypted_key");
    fixture
        .key
        .encrypt(&mut rand::rng(), "口令")
        .unwrap()
        .write_openssh_file(&key_path, LineEnding::LF)
        .unwrap();
    params["authType"] = json!("key");
    params["keyPath"] = json!(key_path);
    params["passphrase"] = json!("wrong");
    assert_eq!(
        request(&core, "ssh.connect", params.clone())["error"]["code"],
        "key_load_failed"
    );
    params["passphrase"] = json!("口令");
    let encrypted_id = result(&core, "ssh.connect", params)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    result(&core, "sessions.close", json!({"sessionId":encrypted_id}));
}
#[test]
fn sftp_unicode_recursive_roundtrip_cancel_and_symlink_guards() {
    let fixture = Fixture::new();
    let core = Arc::new(Core::default());
    let params = fixture.params(&core);
    let id = result(&core, "ssh.connect", params)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let local = tempfile::tempdir().unwrap();
    let upload = local.path().join("中文目录");
    std::fs::create_dir(&upload).unwrap();
    std::fs::create_dir(upload.join("子目录")).unwrap();
    std::fs::write(upload.join("子目录/空文件"), b"").unwrap();
    let contents = "中文文件\n".repeat(20000);
    std::fs::write(upload.join("文本.txt"), contents.as_bytes()).unwrap();
    assert_eq!(
        result(&core, "sftp.home", json!({"sessionId":id}))["path"],
        "/"
    );
    result(
        &core,
        "sftp.upload",
        json!({"sessionId":id,"localPath":upload,"remotePath":"/中文目录","transferId":"upload"}),
    );
    let listing = result(
        &core,
        "sftp.list",
        json!({"sessionId":id,"path":"/中文目录"}),
    );
    assert_eq!(listing["entries"].as_array().unwrap().len(), 2);
    let download = local.path().join("下载");
    result(
        &core,
        "sftp.download",
        json!({"sessionId":id,"localPath":download,"remotePath":"/中文目录","transferId":"download"}),
    );
    assert_eq!(
        std::fs::read(download.join("文本.txt")).unwrap(),
        contents.as_bytes()
    );
    assert_eq!(
        std::fs::metadata(download.join("子目录/空文件"))
            .unwrap()
            .len(),
        0
    );
    #[cfg(windows)]
    {
        assert_eq!(
            request(
                &core,
                "sftp.download",
                json!({"sessionId":id,"localPath":local.path().join("NUL.txt"),"remotePath":"/中文目录/文本.txt","transferId":"device_filename"})
            )["error"]["code"],
            "unsafe_filename",
            "a single-file download must not bypass Windows filename validation"
        );
    }
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("sentinel"), b"preserve").unwrap();
        std::os::unix::fs::symlink(outside.path(), fixture.root.path().join("中文目录/外链"))
            .unwrap();
        assert_eq!(
            request(
                &core,
                "sftp.download",
                json!({"sessionId":id,"localPath":local.path().join("bad"),"remotePath":"/中文目录","transferId":"symlink"})
            )["error"]["code"],
            "symlink_transfer_unsupported"
        );
        let deep = local.path().join("deep");
        std::fs::create_dir(&deep).unwrap();
        let mut path = deep.clone();
        for _ in 0..130 {
            path = path.join("a");
            std::fs::create_dir(&path).unwrap();
        }
        assert_eq!(
            request(
                &core,
                "sftp.upload",
                json!({"sessionId":id,"localPath":deep,"remotePath":"/deep","transferId":"deep"})
            )["error"]["code"],
            "sftp_limit"
        );
        std::os::unix::fs::symlink(outside.path(), local.path().join("local_link")).unwrap();
        assert_eq!(
            request(
                &core,
                "sftp.download",
                json!({"sessionId":id,"localPath":local.path().join("local_link"),"remotePath":"/中文目录/文本.txt","transferId":"target_link"})
            )["error"]["code"],
            "sftp_destination_type"
        );
        result(
            &core,
            "sftp.remove",
            json!({"sessionId":id,"path":"/中文目录"}),
        );
        assert_eq!(
            std::fs::read(outside.path().join("sentinel")).unwrap(),
            b"preserve"
        );
        std::os::unix::fs::symlink(outside.path(), upload.join("upload_link")).unwrap();
        assert_eq!(
            request(
                &core,
                "sftp.upload",
                json!({"sessionId":id,"localPath":upload,"remotePath":"/upload_link","transferId":"upload_link"})
            )["error"]["code"],
            "symlink_transfer_unsupported"
        );
    }
    std::fs::create_dir(fixture.root.path().join("evil")).unwrap();
    assert_eq!(
        request(
            &core,
            "sftp.download",
            json!({"sessionId":id,"localPath":local.path().join("evil_download"),"remotePath":"/evil","transferId":"unsafe"})
        )["error"]["code"],
        "unsafe_filename"
    );
    assert!(!local.path().join("escape").exists());
    let large = local.path().join("large");
    std::fs::write(&large, vec![42; 16 * 1024 * 1024]).unwrap();
    let transfer_core = core.clone();
    let transfer_id = id.clone();
    let worker = std::thread::spawn(move || {
        request(
            &transfer_core,
            "sftp.upload",
            json!({"sessionId":transfer_id,"localPath":large,"remotePath":"/large","transferId":"cancel"}),
        )
    });
    std::thread::sleep(Duration::from_millis(80));
    let before = Instant::now();
    input(&core, &id, b"interactive-during-transfer\r");
    assert!(before.elapsed() < Duration::from_secs(1));
    result(
        &core,
        "sftp.cancel",
        json!({"sessionId":id,"transferId":"cancel"}),
    );
    assert_eq!(
        worker.join().unwrap()["error"]["code"],
        "transfer_cancelled"
    );
    wait_output(&core, "executed: 中文");
    input(&core, &id, b"flood\r");
    std::thread::sleep(Duration::from_millis(200));
    let before = Instant::now();
    result(&core, "sessions.close", json!({"sessionId":id}));
    result(&core, "core.shutdown", json!({}));
    assert!(before.elapsed() < Duration::from_secs(1));
    assert_eq!(
        request(&core, "local.create", json!({"cols":80,"rows":24}))["error"]["code"],
        "CORE_STOPPED"
    );
    drop(core);
}
#[test]
fn natural_exit_after_full_output_preserves_final_closed_event() {
    let fixture = Fixture::new();
    let core = Core::default();
    let params = fixture.params(&core);
    let id = result(&core, "ssh.connect", params)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    wait_output(&core, "fixture ready");
    input(&core, &id, b"floodexit\r");
    std::thread::sleep(Duration::from_millis(200));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = 0usize;
    let mut closed = false;
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["sessionId"] != id {
                continue;
            }
            if event["type"] == "output" {
                assert!(!closed);
                output += STANDARD
                    .decode(event["data"].as_str().unwrap())
                    .unwrap()
                    .len();
            }
            if event["type"] == "closed" {
                assert_eq!(event["exitCode"], 7);
                closed = true;
            }
        }
        if closed {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(closed, "closed event must survive full output backpressure");
    assert_eq!(output, 600 * 16 * 1024);
}
#[test]
fn shutdown_interrupts_handshake_and_closes_socket() {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket.write_all(b"SSH-2.0-stalled-fixture\r\n").unwrap();
        let mut buffer = [0; 4096];
        loop {
            match socket.read(&mut buffer) {
                Ok(0) => {
                    tx.send(true).unwrap();
                    break;
                }
                Ok(_) => {}
                Err(_) => {
                    tx.send(false).unwrap();
                    break;
                }
            }
        }
    });
    let core = Arc::new(Core::default());
    let request_core = core.clone();
    let worker = std::thread::spawn(move || {
        request(
            &request_core,
            "ssh.hostKey",
            json!({"host":"127.0.0.1","port":port}),
        )
    });
    std::thread::sleep(Duration::from_millis(100));
    result(&core, "core.shutdown", json!({}));
    assert_eq!(worker.join().unwrap()["error"]["code"], "session_closed");
    assert!(rx.recv_timeout(Duration::from_secs(3)).unwrap());
    server.join().unwrap();
}
