#!/usr/bin/env bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_root="$(mktemp -d /tmp/sshdock-swift-fixture.XXXXXX)"
daemon_pid=""
cleanup_fixture() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$fixture_root"
}
trap cleanup_fixture EXIT

ssh-keygen -q -t ed25519 -N '' -f "$fixture_root/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_root/client_key"
cp "$fixture_root/client_key.pub" "$fixture_root/authorized_keys"
export SSHDOCK_TEST_SSH_HOST=127.0.0.1
export SSHDOCK_TEST_SSH_USERNAME="$(id -un)"
export SSHDOCK_TEST_SSH_KEY="$fixture_root/client_key"
SSHDOCK_TEST_SSH_PORT="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    print(listener.getsockname()[1])
PY
)"
export SSHDOCK_TEST_SSH_PORT
cat > "$fixture_root/sshd_config" <<EOF
Port $SSHDOCK_TEST_SSH_PORT
ListenAddress 127.0.0.1
HostKey $fixture_root/host_key
PidFile $fixture_root/sshd.pid
AuthorizedKeysFile $fixture_root/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
AllowUsers $SSHDOCK_TEST_SSH_USERNAME
Subsystem sftp internal-sftp
EOF
/usr/sbin/sshd -t -f "$fixture_root/sshd_config"
/usr/sbin/sshd -D -e -f "$fixture_root/sshd_config" > "$fixture_root/sshd.log" 2>&1 &
daemon_pid=$!
python3 - <<'PY'
import os, socket, time
port = int(os.environ['SSHDOCK_TEST_SSH_PORT'])
for attempt in range(100):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
            break
    except OSError:
        time.sleep(0.1)
else:
    raise RuntimeError('OpenSSH fixture did not start')
PY
swift test --package-path "$native_root/macos" --build-system native -c release
