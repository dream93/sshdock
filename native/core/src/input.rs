use crate::{CoreError, CoreResult};
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_WRITES: usize = 128;

#[derive(Default)]
struct State {
    writes: VecDeque<Vec<u8>>,
    bytes: usize,
    shutdown: bool,
}

#[derive(Default)]
pub(crate) struct InputQueue {
    state: Mutex<State>,
    available: Condvar,
}

impl InputQueue {
    /// ABI callers never wait for a process to consume stdin. On overload the
    /// complete write is rejected before accepting any of its bytes.
    pub fn try_push(&self, bytes: &[u8]) -> CoreResult<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return Err(CoreError::new("session_closed", "session is closed"));
        }
        if state.bytes + bytes.len() > MAX_BYTES || state.writes.len() >= MAX_WRITES {
            return Err(CoreError::new(
                "INPUT_BACKPRESSURE",
                "input queue is full; retry after the process consumes input",
            ));
        }
        if !bytes.is_empty() {
            state.bytes += bytes.len();
            state.writes.push_back(bytes.to_vec());
            self.available.notify_one();
        }
        Ok(())
    }

    pub fn pop(&self) -> Option<Vec<u8>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.writes.is_empty() && !state.shutdown {
            state = self
                .available
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
        if state.shutdown {
            return None;
        }
        let bytes = state.writes.pop_front()?;
        state.bytes -= bytes.len();
        Some(bytes)
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.shutdown = true;
        state.writes.clear();
        state.bytes = 0;
        self.available.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_overload_rejects_whole_write_and_shutdown_wakes_reader() {
        let queue = InputQueue::default();
        queue.try_push(&vec![42; MAX_BYTES]).unwrap();
        assert_eq!(
            queue.try_push(b"next").unwrap_err().code,
            "INPUT_BACKPRESSURE"
        );
        assert_eq!(queue.pop().unwrap(), vec![42; MAX_BYTES]);
        queue.try_push(b"next").unwrap();
        assert_eq!(queue.pop().unwrap(), b"next");
        queue.shutdown();
        assert!(queue.pop().is_none());
        assert_eq!(
            queue.try_push(b"closed").unwrap_err().code,
            "session_closed"
        );
    }
}
