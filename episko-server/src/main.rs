//! `episko-server`: the self-hosted sync server (docs/sync.md). One binary, one SQLite file,
//! configured by environment. It binds localhost and leaves TLS to a proxy in front of it.

mod serve;
mod store;

use std::net::TcpListener;
use std::sync::Arc;

const USAGE: &str = "usage: episko-server [serve | invite NAME | devices | revoke DEVICE | rename OLD NEW]

  serve    run the server (the default)
  invite   print a one-use pairing code for NAME's machine, good for ten minutes
  devices  list every paired device
  revoke   shut a device out; the app asks it to pair again
  rename   rename a person; their settings and spend follow the new name

environment:
  EPISKO_DB              the database file (default: episko.db)
  EPISKO_BIND            the address to listen on (default: 127.0.0.1:7878)
  EPISKO_RETENTION_DAYS  how long superseded events are kept (default: 30)
  EPISKO_REGISTER_CODE   lets people join with this code and their own name (default: off)";

// One workspace per server: a team runs one server (docs/sync.md).
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
            let store = Arc::new(store);
            let days: i64 = std::env::var("EPISKO_RETENTION_DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(30);
            let compactor = store.clone();
            std::thread::spawn(move || loop {
                match compactor.compact(serve::now_ms(), days * 86_400_000) {
                    Ok(0) => {}
                    Ok(n) => eprintln!("[episko-server] compacted {n} superseded event(s)"),
                    Err(e) => eprintln!("[episko-server] compaction failed: {e}"),
                }
                std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
            });
            let register = std::env::var("EPISKO_REGISTER_CODE").ok().filter(|c| !c.trim().is_empty());
            if register.as_deref().is_some_and(|c| c.trim().len() < 12) {
                fail("EPISKO_REGISTER_CODE must be at least 12 characters: anyone holding it can join");
            }
            if register.is_some() { eprintln!("[episko-server] registration is open to anyone with the team code"); }
            serve::serve(listener, store, Arc::new(serve::Config { ws: WORKSPACE.into(), register }));
        }
        Some("invite") => {
            // `--user NAME` is the old spelling and still works.
            let raw = match (args.get(1).map(String::as_str), args.get(2)) {
                (Some("--user"), Some(n)) => n.clone(),
                (Some(n), None) if !n.starts_with('-') => n.to_string(),
                _ => fail(USAGE),
            };
            let user = store::valid_name(&raw).unwrap_or_else(|m| fail(m));
            let code = store.create_invite(WORKSPACE, &user, serve::now_ms()).unwrap_or_else(|e| fail(&e.to_string()));
            println!("{code}");
            eprintln!("Pairs a machine of {user} in Episko › Settings › Sync. It works once, for ten minutes.");
        }
        Some("rename") => {
            let (Some(from), Some(to)) = (args.get(1), args.get(2)) else { fail(USAGE) };
            let to = store::valid_name(to).unwrap_or_else(|m| fail(m));
            match store.rename(from, &to) {
                Ok(Some(0)) => fail(&format!("nobody is called {from}")),
                Ok(Some(n)) => println!("renamed {from} to {to} on {n} device(s); they pick it up on their next reconnect"),
                Ok(None) => fail(&format!("{to} is already somebody else")),
                Err(e) => fail(&e.to_string()),
            }
        }
        Some("devices") => {
            for (user, device, label, created) in store.devices().unwrap_or_else(|e| fail(&e.to_string())) {
                println!("{device}  user={user}  {label}  paired {}", created / 1000);
            }
        }
        Some("revoke") => {
            let device = args.get(1).unwrap_or_else(|| fail(USAGE));
            match store.revoke(device) {
                Ok(0) => fail(&format!("no device {device}")),
                Ok(_) => println!("revoked {device}"),
                Err(e) => fail(&e.to_string()),
            }
        }
        Some(_) => fail(USAGE),
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    // A deployment learns its settings from .env.example and `--help`, and ./update.sh announces
    // a release's new ones by diffing the example: a variable missing there is one nobody can find.
    fn read_by_source() -> BTreeSet<String> {
        let needle = concat!("env::var(", "\"EPISKO_");
        [include_str!("main.rs"), include_str!("serve.rs"), include_str!("store.rs")]
            .iter()
            .flat_map(|src| src.split(needle).skip(1))
            .map(|rest| format!("EPISKO_{}", rest.split('"').next().unwrap()))
            .collect()
    }

    fn named_in(text: &str) -> BTreeSet<String> {
        text.split(|c: char| !(c.is_ascii_uppercase() || c == '_'))
            .filter(|w| w.starts_with("EPISKO_") && w.len() > 7)
            .map(String::from)
            .collect()
    }

    #[test]
    fn every_variable_is_in_the_example_and_the_usage() {
        let read = read_by_source();
        assert!(read.contains("EPISKO_REGISTER_CODE"), "the scan found nothing: {read:?}");
        assert_eq!(named_in(include_str!("../.env.example")), read, ".env.example vs. the source");
        assert_eq!(named_in(super::USAGE), read, "USAGE vs. the source");
    }
}
