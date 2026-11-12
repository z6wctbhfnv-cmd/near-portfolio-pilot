//! WASI entry point: read one JSON input from stdin, write one JSON value to stdout.
//! This is the binary OutLayer runs in its TEE and the backend runs locally for backtests.

use std::io::{self, Read, Write};

fn main() {
    let mut raw = Vec::new();
    let out = match io::stdin().read_to_end(&mut raw) {
        Ok(_) if raw.trim_ascii() == br#"{"catalog":true}"# => pilot_strategies::catalog_json(),
        Ok(_) => pilot_strategies::run_to_json(&raw),
        Err(e) => format!(r#"{{"ok":false,"error":"cannot read stdin: {e}"}}"#),
    };
    let mut stdout = io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}
