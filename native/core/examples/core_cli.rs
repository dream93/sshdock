//! JSON-lines diagnostic runner. `core.poll` drains events; never prints credentials.
use sshdock_core::Core;
use std::io::{self, BufRead, Write};
fn main() {
    let core = Core::default();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let value = if serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v["method"].as_str().map(str::to_owned))
            .as_deref()
            == Some("core.poll")
        {
            serde_json::json!({"ok":true,"result":core.poll()})
        } else {
            core.request(&line)
        };
        println!("{value}");
        let _ = io::stdout().flush();
    }
}
