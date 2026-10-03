use crate::input::InputQueue;
use crate::queue::EventQueue;
use crate::terminal::Terminal;
use crate::{CoreError, CoreResult};
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(windows)]
use portable_pty::ChildKiller;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateParams {
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub shell: Option<String>,
    #[serde(default)]
    pub terminal_engine: bool,
}

struct Resources {
    // Drop the job first: descendants must terminate before ConPTY is released.
    #[cfg(windows)]
    job: Option<crate::windows_job::ProcessJob>,
    master: Option<Box<dyn MasterPty + Send>>,
}

struct Shared {
    id: String,
    title: String,
    cwd: String,
    resources: Mutex<Resources>,
    #[cfg(windows)]
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    input: InputQueue,
    terminal: Mutex<Option<Terminal>>,
    queue: Arc<EventQueue>,
    close_requested: AtomicBool,
    finished: AtomicBool,
    // Waiter holds this mutex while checking/reaping. Close checks the same
    // state before signaling, so it never signals a PID which has been reaped.
    exit: Mutex<Option<Option<u32>>>,
    exited: Condvar,
    #[cfg(unix)]
    pid: Option<u32>,
}

pub(crate) struct Session {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
}

impl Session {
    pub fn create(params: CreateParams, queue: Arc<EventQueue>) -> CoreResult<Self> {
        validate_size(params.cols, params.rows)?;
        let cwd = match params.cwd {
            Some(cwd) => PathBuf::from(cwd),
            None => std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(CoreError::io)?),
        };
        let cwd = cwd.canonicalize().map_err(CoreError::io)?;
        if !cwd.is_dir() {
            return Err(CoreError::new("invalid_params", "cwd must be a directory"));
        }
        let shell = params.shell.unwrap_or_else(default_shell);
        if shell.is_empty() {
            return Err(CoreError::new("invalid_params", "shell must not be empty"));
        }
        #[cfg(windows)]
        let cwd = shell_cwd(cwd, &shell)?;
        let title = PathBuf::from(&shell)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| shell.clone());
        let pty = native_pty_system()
            .openpty(pty_size(params.cols, params.rows))
            .map_err(|e| CoreError::new("pty_open_failed", e.to_string()))?;
        let reader = PtyReader::new(&*pty.master)?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| CoreError::new("pty_open_failed", e.to_string()))?;
        let mut command = CommandBuilder::new(&shell);
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        #[cfg(unix)]
        command.arg("-l");
        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| CoreError::new("spawn_failed", e.to_string()))?;
        let child = ChildGuard(Some(child));
        drop(pty.slave);
        let process = child.0.as_ref().unwrap();
        #[cfg(windows)]
        let job = crate::windows_job::ProcessJob::new(
            process
                .as_raw_handle()
                .ok_or_else(|| CoreError::new("process_job_failed", "missing process handle"))?,
        )?;
        let terminal = params
            .terminal_engine
            .then(|| Terminal::new(params.cols, params.rows, &title));
        let shared = Arc::new(Shared {
            id: Uuid::new_v4().to_string(),
            title,
            cwd: cwd.to_string_lossy().into_owned(),
            resources: Mutex::new(Resources {
                master: Some(pty.master),
                #[cfg(windows)]
                job: Some(job),
            }),
            #[cfg(windows)]
            killer: Mutex::new(process.clone_killer()),
            #[cfg(unix)]
            pid: process.process_id(),
            input: InputQueue::default(),
            terminal: Mutex::new(terminal),
            queue,
            close_requested: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            exit: Mutex::new(None),
            exited: Condvar::new(),
        });
        let read_shared = shared.clone();
        let read_worker = std::thread::Builder::new()
            .name("sshdock-pty-read".into())
            .spawn(move || read_output(read_shared, reader))
            .map_err(CoreError::io)?;
        let write_shared = shared.clone();
        let write_worker = match std::thread::Builder::new()
            .name("sshdock-pty-write".into())
            .spawn(move || write_worker(write_shared, writer))
        {
            Ok(worker) => worker,
            Err(error) => {
                let _ = stop(&shared);
                drop(child);
                *shared.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
                shared.exited.notify_all();
                shared
                    .resources
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .master
                    .take();
                let _ = read_worker.join();
                return Err(CoreError::io(error));
            }
        };
        let wait_shared = shared.clone();
        let wait_worker = match std::thread::Builder::new()
            .name("sshdock-pty-wait".into())
            .spawn(move || wait_child(wait_shared, child))
        {
            Ok(worker) => worker,
            Err(error) => {
                shared.close_requested.store(true, Ordering::Release);
                shared.input.shutdown();
                *shared.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
                shared.exited.notify_all();
                let resources = std::mem::replace(
                    &mut *shared.resources.lock().unwrap_or_else(|e| e.into_inner()),
                    empty_resources(),
                );
                drop(resources);
                let _ = read_worker.join();
                let _ = write_worker.join();
                return Err(CoreError::io(error));
            }
        };
        Ok(Self {
            shared,
            workers: vec![read_worker, write_worker, wait_worker],
        })
    }

    pub fn id(&self) -> &str {
        &self.shared.id
    }

    pub fn info(&self) -> Value {
        json!({
            "sessionId": self.shared.id,
            "title": self.shared.title,
            "cwd": self.shared.cwd,
            "closed": self.shared.finished.load(Ordering::Acquire),
            "kind": "local",
        })
    }

    pub fn disposable(&self) -> bool {
        self.shared.close_requested.load(Ordering::Acquire)
            && self.shared.finished.load(Ordering::Acquire)
    }

    pub fn input(&self, bytes: &[u8]) -> CoreResult<()> {
        if self.shared.close_requested.load(Ordering::Acquire) {
            return Err(CoreError::new("session_closed", "session is closing"));
        }
        self.shared.input.try_push(bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> CoreResult<()> {
        validate_size(cols, rows)?;
        let resources = self
            .shared
            .resources
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let master = resources
            .master
            .as_ref()
            .ok_or_else(|| CoreError::new("session_closed", "session is closed"))?;
        master
            .resize(pty_size(cols, rows))
            .map_err(|e| CoreError::new("pty_resize_failed", e.to_string()))?;
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

    pub fn close(&self) -> CoreResult<()> {
        stop(&self.shared)
    }

    pub fn snapshot(&self) -> CoreResult<Value> {
        let terminal = self
            .shared
            .terminal
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        terminal.as_ref().map(Terminal::snapshot).ok_or_else(|| {
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
        let terminal = terminal.as_mut().ok_or_else(|| {
            CoreError::new(
                "terminal_disabled",
                "create the session with terminalEngine: true",
            )
        })?;
        match delta {
            Some(delta) => terminal.scroll(delta),
            None => terminal.reset_scroll(),
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = stop(&self.shared);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn stop(shared: &Shared) -> CoreResult<()> {
    if shared.close_requested.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    shared.input.shutdown();
    let exit = shared.exit.lock().unwrap_or_else(|e| e.into_inner());
    if exit.is_some() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        // portable-pty starts a new session. Terminate both the active job's
        // foreground group and its shell group without touching the host app.
        let resources = shared.resources.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(master) = resources.master.as_ref()
            && let Some(group) = master.process_group_leader()
            && group > 1
        {
            unsafe {
                libc::kill(-group, libc::SIGHUP);
            }
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        if let Some(pid) = shared.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGHUP);
            }
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            // A child may have changed its process group after spawning.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        shared
            .resources
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .job
            .take();
        let _ = shared
            .killer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .kill();
    }
    Ok(())
}

/// Wait/reap is polled so that stop's PID guard and reaping stay atomic.
fn wait_child(shared: Arc<Shared>, mut child: ChildGuard) {
    let status = loop {
        let mut exit = shared.exit.lock().unwrap_or_else(|e| e.into_inner());
        match child.0.as_mut().unwrap().try_wait() {
            Ok(Some(status)) => {
                let code = Some(status.exit_code());
                *exit = Some(code);
                break code;
            }
            Ok(None) => {}
            Err(error) => {
                *exit = Some(None);
                drop(exit);
                shared
                    .queue
                    .push(json!({"type":"error","sessionId":shared.id,
                    "code":"wait_failed","message":error.to_string()}));
                break None;
            }
        }
        drop(exit);
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    // Already reaped. The guard must not signal an exited/recycled PID.
    if status.is_some() {
        child.0.take();
    }
    shared.input.shutdown();
    shared.exited.notify_all();
    let resources = std::mem::replace(
        &mut *shared.resources.lock().unwrap_or_else(|e| e.into_inner()),
        empty_resources(),
    );
    // On Windows ClosePseudoConsole can wait for pipe draining. The reader is a
    // different worker and keeps consuming while this waiter releases ConPTY.
    drop(resources);
}

fn read_output(shared: Arc<Shared>, mut reader: PtyReader) {
    let mut bytes = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                let replies = shared
                    .terminal
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                    .map(|terminal| terminal.feed(&bytes[..count]))
                    .unwrap_or_default();
                for reply in replies {
                    if let Err(error) = shared.input.try_push(reply.as_bytes()) {
                        shared
                            .queue
                            .push(json!({"type":"error","sessionId":shared.id,
                            "code":error.code,"message":error.message}));
                    }
                }
                if !shared
                    .queue
                    .push(json!({"type":"output","sessionId":shared.id,
                    "data":STANDARD.encode(&bytes[..count])}))
                {
                    // Destruction deliberately cancels delivery and wakes all
                    // queue producers. Drain ConPTY so its destructor can finish.
                    // Continue draining on every platform. On macOS a killed
                    // writer can remain in kernel exit until the PTY output
                    // buffer is consumed, so abandoning this read deadlocks reap.
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if shared
                    .exit
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_some()
                {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            #[cfg(unix)]
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => {
                shared
                    .queue
                    .push(json!({"type":"error","sessionId":shared.id,
                    "code":"pty_read_failed","message":error.to_string()}));
                let _ = stop(&shared);
                break;
            }
        }
    }
    let mut exit = shared.exit.lock().unwrap_or_else(|e| e.into_inner());
    while exit.is_none() {
        exit = shared.exited.wait(exit).unwrap_or_else(|e| e.into_inner());
    }
    let code = exit.unwrap();
    drop(exit);
    shared
        .queue
        .push(json!({"type":"closed","sessionId":shared.id,"exitCode":code}));
    shared.finished.store(true, Ordering::Release);
}

fn write_worker(shared: Arc<Shared>, mut writer: Box<dyn Write + Send>) {
    while let Some(bytes) = shared.input.pop() {
        if let Err(error) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
            if !shared.close_requested.load(Ordering::Acquire) {
                shared
                    .queue
                    .push(json!({"type":"error","sessionId":shared.id,
                    "code":"pty_write_failed","message":error.to_string()}));
            }
            let _ = stop(&shared);
            break;
        }
    }
}

struct ChildGuard(Option<Box<dyn Child + Send + Sync>>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(unix)]
struct PtyReader(std::fs::File);

#[cfg(unix)]
impl PtyReader {
    fn new(master: &dyn MasterPty) -> CoreResult<Self> {
        use std::os::fd::FromRawFd;
        let fd = master
            .as_raw_fd()
            .ok_or_else(|| CoreError::new("pty_open_failed", "missing PTY fd"))?;
        // A dedicated dup has independent ownership and remains valid when the
        // waiter releases the original master. Poll avoids blocking destruction.
        let cloned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if cloned < 0 {
            return Err(CoreError::io(std::io::Error::last_os_error()));
        }
        Ok(Self(unsafe { std::fs::File::from_raw_fd(cloned) }))
    }
}

#[cfg(unix)]
impl Read for PtyReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        let mut poll = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        match ready {
            0 => Err(std::io::ErrorKind::WouldBlock.into()),
            -1 => Err(std::io::Error::last_os_error()),
            _ => self.0.read(bytes),
        }
    }
}

#[cfg(windows)]
struct PtyReader(Box<dyn Read + Send>);

#[cfg(windows)]
impl PtyReader {
    fn new(master: &dyn MasterPty) -> CoreResult<Self> {
        master
            .try_clone_reader()
            .map(Self)
            .map_err(|e| CoreError::new("pty_open_failed", e.to_string()))
    }
}

#[cfg(windows)]
impl Read for PtyReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(bytes)
    }
}

pub(crate) fn validate_size(cols: u16, rows: u16) -> CoreResult<()> {
    if !(2..=4096).contains(&cols)
        || !(1..=1024).contains(&rows)
        || u32::from(cols) * u32::from(rows) > 200_000
    {
        return Err(CoreError::new(
            "invalid_params",
            "cols must be 2..4096, rows must be 1..1024, and visible cells must not exceed 200000",
        ));
    }
    Ok(())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn empty_resources() -> Resources {
    Resources {
        master: None,
        #[cfg(windows)]
        job: None,
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[cfg(windows)]
fn shell_cwd(mut cwd: PathBuf, shell: &str) -> CoreResult<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Path, Prefix};

    // canonicalize returns extended paths on Windows. cmd.exe mistakes even
    // an ordinary extended drive path for UNC and silently switches directory.
    // Only simplify local shell paths, and verify both Win32 normalization and
    // filesystem identity: blindly removing the prefix changes alias semantics.
    if matches!(
        cwd.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
    ) {
        let wide: Vec<u16> = cwd.as_os_str().encode_wide().collect();
        let candidate = PathBuf::from(OsString::from_wide(&wide[4..]));
        // Windows stores a trailing separator for cwd, in addition to NUL.
        let stored_units = wide.len() - 4 + usize::from(wide.last() != Some(&u16::from(b'\\')));
        if stored_units < 260
            && std::path::absolute(&candidate)
                .is_ok_and(|absolute| absolute.as_os_str() == candidate.as_os_str())
            && candidate
                .canonicalize()
                .is_ok_and(|canonical| canonical.as_os_str() == cwd.as_os_str())
        {
            cwd = candidate;
        }
    }

    let is_cmd = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cmd.exe") || name.eq_ignore_ascii_case("cmd")
        });
    if is_cmd
        && !matches!(
            cwd.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
        )
    {
        return Err(CoreError::new(
            "cwd_unsupported",
            "cmd.exe requires a regular drive directory fitting the Windows MAX_PATH cwd limit; choose a compatible shell for UNC or extended paths",
        ));
    }
    Ok(cwd)
}

