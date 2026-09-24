//! `episko-server`: the self-hosted sync server (docs/sync.md). One binary, one SQLite file,
//! configured by environment. It binds localhost and leaves TLS to a proxy in front of it.

mod serve;
mod store;

use std::net::TcpListener;
use std::sync::Arc;

const USAGE: &str = "usage: episko-server [serve | invite [--user NAME]]

  serve    run the server (the default)
  invite   print a one-use pairing code, good for ten minutes

environment:
  EPISKO_DB    the database file (default: episko.db)
  EPISKO_BIND  the address to listen on (default: 127.0.0.1:7878)";

// Single-user mode: with no workspaces configured, everyone is in this one.
const WORKSPACE: &str = "default";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let db = std::env::var("EPISKO_DB").unwrap_or_else(|_| "episko.db".into());
    let store = store::Store::open(&db).unwrap_or_else(|e| fail(&format!("cannot open {db}: {e}")));
    match args.first().map(String::as_str) {
        None | Some("serve") => {
            let bind = std::env::var("EPISKO_BIND").unwrap_or_else(|_| "127.0.0.1:7878".into());
            let listener = TcpListener::bind(&bind).unwrap_or_else(|e| fail(&format!("cannot bind {bind}: {e}")));
            eprintln!("[episko-server] listening on ws://{bind}/ with {db}");
            serve::serve(listener, Arc::new(store));
        }
        Some("invite") => {
            let user = match args.get(1).map(String::as_str) {
                None => "me".to_string(),
                Some("--user") => args.get(2).cloned().unwrap_or_else(|| fail(USAGE)),
                Some(_) => fail(USAGE),
            };
            let code = store.create_invite(WORKSPACE, &user, serve::now_ms()).unwrap_or_else(|e| fail(&e.to_string()));
            println!("{code}");
            eprintln!("Enter this in Episko › Settings › Sync within ten minutes. It works once.");
        }
        Some(_) => fail(USAGE),
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}
