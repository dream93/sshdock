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
 * core.info returns {"abiVersion":1,"version":"..."}.
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
