use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sshdock_core::{
    Core, sshdock_core_create, sshdock_core_destroy, sshdock_core_poll, sshdock_core_request,
    sshdock_core_string_free,
};
use std::ffi::{CStr, CString};
#[cfg(unix)]
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn request(core: &Core, method: &str, params: Value) -> Value {
    let response = core.request(&json!({"method":method,"params":params}).to_string());
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

fn create(core: &Core, engine: bool) -> String {
    #[cfg(unix)]
    let params = json!({"cols":80,"rows":24,"terminalEngine":engine,"shell":"/bin/sh"});
    #[cfg(windows)]
    let params = json!({"cols":80,"rows":24,"terminalEngine":engine});
    request(core, "local.create", params)["sessionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn input(core: &Core, id: &str, bytes: &[u8]) {
    request(
        core,
        "sessions.input",
        json!({"sessionId":id,"data":STANDARD.encode(bytes)}),
    );
}

fn wait_for(core: &Core, id: &str, marker: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["sessionId"] != id {
                continue;
            }
            if event["type"] == "error" {
                panic!("{event}");
            }
            if event["type"] == "output" {
                output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
                if output.windows(marker.len()).any(|bytes| bytes == marker) {
                    return output;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "missing marker {marker:?}, output: {}",
        String::from_utf8_lossy(&output)
    );
}

fn wait_closed(core: &Core, id: &str) -> Option<u32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["sessionId"] == id && event["type"] == "closed" {
                return event["exitCode"].as_u64().map(|v| v as u32);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("no closed event");
}

#[test]
fn ffi_results_own_their_buffers_and_reject_null_or_invalid_arguments() {
    unsafe {
        let handle = sshdock_core_create();
        assert!(!handle.is_null());
        let malformed = CString::new("{").unwrap();
        let first = sshdock_core_request(handle, malformed.as_ptr());
        let second = sshdock_core_poll(handle);
        let first_text = CStr::from_ptr(first).to_str().unwrap().to_owned();
        assert_eq!(
            serde_json::from_str::<Value>(&first_text).unwrap()["error"]["code"],
            "invalid_json"
        );
        // A later call and destruction don't invalidate already returned strings.
        sshdock_core_destroy(handle);
        assert_eq!(CStr::from_ptr(first).to_str().unwrap(), first_text);
        assert_eq!(CStr::from_ptr(second).to_str().unwrap(), "[]");
        sshdock_core_string_free(first);
        sshdock_core_string_free(second);
        sshdock_core_string_free(std::ptr::null_mut());
        sshdock_core_destroy(std::ptr::null_mut());
        let null_result = sshdock_core_request(std::ptr::null_mut(), malformed.as_ptr());
        assert_eq!(
            serde_json::from_str::<Value>(CStr::from_ptr(null_result).to_str().unwrap()).unwrap()["ok"],
            false
        );
        sshdock_core_string_free(null_result);
        let handle = sshdock_core_create();
        let invalid_utf8 = [0xff, 0];
        let result = sshdock_core_request(handle, invalid_utf8.as_ptr().cast());
        assert_eq!(
            serde_json::from_str::<Value>(CStr::from_ptr(result).to_str().unwrap()).unwrap()["error"]
                ["code"],
            "invalid_argument"
        );
        sshdock_core_string_free(result);
        sshdock_core_destroy(handle);
    }
}

#[test]
fn protocol_rejects_invalid_sizes_methods_and_base64_before_touching_the_pty() {
    let core = Core::default();
    assert_eq!(request(&core, "core.info", json!({}))["abiVersion"], 1);
    let invalid =
        core.request(&json!({"method":"local.create","params":{"cols":0,"rows":24}}).to_string());
    assert_eq!(invalid["error"]["code"], "invalid_params");
    let over_budget = core
        .request(&json!({"method":"local.create","params":{"cols":4096,"rows":1024}}).to_string());
    assert_eq!(over_budget["error"]["code"], "invalid_params");
    let unknown = core.request(&json!({"method":"unknown","params":{}}).to_string());
    assert_eq!(unknown["error"]["code"], "unknown_method");
    let id = create(&core, false);
    let invalid = core.request(
        &json!({"method":"sessions.input","params":{"sessionId":id,"data":"!"}}).to_string(),
    );
    assert_eq!(invalid["error"]["code"], "invalid_params");
    let no_engine =
        core.request(&json!({"method":"terminal.snapshot","params":{"sessionId":id}}).to_string());
    assert_eq!(no_engine["error"]["code"], "terminal_disabled");
    request(&core, "sessions.close", json!({"sessionId":id}));
    wait_closed(&core, &id);
}

#[cfg(windows)]
#[test]
fn conpty_runs_unicode_resizes_and_orders_shell_exit_after_output() {
    let core = Core::default();
    let id = create(&core, true);
    input(&core, &id, "@echo off\r\nchcp 65001 >nul\r\nset SSHDOCK_MARKER=READY\r\necho 中文\r\necho NATIVE_%SSHDOCK_MARKER%\r\n".as_bytes());
    let output = wait_for(&core, &id, b"NATIVE_READY");
    assert!(
        output
            .windows("中文".len())
            .any(|bytes| bytes == "中文".as_bytes())
    );
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":id}));
    assert!(
        snapshot["cells"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cell| cell["text"] == "中")
    );
    request(
        &core,
        "sessions.resize",
        json!({"sessionId":id,"cols":93,"rows":31}),
    );
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":id}));
    assert_eq!(snapshot["cols"], 93);
    assert_eq!(snapshot["rows"], 31);
    input(&core, &id, b"echo FINAL_%SSHDOCK_MARKER%\r\nexit 7\r\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    let mut closed = false;
    while Instant::now() < deadline && !closed {
        for event in core.poll().as_array().unwrap() {
            if event["sessionId"] != id {
                continue;
            }
            if event["type"] == "output" {
                output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            }
            if event["type"] == "closed" {
                assert_eq!(event["exitCode"], 7);
                assert!(output.windows(11).any(|bytes| bytes == b"FINAL_READY"));
                closed = true;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(closed);
}

#[cfg(windows)]
#[test]
fn conpty_close_cancels_unconsumed_input_and_terminates_child_jobs() {
    let core = Core::default();
    // portable-pty's ConPTY adapter requests the initial cursor position. A VT
    // consumer must answer that DSR before the hosted program produces output.
    let id = create(&core, true);
    // Windows PowerShell is present in the minimum Windows 10 environment. It
    // creates a descendant process which ignores stdin while sleeping.
    input(&core, &id, b"@echo off\r\npowershell.exe -NoLogo -NoProfile -Command \"[Console]::WriteLine('NO_STDIN_' + 'READY'); Start-Sleep -Seconds 60\"\r\n");
    wait_for(&core, &id, b"NO_STDIN_READY");
    let data = STANDARD.encode(vec![b'x'; 512 * 1024]);
    let mut backpressure = false;
    let started = Instant::now();
    for _ in 0..16 {
        let result = core.request(
            &json!({"method":"sessions.input","params":{"sessionId":id,"data":data}}).to_string(),
        );
        if result["ok"] == false {
            assert_eq!(result["error"]["code"], "INPUT_BACKPRESSURE");
            backpressure = true;
            break;
        }
    }
    assert!(backpressure);
    assert!(started.elapsed() < Duration::from_secs(3));
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        request(&core, "sessions.close", json!({"sessionId":id}));
        drop(core);
        tx.send(()).unwrap();
    });
    rx.recv_timeout(Duration::from_secs(5))
        .expect("owned ConPTY child job must terminate promptly");
    worker.join().unwrap();
}

#[cfg(unix)]
#[test]
fn real_pty_preserves_utf8_vt_resize_and_orders_exit_after_output() {
    let core = Core::default();
    let id = create(&core, true);
    input(&core, &id, b"stty -echo -onlcr\n");
    // ASCII-only command produces Unicode independently of terminal input echo.
    input(&core, &id, b"printf '\\033[2J\\033[H\\033[31;1;4m\\344\\270\\255\\346\\226\\207\\033[0m\\r\\nPTY_READY\\r\\n'\n");
    let output = wait_for(&core, &id, b"PTY_READY\r\n");
    assert!(
        output
            .windows("中文".len())
            .any(|bytes| bytes == "中文".as_bytes())
    );
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":id}));
    let chinese = snapshot["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["text"] == "中")
        .unwrap();
    assert_eq!(chinese["wide"], true);
    assert_eq!(chinese["bold"], true);
    assert_eq!(chinese["underline"], true);
    request(
        &core,
        "sessions.resize",
        json!({"sessionId":id,"cols":93,"rows":31}),
    );
    input(&core, &id, b"stty size; printf 'SIZE_READY\\r\\n'\n");
    let output = wait_for(&core, &id, b"SIZE_READY\r\n");
    assert!(String::from_utf8_lossy(&output).contains("31 93"));
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":id}));
    assert_eq!(snapshot["cols"], 93);
    assert_eq!(snapshot["rows"], 31);
    input(&core, &id, b"printf 'FINAL_BYTES\\r\\n'; exit 7\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut final_output = Vec::new();
    let mut closed = false;
    while Instant::now() < deadline && !closed {
        for event in core.poll().as_array().unwrap() {
            if event["sessionId"] != id {
                continue;
            }
            if event["type"] == "output" {
                final_output.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            }
            if event["type"] == "closed" {
                assert_eq!(event["exitCode"], 7);
                assert!(final_output.windows(13).any(|v| v == b"FINAL_BYTES\r\n"));
                closed = true;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(closed);
}

#[cfg(unix)]
#[test]
fn sessions_keep_independent_terminal_state_during_concurrent_calls() {
    let core = Arc::new(Core::default());
    let left = create(&core, true);
    let right = create(&core, true);
    let left_core = core.clone();
    let left_id = left.clone();
    let left_worker = std::thread::spawn(move || {
        input(&left_core, &left_id, b"stty -echo -onlcr; printf '\\033[2J\\033[HLEFT_SIDE\\033[?1h\\033[?2004h\\r\\nLEFT_READY\\r\\n'\n");
        for _ in 0..20 {
            request(
                &left_core,
                "terminal.snapshot",
                json!({"sessionId":left_id}),
            );
        }
    });
    let right_core = core.clone();
    let right_id = right.clone();
    let right_worker = std::thread::spawn(move || {
        input(
            &right_core,
            &right_id,
            b"stty -echo -onlcr; printf '\\033[2J\\033[HRIGHT_SIDE\\r\\nRIGHT_READY\\r\\n'\n",
        );
        for _ in 0..20 {
            request(
                &right_core,
                "terminal.snapshot",
                json!({"sessionId":right_id}),
            );
        }
    });
    left_worker.join().unwrap();
    right_worker.join().unwrap();
    // Poll the common queue once for both sessions, without losing the other one's events.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut left_output = Vec::new();
    let mut right_output = Vec::new();
    while Instant::now() < deadline {
        for event in core.poll().as_array().unwrap() {
            if event["type"] == "output" {
                let target = if event["sessionId"] == left {
                    &mut left_output
                } else {
                    &mut right_output
                };
                target.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            }
        }
        if left_output.windows(10).any(|v| v == b"LEFT_READY")
            && right_output.windows(11).any(|v| v == b"RIGHT_READY")
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":left}));
    assert_eq!(snapshot["modes"]["applicationCursor"], true);
    assert_eq!(snapshot["modes"]["bracketedPaste"], true);
    let snapshot = request(&core, "terminal.snapshot", json!({"sessionId":right}));
    assert_eq!(snapshot["modes"]["applicationCursor"], false);
    assert_eq!(snapshot["modes"]["bracketedPaste"], false);
    assert_eq!(snapshot["cells"][0]["text"], "R");
}

#[cfg(unix)]
#[test]
fn unconsumed_input_applies_backpressure_and_close_destroy_do_not_wait_for_stdin() {
    let core = Core::default();
    let id = create(&core, false);
    input(
        &core,
        &id,
        b"stty -echo -onlcr -icanon; printf 'NO_STDIN_READY\\r\\n'; exec sleep 60\n",
    );
    wait_for(&core, &id, b"NO_STDIN_READY\r\n");
    let data = STANDARD.encode(vec![b'x'; 512 * 1024]);
    let started = Instant::now();
    let mut backpressure = false;
    for _ in 0..8 {
        let result = core.request(
            &json!({"method":"sessions.input","params":{"sessionId":id,"data":data}}).to_string(),
        );
        if result["ok"] == false {
            assert_eq!(result["error"]["code"], "INPUT_BACKPRESSURE");
            backpressure = true;
            break;
        }
    }
    assert!(
        backpressure,
        "non-reading child must eventually fill its bounded queue"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        request(&core, "sessions.close", json!({"sessionId":id}));
        drop(core);
        tx.send(()).unwrap();
    });
    rx.recv_timeout(Duration::from_secs(3))
        .expect("close and destroy must cancel blocked PTY writes");
    worker.join().unwrap();
}

#[cfg(unix)]
#[test]
fn destroy_unblocks_a_full_output_queue_and_reaps_the_owned_child() {
    let core = Core::default();
    let id = create(&core, false);
    input(
        &core,
        &id,
        b"stty -echo -onlcr; printf 'PID:%s\\r\\n' $$; printf 'PID_READY\\r\\n'\n",
    );
    let output = wait_for(&core, &id, b"PID_READY\r\n");
    let text = String::from_utf8_lossy(&output);
    let pid = text
        .lines()
        .find_map(|line| {
            line.strip_prefix("PID:")
                .and_then(|v| v.trim().parse::<i32>().ok())
        })
        .unwrap();
    input(&core, &id, b"exec yes\n");
    // Fill the bounded output queue without a poll consumer.
    std::thread::sleep(Duration::from_millis(200));
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        drop(core);
        tx.send(()).unwrap();
    });
    rx.recv_timeout(Duration::from_secs(3))
        .expect("destruction must wake backpressured reader");
    worker.join().unwrap();
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "the owned child must be reaped"
    );
}
