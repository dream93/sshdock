use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 512;
const POLL_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct State {
    events: VecDeque<(Value, usize)>,
    bytes: usize,
    shutdown: bool,
}

/// Producers wait when the consumer falls behind. No live output is discarded.
#[derive(Default)]
pub(crate) struct EventQueue {
    state: Mutex<State>,
    space: Condvar,
}

impl EventQueue {
    pub fn push(&self, event: Value) -> bool {
        let size = event.to_string().len();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.shutdown
            && (state.events.len() >= MAX_EVENTS || state.bytes + size > MAX_BYTES)
        {
            state = self.space.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.shutdown {
            return false;
        }
        state.bytes += size;
        state.events.push_back((event, size));
        true
    }

    pub fn drain(&self) -> Vec<Value> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut result = Vec::new();
        let mut bytes = 0;
        while bytes < POLL_BYTES {
            let Some((event, size)) = state.events.pop_front() else {
                break;
            };
            state.bytes -= size;
            bytes += size;
            result.push(event);
        }
        self.space.notify_all();
        result
    }

    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.shutdown = true;
        self.space.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    #[test]
    fn backpressure_preserves_event_order_and_shutdown_wakes_producer() {
        let queue = Arc::new(EventQueue::default());
        for index in 0..MAX_EVENTS {
            assert!(queue.push(json!(index)));
        }
        let (tx, rx) = mpsc::channel();
        let producer = queue.clone();
        let worker = std::thread::spawn(move || {
            tx.send(producer.push(json!(MAX_EVENTS))).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        assert_eq!(
            queue.drain(),
            (0..MAX_EVENTS).map(|v| json!(v)).collect::<Vec<_>>()
        );
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert_eq!(queue.drain(), vec![json!(MAX_EVENTS)]);
        for index in 0..MAX_EVENTS {
            queue.push(json!(index));
        }
        let producer = queue.clone();
        let worker = std::thread::spawn(move || producer.push(json!("blocked")));
        queue.shutdown();
        assert!(!worker.join().unwrap());
    }
}
