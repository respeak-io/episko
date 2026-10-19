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
  EPISKO_REGISTER_CODE   lets people join with this code and their own name (default: off)
  EPISKO_HANDOFF         lets people hand a session to another machine through this server:
                         1, true, yes or on (default: off; the transcript is held here until picked up)
  EPISKO_HANDOFF_TTL_HOURS  how long an unclaimed handoff is held, 1 to 720 (default: 72)
  EPISKO_HANDOFF_MAX_MB  the largest handoff accepted, 1 to 1024 (default: 64)
  EPISKO_MEMORY          lets one person's machines share Claude's project memory files:
                         1, true, yes or on (default: off; the files are held here like settings)";

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
            let handoff = handoff_config(
                std::env::var("EPISKO_HANDOFF").ok().as_deref(),
                std::env::var("EPISKO_HANDOFF_TTL_HOURS").ok().as_deref(),
                std::env::var("EPISKO_HANDOFF_MAX_MB").ok().as_deref(),
            );
            match handoff {
                Some(c) => eprintln!("[episko-server] handoff: on (ttl {}h, max {} MiB)", c.ttl_ms / 3_600_000, c.max_bytes >> 20),
                None => eprintln!("[episko-server] handoff: off"),
            }
            let memory = switched_on(std::env::var("EPISKO_MEMORY").ok().as_deref());
            eprintln!("[episko-server] memory stream: {}", if memory { "on" } else { "off" });
            serve::serve(listener, store, Arc::new(serve::Config { ws: WORKSPACE.into(), register, handoff, memory }));
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
                Ok((0, _)) => fail(&format!("no device {device}")),
                Ok((_, ended)) => {
                    println!("revoked {device}");
                    for (_, h) in ended { println!("  handoff {} from {} to {} is now {:?}", h.id, h.from_user, h.to_user, h.state); }
                }
                Err(e) => fail(&e.to_string()),
            }
        }
        Some(_) => fail(USAGE),
    }
}

/// `EPISKO_HANDOFF` switches it on; an out-of-range TTL or size is clamped to its bounds.
fn handoff_config(on: Option<&str>, ttl_hours: Option<&str>, max_mb: Option<&str>) -> Option<store::HandoffCfg> {
    let on = switched_on(on);
    let num = |v: Option<&str>, default: i64, max: i64| v.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(default).clamp(1, max);
    on.then(|| store::HandoffCfg {
        ttl_ms: num(ttl_hours, 72, 720) * 3_600_000,
        max_bytes: (num(max_mb, 64, 1024) as u64) << 20,
    })
}

fn switched_on(v: Option<&str>) -> bool {
    v.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
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

    #[test]
    fn handoff_is_off_unless_switched_on_and_its_limits_are_clamped() {
        use super::handoff_config;
        assert!(handoff_config(None, Some("10"), Some("10")).is_none());
        assert!(handoff_config(Some("0"), None, None).is_none());
        assert!(handoff_config(Some("off"), None, None).is_none());
        let c = handoff_config(Some(" Yes "), None, None).expect("on");
        assert_eq!((c.ttl_ms, c.max_bytes), (72 * 3_600_000, 64 << 20));
        let c = handoff_config(Some("1"), Some("0"), Some("99999")).expect("on");
        assert_eq!((c.ttl_ms, c.max_bytes), (3_600_000, 1024 << 20));
        let c = handoff_config(Some("on"), Some("9999"), Some("junk")).expect("on");
        assert_eq!((c.ttl_ms, c.max_bytes), (720 * 3_600_000, 64 << 20));
    }

    #[test]
    fn memory_is_off_unless_switched_on() {
        use super::switched_on;
        assert!(!switched_on(None) && !switched_on(Some("")) && !switched_on(Some("0")) && !switched_on(Some("off")));
        assert!(switched_on(Some(" ON ")) && switched_on(Some("1")) && switched_on(Some("true")));
    }
}
