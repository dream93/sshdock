#ifndef SSHDOCK_CORE_H
#define SSHDOCK_CORE_H

#ifdef _WIN32
#  ifdef SSHDOCK_CORE_EXPORTS
#    define SSHDOCK_API __declspec(dllexport)
#  else
#    define SSHDOCK_API __declspec(dllimport)
#  endif
#else
#  define SSHDOCK_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ABI v1. Core handles and JSON strings have independent ownership.
 * Each request/poll result is a UTF-8, NUL-terminated allocation. The caller
 * must release it exactly once with sshdock_core_string_free, including errors.
 * Never free a result with free(), and never use it after string_free().
 *
 * request: {"method":"...","params":{...}}
 * response: {"ok":true,"result":...} or
 *           {"ok":false,"error":{"code":"...","message":"..."}}
 * poll: a JSON array of ordered events (empty array when no events are ready).
 * output: {"type":"output","sessionId":"...","data":"base64 bytes"}
 * closed: {"type":"closed","sessionId":"...","exitCode":0}
 * error:  {"type":"error","sessionId":"...","code":"...","message":"..."}
 * transfer: {"type":"transfer","sessionId":"...","transferId":"...",
 *            "transferred":0,"total":0,"state":"running|completed|failed"}
 * core.info returns {"abiVersion":1,"version":"..."}.
 * core.shutdown is an idempotent concurrent cancellation barrier: stops owned
 * processes/connections and wakes output/transfer producers. New operations
 * return CORE_STOPPED. Call it before waiting for request lanes to drain, then
 * destroy after all calls have returned. Shutdown does not free the handle.
 *
 * ssh.hostKey {host,port} probes algorithm and SHA256 fingerprint without auth.
 * ssh.connect requires host,port,username,authType (password|key), cols,rows,
 * expectedFingerprint, optional terminalEngine and password|keyPath/passphrase.
 * Unknown and changed host keys are never trusted by the core. The frontend
 * must obtain explicit trust before supplying expectedFingerprint.
 * SSH sessions reuse sessions.* and terminal.* methods; info contains kind:ssh.
 * sftp.home/list/mkdir/remove/upload/download/cancel and stats.sample require
 * sessionId. Network operations never hold the global session-map mutex.
 * File transfers use localPath,remotePath,transferId, can include directories,
 * and may be cancelled independently using sftp.cancel {sessionId,transferId}.
 * Cancelled/failed transfers can leave partial destinations. Symbolic link
 * transfers are rejected; recursive deletion unlinks links without following.
 * stats.sample returns Linux CPU counters, byte counts and load, or supported:
 * false on unsupported systems. Detailed JSON schemas: native/core/README.md.
 * sessions.input accepts a complete write into a bounded queue or returns
 * INPUT_BACKPRESSURE; retry rejected writes after the process consumes input.
 * A successful input request means queued, not necessarily already consumed.
 * Closing a session intentionally cancels pending input.
 *
 * Calls on a valid handle may run concurrently. Destroy must be serialized
 * against every other call using that handle. It terminates all owned processes
 * and invalidates the handle; destroy exactly once. A NULL handle is rejected.
 * Foreign pointers, freed handles and non-NUL-terminated strings are invalid.
 *
 * Poll regularly: the bounded queue applies backpressure to PTY output when
 * consumers fall behind. Output is not silently dropped while a core is live.
 */
SSHDOCK_API void *sshdock_core_create(void);
SSHDOCK_API char *sshdock_core_request(void *core, const char *json);
SSHDOCK_API char *sshdock_core_poll(void *core);
SSHDOCK_API void sshdock_core_string_free(char *string);
SSHDOCK_API void sshdock_core_destroy(void *core);

#ifdef __cplusplus
}
#endif
#endif