#[cfg(all(test, windows))]
mod cwd_tests {
    use super::shell_cwd;
    use std::path::PathBuf;

    #[test]
    fn unc_and_extended_paths_are_preserved_for_other_shells_and_rejected_for_cmd() {
        for path in [
            PathBuf::from(r"\\?\UNC\server\share\directory"),
            PathBuf::from(r"\\server\share\directory"),
            PathBuf::from(format!(r"\\?\C:\{}", "a".repeat(260))),
            PathBuf::from(r"\\?\Volume{00000000-0000-0000-0000-000000000000}\directory"),
        ] {
            assert_eq!(shell_cwd(path.clone(), "pwsh.exe").unwrap(), path);
            for shell in ["cmd", "CMD.EXE", r"C:\Windows\System32\cmd.exe"] {
                assert_eq!(
                    shell_cwd(path.clone(), shell).unwrap_err().code,
                    "cwd_unsupported"
                );
            }
        }
    }

    #[test]
    fn extended_aliases_keep_their_directory_identity() {
        use std::os::windows::ffi::OsStrExt;

        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let root_units = root.as_os_str().encode_wide().count() - 4;
        assert!(root_units < 240, "fixture root is unexpectedly long");
        let long_base = root.join("p".repeat(240 - root_units - 1));
        std::fs::create_dir(&long_base).unwrap();
        for base in [&root, &long_base] {
            for name in ["alias.", "alias ", "NUL.txt"] {
                let path = base.join(name);
                std::fs::create_dir(&path).unwrap();
                // Include a middle component which needs verbatim semantics.
                for path in [path.clone(), path.join("child")] {
                    std::fs::create_dir_all(&path).unwrap();
                    let canonical = path.canonicalize().unwrap();
                    let compatible = shell_cwd(canonical.clone(), "pwsh.exe").unwrap();
                    assert_eq!(compatible.canonicalize().unwrap(), canonical);
                    if path.file_name().unwrap() == "alias."
                        || path.file_name().unwrap() == "alias "
                    {
                        assert_eq!(compatible, canonical);
                        assert_eq!(
                            shell_cwd(canonical, "cmd.exe").unwrap_err().code,
                            "cwd_unsupported"
                        );
                    } else {
                        // Some Windows versions allow otherwise reserved names
                        // in intermediate components. An accepted cwd must retain
                        // the selected directory, whatever spelling is used.
                        match shell_cwd(canonical.clone(), "cmd.exe") {
                            Ok(path) => assert_eq!(path.canonicalize().unwrap(), canonical),
                            Err(error) => assert_eq!(error.code, "cwd_unsupported"),
                        }
                    }
                }
            }
        }
    }
}
