#!/usr/bin/env python3
"""Verify the C ABI against an isolated, local OpenSSH test server.

Requires a disposable fixture directory with client_key, encrypted_client_key,
and remote/. Never point this script at a production server or user directory.
"""
import argparse
import base64
import ctypes
import json
import os
from pathlib import Path
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True)
    parser.add_argument("--fixture-directory", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--platform", choices=["linux", "darwin"], required=True)
    options = parser.parse_args()
    fixture = Path(options.fixture_directory).resolve()
    library = ctypes.CDLL(str(Path(options.library).resolve()))
    library.sshdock_core_create.restype = ctypes.c_void_p
    library.sshdock_core_request.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    library.sshdock_core_request.restype = ctypes.c_void_p
    library.sshdock_core_poll.argtypes = [ctypes.c_void_p]
    library.sshdock_core_poll.restype = ctypes.c_void_p
    library.sshdock_core_string_free.argtypes = [ctypes.c_void_p]
    library.sshdock_core_destroy.argtypes = [ctypes.c_void_p]
    core = library.sshdock_core_create()
    assert core, "Unable to create the core"

    def decode(pointer):
        assert pointer, "The core returned a null result"
        try:
            return json.loads(ctypes.string_at(pointer))
        finally:
            library.sshdock_core_string_free(pointer)

    def raw(method, **parameters):
        payload = json.dumps({"method": method, "params": parameters}).encode()
        return decode(library.sshdock_core_request(core, payload))

    def request(method, **parameters):
        response = raw(method, **parameters)
        assert response["ok"], (method, response.get("error"))
        return response["result"]

    def poll():
        return decode(library.sshdock_core_poll(core))

    def send(session, text):
        request("sessions.input", sessionId=session,
                data=base64.b64encode(text.encode()).decode())

    def output_until(session, marker):
        text = ""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            for event in poll():
                if event.get("sessionId") == session and event["type"] == "output":
                    text += base64.b64decode(event["data"]).decode("utf8", errors="replace")
            if marker in text:
                return
            time.sleep(0.01)
        raise AssertionError("The remote command did not produce its expected output")

    worker = None
    try:
        host = {"host": "127.0.0.1", "port": options.port}
        identity = request("ssh.hostKey", **host)
        assert identity["fingerprint"].startswith("SHA256:")
        parameters = dict(host, username=options.username, authType="key",
                          keyPath=str(fixture / "client_key"),
                          expectedFingerprint=identity["fingerprint"],
                          cols=100, rows=30, terminalEngine=True)
        response = raw("ssh.connect", **dict(parameters, expectedFingerprint="SHA256:wrong"))
        assert not response["ok"] and response["error"]["code"] == "host_key_mismatch"
        response = raw("ssh.connect", **dict(parameters,
                       keyPath=str(fixture / "encrypted_client_key"), passphrase="wrong"))
        assert not response["ok"] and response["error"]["code"] == "key_load_failed"
        encrypted = request("ssh.connect", **dict(parameters,
                            keyPath=str(fixture / "encrypted_client_key"),
                            passphrase=os.environ["SSHDOCK_FIXTURE_PASSPHRASE"]))
        request("sessions.close", sessionId=encrypted["sessionId"])

        if password := os.environ.get("SSHDOCK_FIXTURE_PASSWORD"):
            response = raw("ssh.connect", **dict(parameters, authType="password", password="wrong"))
            assert not response["ok"] and response["error"]["code"] == "ssh_auth_failed"
            authenticated = request("ssh.connect", **dict(parameters, authType="password", password=password))
            request("sessions.close", sessionId=authenticated["sessionId"])

        session = request("ssh.connect", **parameters)["sessionId"]
        # The expected marker is absent from the command, so echo cannot pass.
        send(session, "a=SSH; b=DOCK_NATIVE_REMOTE; printf '%s%s\\n' \"$a\" \"$b\"\r")
        output_until(session, "SSHDOCK_NATIVE_REMOTE")
        request("sessions.resize", sessionId=session, cols=123, rows=39)
        send(session, "stty size\r")
        output_until(session, "39 123")
        assert request("sftp.home", sessionId=session)["path"].startswith("/")
        source = fixture / "upload"
        (source / "中文目录").mkdir(parents=True, exist_ok=True)
        (source / "中文目录" / "hello.txt").write_text("原生 SSH / SFTP 测试\n", encoding="utf8")
        (source / "empty.txt").write_bytes(b"")
        remote = str(fixture / "remote" / "中文上传验收")
        request("sftp.upload", sessionId=session, localPath=str(source),
                remotePath=remote, transferId="upload-test")
        listing = request("sftp.list", sessionId=session, path=remote)
        assert {"中文目录", "empty.txt"} <= {item["name"] for item in listing["entries"]}
        destination = fixture / "download"
        request("sftp.download", sessionId=session, localPath=str(destination),
                remotePath=remote, transferId="download-test")
        for path in source.rglob("*"):
            if path.is_file():
                assert path.read_bytes() == (destination / path.relative_to(source)).read_bytes()
        sample = request("stats.sample", sessionId=session)
        assert sample["supported"] == (options.platform == "linux")
        if sample["supported"]:
            assert sample["cpuTotal"] >= sample["cpuIdle"]
            assert sample["memTotal"] >= sample["memAvailable"] > 0
            assert sample["load1"] >= 0
        request("sftp.remove", sessionId=session, path=remote)
        listing = request("sftp.list", sessionId=session, path=str(fixture / "remote"))
        assert "中文上传验收" not in {item["name"] for item in listing["entries"]}

        # Exercise cancellation while output and SFTP share the live connection.
        large = fixture / "large.bin"
        with large.open("wb") as stream:
            stream.truncate(256 * 1024 * 1024)
        remote = str(fixture / "remote" / "large-cancel.bin")
        results = []
        worker = threading.Thread(target=lambda: results.append(raw("sftp.upload",
                                  sessionId=session, localPath=str(large),
                                  remotePath=remote, transferId="cancel-test")))
        worker.start()
        deadline = time.monotonic() + 10
        started = False
        while time.monotonic() < deadline:
            if any(event.get("transferId") == "cancel-test" and event.get("state") == "running" for event in poll()):
                started = True
                break
            time.sleep(0.01)
        assert started, "Transfer never started"
        send(session, "a=CONCURRENT; b=_SSH_INPUT; printf '%s%s\\n' \"$a\" \"$b\"\r")
        output_until(session, "CONCURRENT_SSH_INPUT")
        assert worker.is_alive(), "Transfer completed before concurrency could be checked"
        request("sftp.cancel", sessionId=session, transferId="cancel-test")
        worker.join(5)
        assert not worker.is_alive(), "Cancellation did not end the transfer"
        assert results and not results[0]["ok"] and results[0]["error"]["code"] == "transfer_cancelled"
        request("sftp.remove", sessionId=session, path=remote)
        send(session, "exit 4\r")
        deadline = time.monotonic() + 10
        closed = False
        while time.monotonic() < deadline:
            for event in poll():
                if event.get("sessionId") == session and event["type"] == "closed":
                    assert event["exitCode"] == 4
                    closed = True
            if closed:
                break
            time.sleep(0.01)
        assert closed, "Remote exit notification is missing"
        request("core.shutdown")
        request("core.shutdown")
        assert not raw("ssh.connect", **parameters)["ok"]
        print("PASS OpenSSH: authentication, host-key refusal, remote PTY, recursive SFTP, "
              "statistics, concurrent input, cancellation, exit and shutdown")
    finally:
        raw("core.shutdown")
        if worker:
            worker.join(5)
            if worker.is_alive():
                # Keep a live handle instead of destroying during a foreign call.
                os._exit(1)
        library.sshdock_core_destroy(core)


if __name__ == "__main__":
    main()
