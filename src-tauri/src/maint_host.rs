//! `ssh-host` (docs/maintenance.md § Adapters): one fixed, read-only POSIX script over the person's
//! own ssh, in one round trip, each of its sections parsed on its own. Facts only; `maint.ts` judges.

use std::cmp::Ordering;
use std::time::Duration;

use crate::deps::Shared;
use crate::maint::{Coverage, Ctx, Disk, Exec, Facts, HostContainer, HostFacts, Read};

/// The whole answer's cap, and past it every section read so far is lost: `SSH_OPTS` gives the
/// connection ten seconds of it and the script's own limits fit in the rest (a test holds them to it).
pub(crate) const HOST_SECS: u64 = 45;

/// Compiled in, and read-only: nothing is installed, refreshed, locked or restarted. Every command
/// reads `/dev/null`, since `sh -s` reads the rest of this script from that same stdin.
pub(crate) const HOST_SCRIPT: &str = r##"LC_ALL=C; PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin:/snap/bin"; export LC_ALL PATH
if timeout 5 true </dev/null >/dev/null 2>&1; then S='timeout 5'; L='timeout 8'; else S=; L=; fi
echo '@@episko-host 1'
echo '@@now'; date +%s </dev/null
echo '@@uname'; uname -sr </dev/null
echo '@@uptime'; if [ -r /proc/uptime ]; then cat /proc/uptime </dev/null; else sysctl -n kern.boottime </dev/null 2>/dev/null; fi
echo '@@load'; if [ -r /proc/loadavg ]; then cat /proc/loadavg </dev/null; else sysctl -n vm.loadavg </dev/null 2>/dev/null; fi
echo '@@cpus'; getconf _NPROCESSORS_ONLN </dev/null 2>/dev/null
echo '@@df'; $S df -P -k </dev/null 2>/dev/null
if command -v apt-get >/dev/null 2>&1; then
  echo '@@updates apt'; out=$($L apt-get -s -o Debug::NoLocking=1 dist-upgrade </dev/null 2>/dev/null); rc=$?
  printf '%s\n' "$out" | grep '^Inst '; echo "exit $rc"
  echo '@@lists'; stat -c %Y /var/lib/apt/periodic/update-success-stamp /var/lib/apt/lists </dev/null 2>/dev/null
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  pm=dnf; command -v dnf >/dev/null 2>&1 || pm=yum
  echo "@@updates $pm"; $L $pm -C -q check-update </dev/null 2>/dev/null; echo "exit $?"
  echo '@@security'; $S $pm -C -q updateinfo list --security </dev/null 2>/dev/null; echo "exit $?"
elif command -v apk >/dev/null 2>&1; then
  echo '@@updates apk'; $S apk version -l '<' </dev/null 2>/dev/null; echo "exit $?"
fi
echo '@@reboot'
if [ -f /var/run/reboot-required ]; then echo yes; cat /var/run/reboot-required.pkgs </dev/null 2>/dev/null
elif command -v needs-restarting >/dev/null 2>&1; then $S needs-restarting -r </dev/null >/dev/null 2>&1; echo "needs-restarting $?"
fi
echo '@@kernel'; uname -r </dev/null
for f in /boot/vmlinuz-*; do [ -e "$f" ] && echo "${f#/boot/vmlinuz-}"; done
if ! command -v docker >/dev/null 2>&1; then echo '@@docker absent'
else
  ids=$($S docker ps -aq </dev/null 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then echo '@@docker error'; printf '%s\n' "$ids" | head -n 3; echo "exit $rc"
  else
    ids=$(printf '%s\n' "$ids" | grep -E '^[0-9a-f]{12,64}$'); rc=0
    echo '@@docker ok'
    [ -z "$ids" ] || { $S docker inspect --format '{{.Name}}	{{.Config.Image}}	{{.State.Status}}	{{if .State.Health}}{{.State.Health.Status}}{{end}}	{{.RestartCount}}	{{.State.ExitCode}}	{{.State.StartedAt}}	{{index .Config.Labels "com.docker.compose.project"}}	{{index .Config.Labels "com.docker.compose.service"}}' $ids </dev/null 2>/dev/null; rc=$?; }
    echo "exit $rc"
    echo '@@ids'; printf '%s\n' "$ids" | grep -c .
  fi
fi
echo '@@end'
exit 0
"##;

const DISKS: usize = 16;
const PACKAGES: usize = 40;
const CONTAINERS: usize = 100;
// Memory, kernel and runtime filesystems, a snap's or an image layer's read-only mount, and the one
// file a container bind-mounts (`/etc/hosts`): none is a disk of its own that fills up.
const PSEUDO: &[&str] = &["tmpfs", "devtmpfs", "udev", "overlay", "shm", "none", "proc", "sysfs", "efivarfs", "devfs"];
const UNDER: &[&str] = &["/proc", "/sys", "/dev", "/run", "/snap", "/etc", "/var/lib/docker", "/System/Volumes"];

type Answer = Result<(HostFacts, bool, Vec<String>), Coverage>;

/// One round trip per alias in flight, so two projects on one host share it during one Check prod.
/// A failure is shared only while in flight: `read_with` forgets it as it lands.
static HOSTS: Shared<String, Answer> = Shared::new(KEEP, JOIN, STALL);
const KEEP: Duration = Duration::from_secs(60);
const JOIN: Duration = Duration::from_secs(15);
const STALL: Duration = Duration::from_secs(HOST_SECS + 15);

/// `[deploy] host`, read over ssh: a `remote` source, so a click only (maint.rs's gate).
pub(crate) fn ssh_host(ctx: &Ctx, ex: &dyn Exec) -> Result<Read, Coverage> {
    read_with(ctx, ex, &HOSTS)
}

fn read_with(ctx: &Ctx, ex: &dyn Exec, cache: &Shared<String, Answer>) -> Result<Read, Coverage> {
    let d = crate::deploy::read(ctx.root).unwrap_or_default();
    let Some(alias) = d.host() else { return Err(Coverage::Unsupported { reason: "no host in [deploy]".into() }) };
    // The file as it is now, against the tick: a pull can move `[deploy] host` under whatever the frontend last detected.
    if !ctx.hosts.iter().any(|h| h == alias) {
        return Err(Coverage::NotRun);
    }
    let got = cache.get(alias.to_string(), ctx.force, || ask(ex, alias));
    if got.is_err() {
        cache.forget(|k| k == alias);
    }
    let (mut h, truncated, gaps) = got?;
    h.compose = d.compose().to_vec();
    Ok(Read { facts: Facts::Hosts { items: vec![h] }, truncated, gaps })
}

/// The script as sh must read it: a Windows checkout may give this file CRLF, and sh reads a `\r` as part of a word.
fn script() -> String {
    HOST_SCRIPT.replace('\r', "")
}

fn ask(ex: &dyn Exec, alias: &str) -> Answer {
    let out = ex.ssh(alias, &script(), HOST_SECS).map_err(|e| ssh_coverage(&e, alias))?;
    // 255 is ssh's own failure (the connection, a key, the host key); any other exit is the script's.
    if out.code == Some(255) {
        return Err(ssh_coverage(&out.stderr, alias));
    }
    parse_host(alias, &out.stdout).map_err(|reason| {
        let said = out.stderr.trim().lines().next().unwrap_or("").trim();
        Coverage::Error { reason: if said.is_empty() { reason } else { format!("{reason}: {said}") } }
    })
}

#[cfg(windows)]
const NO_SSH: &str = "ssh (install OpenSSH Client: Settings › System › Optional features)";
#[cfg(not(windows))]
const NO_SSH: &str = "ssh (install an OpenSSH client)";

/// ssh's failure as a coverage. A fix is only ever a command to run in a terminal, where a key's
/// passphrase or a first host key can be answered by the person; Episko answers neither.
pub(crate) fn ssh_coverage(err: &str, alias: &str) -> Coverage {
    let e = err.trim();
    let again = Some(format!("ssh {alias}"));
    if e.contains("Permission denied") || e.contains("Too many authentication failures") {
        return Coverage::NoAccess { reason: format!("{alias} refused every key ssh offered from this machine"), fix: again };
    }
    if e.contains("Host key verification failed") || e.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        let reason = format!("{alias}'s host key is not in known_hosts or has changed; Episko never adds or replaces one");
        return Coverage::NoAccess { reason, fix: again };
    }
    if e.contains("Could not resolve hostname") {
        let name = alias.rsplit('@').next().unwrap_or(alias); // a `Host` pattern matches the host part alone
        return Coverage::NoAccess { reason: format!("ssh cannot resolve {alias}: add a Host {name} entry to ~/.ssh/config"), fix: None };
    }
    if e.contains("ssh is not on PATH") {
        return Coverage::NoTool { tool: NO_SSH.into(), fix: None };
    }
    let said: Vec<&str> = e.lines().map(str::trim).filter(|l| !l.is_empty()).take(3).collect();
    Coverage::Error { reason: if said.is_empty() { format!("ssh to {alias} failed and said nothing") } else { said.join(" ") } }
}

// ---------- the answer, section by section ----------

struct Section<'a> {
    name: &'a str,
    arg: &'a str,
    lines: Vec<&'a str>,
}

/// What follows the sentinel, cut at each `@@` line. Anything before it (a motd, a `.bashrc`'s echo)
/// is not ours; no sentinel or no end marker is an error, never an empty host.
fn sections(out: &str) -> Result<Vec<Section<'_>>, String> {
    let mut lines = out.lines().map(|l| l.trim_end_matches('\r'));
    if !lines.by_ref().any(|l| l.trim() == "@@episko-host 1") {
        return Err("did not run Episko's script (a forced command or a restricted shell answered instead)".into());
    }
    let mut out: Vec<Section> = vec![];
    for l in lines {
        if let Some(head) = l.strip_prefix("@@") {
            let (name, arg) = head.split_once(' ').unwrap_or((head, ""));
            if name == "end" {
                return Ok(out);
            }
            out.push(Section { name, arg: arg.trim(), lines: vec![] });
        } else if let Some(s) = out.last_mut().filter(|_| !l.trim().is_empty()) {
            s.lines.push(l);
        }
    }
    Err("the answer was cut off before its end".into())
}

/// `@@updates`' last line is the command's own exit, so a listing that failed is never zero updates.
fn with_exit<'a>(lines: &'a [&'a str]) -> (&'a [&'a str], Option<i32>) {
    match lines.split_last().and_then(|(last, rest)| Some((rest, last.strip_prefix("exit ")?))) {
        Some((rest, code)) => (rest, code.trim().parse().ok()),
        None => (lines, None),
    }
}

fn parse_host(alias: &str, out: &str) -> Result<(HostFacts, bool, Vec<String>), String> {
    let secs = sections(out).map_err(|e| format!("{alias} {e}"))?;
    let get = |n: &str| secs.iter().find(|s| s.name == n);
    let lines = |n: &str| get(n).map_or(&[][..], |s| &s.lines[..]);
    let one = |n: &str| lines(n).first().map(|l| l.trim());
    let (mut gaps, mut truncated) = (vec![], false);
    let mut h = HostFacts { alias: alias.to_string(), ..Default::default() };
    h.now = one("now").and_then(|v| v.parse().ok());
    h.os = one("uname").filter(|v| !v.is_empty()).map(String::from);
    h.uptime = parse_uptime(lines("uptime"), h.now);
    h.load = parse_load(lines("load"));
    h.cpus = one("cpus").and_then(|v| v.parse().ok()).filter(|n| *n > 0);
    if h.uptime.is_none() {
        gaps.push(format!("uptime on {alias} not read"));
    }
    if h.load.is_none() || h.cpus.is_none() {
        gaps.push(format!("load on {alias} not read"));
    }
    let (disks, seen) = parse_df(lines("df"));
    if disks.is_empty() {
        gaps.push(format!("no filesystem read on {alias}, so its disks are unknown"));
    } else if disks.len() < seen {
        gaps.push(format!("{} of {seen} filesystems listed", disks.len()));
    }
    h.disks = disks;
    read_updates(&mut h, get("updates"), get("security"), lines("lists"), &mut gaps);
    (h.reboot, h.reboot_why) = parse_reboot(lines("reboot"), lines("kernel"));
    match get("docker") {
        Some(s) if s.arg == "ok" => {
            let (rows, exit) = with_exit(&s.lines);
            let mut all: Vec<HostContainer> = rows.iter().filter_map(|l| parse_container(l)).collect();
            let named = one("ids").and_then(|v| v.parse::<usize>().ok());
            // A list short of what docker named would read a running service as stopped: whole, or unknown.
            if exit != Some(0) || named != Some(all.len()) {
                let how = exit.filter(|e| *e != 0).map_or(String::new(), |e| format!(" (exit {e})"));
                gaps.push(format!("docker on {alias} described {} of {} containers{how}, so they are unknown", all.len(), named.unwrap_or(rows.len())));
            } else {
                // `docker ps` lists newest first, so without this the cap drops the long-running services.
                all.sort_by_key(|c| matches!(c.state.as_str(), "exited" | "created"));
                truncated = all.len() > CONTAINERS;
                all.truncate(CONTAINERS);
                h.containers = Some(all);
            }
        }
        Some(s) if s.arg == "error" => {
            let (said, exit) = with_exit(&s.lines);
            let why = said.first().map_or(if exit == Some(124) { "no answer in time" } else { "not readable" }, |l| l.trim());
            gaps.push(format!("docker on {alias}: {why}"));
        }
        Some(s) if s.arg == "absent" => gaps.push(format!("no docker on {alias}")),
        _ => gaps.push(format!("the containers on {alias} were not read")),
    }
    Ok((h, truncated, gaps))
}

fn read_updates(h: &mut HostFacts, updates: Option<&Section>, security: Option<&Section>, lists: &[&str], gaps: &mut Vec<String>) {
    let alias = h.alias.clone();
    let Some(s) = updates else {
        gaps.push(format!("no package manager Episko reads on {alias}, so pending updates are unknown"));
        return;
    };
    let (rows, exit) = with_exit(&s.lines);
    // dnf and yum exit 100 when there is something to update.
    let ok = exit == Some(0) || (matches!(s.arg, "dnf" | "yum") && exit == Some(100));
    if !ok {
        gaps.push(format!("{} on {alias} could not list updates, so pending updates are unknown", s.arg));
        return;
    }
    let (names, sec): (Vec<String>, Option<Vec<String>>) = match s.arg {
        "apt" => {
            h.lists_at = lists.iter().filter_map(|l| l.trim().parse::<u64>().ok()).max();
            // A 0 off lists of unknown age is no known 0; dnf and apk give no age to lose.
            if h.lists_at.is_none() {
                gaps.push(format!("apt on {alias} gave no package list age, so pending updates are unknown"));
                return;
            }
            let (sec, rest) = parse_apt(rows);
            ([&sec[..], &rest[..]].concat(), Some(sec))
        }
        "dnf" | "yum" => {
            let names = parse_dnf(rows);
            // 100 says something is pending, so a list with no row read is not understood, never zero.
            if exit == Some(100) && names.is_empty() {
                gaps.push(format!("{} on {alias} has updates pending and a list Episko could not read, so they are unknown", s.arg));
                return;
            }
            let sec = security.map(|x| with_exit(&x.lines)).filter(|(_, e)| *e == Some(0)).and_then(|(r, _)| dnf_security(r, &names));
            if sec.is_none() {
                gaps.push(format!("{} on {alias} did not tell security updates apart", s.arg));
            }
            (names, sec)
        }
        "apk" => (parse_apk(rows), None),
        other => {
            gaps.push(format!("{other} on {alias} is not a package manager Episko reads"));
            return;
        }
    };
    h.pm = Some(s.arg.to_string());
    h.updates = Some(names.len() as u32);
    h.security = sec.as_ref().map(|x| x.len() as u32);
    let first = sec.unwrap_or_default();
    let mut ordered: Vec<String> = first.iter().cloned().chain(names.into_iter().filter(|n| !first.contains(n))).collect();
    ordered.dedup();
    ordered.truncate(PACKAGES);
    h.packages = ordered;
}

/// Linux's `/proc/uptime` (`345132.42 85696.21`), or BSD's boot time (`{ sec = N, usec = 0 } …`) against the host's clock.
fn parse_uptime(lines: &[&str], now: Option<u64>) -> Option<u64> {
    let l = lines.first()?.trim();
    if let Some(i) = l.find("sec =") {
        let boot: u64 = l[i + 5..].trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
        return now?.checked_sub(boot);
    }
    l.split_whitespace().next()?.parse::<f64>().ok().filter(|s| s.is_finite() && *s >= 0.0).map(|s| s as u64)
}

/// `0.00 0.01 0.05 1/28 1234` (Linux) or `{ 1.2 1.1 0.9 }` (BSD): the 1, 5 and 15 minute figures.
fn parse_load(lines: &[&str]) -> Option<[f64; 3]> {
    let l = lines.first()?.trim().trim_start_matches('{').trim_end_matches('}');
    let v: Vec<f64> = l.split_whitespace().take(3).map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let [a, b, c] = v[..] else { return None };
    [a, b, c].iter().all(|x| x.is_finite() && *x >= 0.0).then_some([a, b, c])
}

/// `df -P -k`'s real filesystems, `/` first, and how many there were before the cap.
fn parse_df(lines: &[&str]) -> (Vec<Disk>, usize) {
    let mut all: Vec<Disk> = lines.iter().filter_map(|l| df_row(l)).filter(|(src, d)| real(src, d)).map(|(_, d)| d).collect();
    let seen = all.len();
    all.sort_by_key(|d| d.mount != "/");
    all.truncate(DISKS);
    (all, seen)
}

// Anchored on the capacity column, so a source or mount holding spaces (`C:/Program Files/Git`) still reads.
fn df_row(l: &str) -> Option<(String, Disk)> {
    let t: Vec<&str> = l.split_whitespace().collect();
    let pct = |x: &str| x.strip_suffix('%').is_some_and(|n| n.parse::<u32>().is_ok());
    // Available goes negative on a BSD filesystem past its reserve: that is the fullest disk, not a row to lose.
    let avail = |x: &str| x.parse::<i64>().ok().map(|v| v.max(0) as u64);
    let i = (4..t.len()).find(|&i| pct(t[i]) && t[i - 3..i - 1].iter().all(|x| x.parse::<u64>().is_ok()) && avail(t[i - 1]).is_some())?;
    let n = |k: usize| t[k].parse::<u64>().ok();
    let mount = t[i + 1..].join(" ");
    if mount.is_empty() {
        return None;
    }
    Some((t[..i - 3].join(" "), Disk { mount, size_kb: n(i - 3)?, used_kb: n(i - 2)?, avail_kb: avail(t[i - 1])? }))
}

// `/` is the disk whatever backs it (overlay in a container); a mounted disc is always 100%.
fn real(src: &str, d: &Disk) -> bool {
    let under = |p: &str| d.mount == p || d.mount.strip_prefix(p).is_some_and(|r| r.starts_with('/'));
    d.size_kb > 0 && (d.mount == "/" || (!PSEUDO.contains(&src) && !src.starts_with("cgroup") && !src.starts_with("/dev/loop")
        && !src.starts_with("/dev/sr") && !src.starts_with("map ") && !UNDER.iter().any(|p| under(p))))
}

/// `Inst <pkg> [old] (new origin, origin [arch])` lines: security first, by its origin's pocket.
fn parse_apt(rows: &[&str]) -> (Vec<String>, Vec<String>) {
    let (mut sec, mut rest) = (vec![], vec![]);
    for l in rows.iter().filter_map(|l| l.strip_prefix("Inst ")) {
        let Some(name) = l.split_whitespace().next() else { continue };
        let from = l.split_once('(').map_or("", |(_, r)| r);
        (if from.contains("-security") { &mut sec } else { &mut rest }).push(name.to_string());
    }
    (sec, rest)
}

/// `name.arch  version  repo`, up to the obsoleted packages dnf lists after. dnf and yum wrap a long
/// value onto the next line, indented, so a row is put back together first.
fn parse_dnf(rows: &[&str]) -> Vec<String> {
    let mut whole: Vec<String> = vec![];
    for l in rows.iter().take_while(|l| !l.trim_start().starts_with("Obsoleting")) {
        match whole.last_mut().filter(|_| l.starts_with(char::is_whitespace)) {
            Some(row) => row.push_str(l),
            None => whole.push(l.to_string()),
        }
    }
    whole.iter().filter_map(|l| {
        let t: Vec<&str> = l.split_whitespace().collect();
        let (name, arch) = t.first()?.rsplit_once('.')?;
        (t.len() == 3 && !name.is_empty() && !arch.is_empty()).then(|| name.to_string())
    }).collect()
}

/// Which pending names `updateinfo list --security` covers, each once: dnf 4 prints three columns and
/// dnf 5 a table, so a row's package is found by the pending name it starts with. Rows naming none
/// of them are a listing not understood: `None`, never "no security updates".
fn dnf_security(rows: &[&str], names: &[String]) -> Option<Vec<String>> {
    let rows: Vec<Vec<&str>> = rows.iter().map(|l| l.split_whitespace().collect::<Vec<_>>()).filter(|t| t.len() >= 3 && t[0] != "Name").collect();
    let names_it = |w: &str, n: &str| w.strip_prefix(n).and_then(|r| r.strip_prefix('-')).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
    let mut sec: Vec<String> = names.iter().filter(|n| rows.iter().any(|t| t.iter().any(|w| names_it(w, n)))).cloned().collect();
    sec.sort();
    sec.dedup();
    (rows.is_empty() || !sec.is_empty()).then_some(sec)
}

/// `apk version -l '<'`: `name-1.2.3-r4  < 1.2.3-r5`, the name ending where a `-` meets a digit.
fn parse_apk(rows: &[&str]) -> Vec<String> {
    rows.iter().filter(|l| l.contains(" < ")).filter_map(|l| {
        let pv = l.split_whitespace().next()?;
        let b = pv.as_bytes();
        Some((1..b.len()).find(|&i| b[i - 1] == b'-' && b[i].is_ascii_digit()).map_or(pv, |i| &pv[..i - 1]).to_string())
    }).collect()
}

/// The host's own word (Debian's reboot-required, RHEL's needs-restarting), else the running kernel
/// against the newest installed one. Unknown with neither, or when what runs is newer than all of
/// `/boot` (a hypervisor's kernel, a removed package): `/boot` then cannot say.
fn parse_reboot(reboot: &[&str], kernel: &[&str]) -> (Option<bool>, Vec<String>) {
    let kernels = || -> (Option<bool>, Vec<String>) {
        let Some(running) = kernel.first().map(|l| l.trim()) else { return (None, vec![]) };
        let installed = kernel[1..].iter().map(|l| l.trim()).filter(|k| k.starts_with(|c: char| c.is_ascii_digit()));
        let Some(newest) = installed.max_by_key(|k| ver_nums(k)) else { return (None, vec![]) };
        match ver_nums(newest).cmp(&ver_nums(running)) {
            Ordering::Less => (None, vec![]),
            Ordering::Equal => (Some(false), vec![]),
            Ordering::Greater => (Some(true), vec![format!("kernel {newest} installed, {running} running")]),
        }
    };
    let first = reboot.first().map(|l| l.trim());
    if first == Some("yes") {
        return (Some(true), reboot[1..].iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).take(12).collect());
    }
    match first.and_then(|l| l.strip_prefix("needs-restarting ")).map(str::trim) {
        Some("1") => (Some(true), kernels().1.into_iter().chain(["needs-restarting: updated since boot".to_string()]).take(1).collect()),
        Some("0") => (Some(false), vec![]),
        _ => kernels(),
    }
}

/// A kernel's numbers in order: `6.8.0-49` is newer than `6.8.0-45`, and a flavour or an
/// `.efi.signed` twin of one version is no newer than it.
fn ver_nums(s: &str) -> Vec<u64> {
    s.split(|c: char| !c.is_ascii_digit()).filter_map(|r| r.parse().ok()).collect()
}

/// One `docker inspect` row: nine tab-separated fields, a missing label empty.
fn parse_container(l: &str) -> Option<HostContainer> {
    let f: Vec<&str> = l.split('\t').collect();
    let [name, image, state, health, restarts, exit, started, project, service] = f[..] else { return None };
    let word = |s: &str| Some(s.trim()).filter(|s| !s.is_empty() && *s != "<no value>").map(String::from);
    let c = HostContainer {
        name: name.trim().trim_start_matches('/').to_string(), image: image.trim().to_string(), state: state.trim().to_string(),
        health: word(health), restarts: restarts.trim().parse().ok()?, exit: exit.trim().parse().ok(),
        started_at: rfc3339(started.trim()), project: word(project), service: word(service),
    };
    (!c.name.is_empty() && !c.state.is_empty()).then_some(c)
}

/// `2026-11-03T20:02:26.632370442Z` as unix secs; Docker's never-started `0001-01-01…` is None.
fn rfc3339(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    if y < 1970 || !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let (clock, off) = time.find(['Z', '+', '-']).map_or((time, ""), |i| (&time[..i], &time[i..]));
    let mut c = clock.split('.').next()?.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, sec) = (c.next()??, c.next()??, c.next()??);
    let shift = match off {
        "" | "Z" => 0,
        o => {
            let (oh, om) = o[1..].split_once(':')?;
            (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60) * if o.starts_with('-') { -1 } else { 1 }
        }
    };
    u64::try_from(crate::usage::days_from_civil(y, m, day) * 86_400 + h * 3600 + mi * 60 + sec - shift).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::{Forge, ForgeBy, ForgeKind};
    use crate::maint::exec::FakeExec;
    use crate::maint::MaintConfig;
    use crate::testutil::scratch_dir;
    use std::io::Write;
    use std::process::Stdio;

    const NONE: Forge = Forge { kind: ForgeKind::None, host: None, path: None, by: ForgeBy::None, api: None };

    fn parsed(file: &str) -> (HostFacts, bool, Vec<String>) {
        parse_host("prod-1", &FakeExec::testdata(file)).unwrap()
    }

    fn mounts(h: &HostFacts) -> Vec<&str> {
        h.disks.iter().map(|d| d.mount.as_str()).collect()
    }

    #[test]
    fn an_ubuntu_host_reads_whole() {
        let (h, truncated, gaps) = parsed("ssh-host-ubuntu.txt");
        assert_eq!((h.now, h.os.as_deref(), h.uptime, h.cpus), (Some(1_793_700_000), Some("Linux 6.8.0-45-generic"), Some(3_542_400), Some(4)));
        assert_eq!(h.load, Some([0.42, 0.61, 0.58]));
        assert_eq!(mounts(&h), ["/", "/boot", "/boot/efi", "/srv/data"], "tmpfs, overlay, loop and /run are no disks");
        assert_eq!((h.disks[0].used_kb, h.disks[0].avail_kb), (48_123_456, 2_480_376));
        assert_eq!((h.pm.as_deref(), h.updates, h.security), (Some("apt"), Some(14), Some(6)));
        assert_eq!(&h.packages[..2], ["libssl3t64", "openssl"], "security first");
        assert_eq!(h.packages.len(), 14);
        assert_eq!(h.lists_at, Some(1_793_000_000), "the newer of the stamp and the lists");
        assert_eq!((h.reboot, h.reboot_why.clone()), (Some(true), vec!["linux-image-6.8.0-49-generic".to_string(), "linux-base".into()]));
        let cs = h.containers.unwrap();
        assert_eq!(cs.len(), 5);
        assert_eq!((cs[0].name.as_str(), cs[0].health.as_deref(), cs[0].service.as_deref()), ("acme-api-1", Some("unhealthy"), Some("api")));
        assert_eq!((cs[1].restarts, cs[1].started_at), (12, Some(1_793_657_405)));
        assert_eq!((cs[4].exit, cs[4].started_at, cs[4].project.as_deref()), (Some(1), None, None), "never started; no labels");
        assert!(!truncated && gaps.is_empty(), "{gaps:?}");
    }

    #[test]
    fn a_rhel_host_reads_dnf_and_its_security_list() {
        let (h, _, gaps) = parsed("ssh-host-rhel.txt");
        assert_eq!((h.pm.as_deref(), h.updates, h.security), (Some("dnf"), Some(6), Some(2)), "two wrapped rows count; obsoleted packages do not");
        assert!(h.packages.contains(&"java-1.8.0-openjdk-headless".to_string()) && h.packages.contains(&"python3-policycoreutils".to_string()), "{:?}", h.packages);
        assert_eq!(&h.packages[..2], ["kernel", "openssl-libs"]);
        assert_eq!((h.reboot, h.lists_at), (Some(false), None), "needs-restarting's word; dnf -C gives no list age");
        assert_eq!(mounts(&h), ["/", "/boot"]);
        assert_eq!(h.containers, None);
        assert_eq!(gaps, ["no docker on prod-1"]);
    }

    #[test]
    fn a_bare_host_says_what_it_could_not_read() {
        let (h, _, gaps) = parsed("ssh-host-bare.txt");
        assert_eq!((h.updates, h.security, h.pm.clone()), (None, None, None), "no package manager is unknown, never 0");
        assert_eq!(h.reboot, None, "no /boot and no word from the host");
        assert_eq!(h.containers, None);
        assert_eq!(mounts(&h), ["/"]);
        assert_eq!(gaps.len(), 2, "{gaps:?}");
        assert!(gaps[0].contains("no package manager") && gaps[1].starts_with("docker on prod-1: permission denied"), "{gaps:?}");
    }

    #[test]
    fn only_the_script_answers() {
        let noise = FakeExec::testdata("ssh-host-noise.txt");
        let (h, _, _) = parse_host("prod-1", &noise).unwrap();
        assert_eq!((h.uptime, h.cpus), (Some(600), Some(2)), "a motd and a .bashrc's echo are not ours");
        let cut = noise.replace("@@end", "");
        assert!(parse_host("prod-1", &cut).unwrap_err().contains("cut off"));
        for junk in ["", "<html><body>502</body></html>", "This account is currently not available.\n"] {
            assert!(parse_host("prod-1", junk).unwrap_err().contains("did not run Episko's script"), "{junk:?}");
        }
    }

    /// What each real package manager printed, the script piped into sh in a container of it.
    #[test]
    fn real_package_managers_read_as_recorded() {
        let (h, _, gaps) = parsed("ssh-host-rec-ubuntu.txt");
        assert_eq!((h.pm.as_deref(), h.updates, h.security, h.lists_at), (Some("apt"), Some(1), Some(1), Some(1_793_746_283)));
        assert_eq!(h.packages, ["libpcre2-8-0"]);
        assert_eq!(mounts(&h), ["/"], "an overlay root is kept, and a container's bind-mounted /etc/hosts is no disk");
        assert_eq!(h.reboot, None, "no /boot and no word from the host");
        assert_eq!(gaps, ["no docker on prod-1"]);

        let (h, _, gaps) = parsed("ssh-host-rec-alpine.txt");
        assert_eq!((h.pm.as_deref(), h.updates, h.security, h.lists_at), (Some("apk"), Some(9), None, None), "its header is no row");
        assert_eq!(&h.packages[..3], ["alpine-release", "apk-tools", "ca-certificates-bundle"]);
        assert_eq!(mounts(&h), ["/"]);
        assert_eq!(gaps, ["no docker on prod-1"]);

        let (h, _, gaps) = parsed("ssh-host-rec-rocky.txt");
        assert_eq!((h.pm.as_deref(), h.updates, h.security), (Some("dnf"), Some(111), Some(57)), "205 advisory rows name 57 of the 111 pending");
        assert_eq!(h.packages.len(), PACKAGES);
        assert_eq!(&h.packages[..2], ["binutils", "binutils-gold"], "security first");
        assert_eq!(gaps, ["no docker on prod-1"]);

        let (h, _, gaps) = parsed("ssh-host-rec-fedora.txt");
        assert_eq!((h.pm.as_deref(), h.updates, h.security), (Some("dnf"), Some(2), Some(0)), "dnf 5: no advisory pending is a known 0");
        assert_eq!(h.packages, ["xz", "xz-libs"]);
        assert_eq!(gaps, ["no docker on prod-1"]);
    }

    const ROW: &str = "/a\ti\trunning\t\t0\t0\t2026-11-03T20:02:26Z\tp\ts\n";

    fn docker(rows: &str, exit: i32, ids: usize) -> String {
        format!("@@episko-host 1\n@@docker ok\n{rows}exit {exit}\n@@ids\n{ids}\n@@end\n")
    }

    #[test]
    fn a_host_with_no_container_read_fine_and_one_past_the_cap_says_so() {
        let (h, truncated, gaps) = parse_host("prod-1", &docker("", 0, 0)).unwrap();
        assert_eq!((h.containers, truncated), (Some(vec![]), false), "no containers is an empty list, not an error");
        assert!(!gaps.iter().any(|g| g.contains("docker") || g.contains("container")), "{gaps:?}");
        let (h, truncated, _) = parse_host("prod-1", &docker(&ROW.repeat(CONTAINERS + 1), 0, CONTAINERS + 1)).unwrap();
        assert_eq!((h.containers.unwrap().len(), truncated), (CONTAINERS, true));
    }

    #[test]
    fn the_cap_keeps_what_runs_over_what_exited_last() {
        let old = "/old\ti\texited\t\t0\t0\t2026-11-03T20:02:26Z\tp\tcron\n".repeat(CONTAINERS);
        let (h, truncated, _) = parse_host("prod-1", &docker(&format!("{old}{ROW}"), 0, CONTAINERS + 1)).unwrap();
        let cs = h.containers.unwrap();
        assert_eq!((cs.len(), truncated, cs[0].state.as_str()), (CONTAINERS, true, "running"), "docker ps lists the newest first");
    }

    /// Unknown, never an empty host: read as empty it is a green 0/0, or a false red for a named service.
    #[test]
    fn a_container_list_short_of_what_docker_named_is_unknown() {
        for (answer, why) in [(docker("", 1, 2), "(exit 1)"), (docker(ROW, 124, 2), "1 of 2"), (docker("not\ta\trow\n", 0, 1), "0 of 1"), (docker(ROW, 0, 2), "1 of 2")] {
            let (h, truncated, gaps) = parse_host("prod-1", &answer).unwrap();
            assert_eq!((h.containers, truncated), (None, false), "{answer}");
            assert!(gaps.iter().any(|g| g.starts_with("docker on prod-1") && g.contains(why) && g.ends_with("unknown")), "{why}: {gaps:?}");
        }
    }

    #[test]
    fn every_section_that_did_not_parse_is_a_gap() {
        let (h, _, gaps) = parse_host("prod-1", "@@episko-host 1\n@@uptime\nnope\n@@load\n1 2\n@@cpus\n0\n@@end\n").unwrap();
        assert_eq!((h.uptime, h.load, h.cpus), (None, None, None));
        for want in ["uptime on prod-1", "load on prod-1", "no filesystem read on prod-1", "no package manager", "containers on prod-1"] {
            assert!(gaps.iter().any(|g| g.contains(want)), "{want}: {gaps:?}");
        }
    }

    #[test]
    fn package_lists_of_no_known_age_are_no_known_zero() {
        let answer = |lists: &str| format!("@@episko-host 1\n@@updates apt\nexit 0\n{lists}@@end\n");
        let (h, _, gaps) = parse_host("prod-1", &answer("@@lists\n")).unwrap();
        assert_eq!((h.updates, h.pm.as_deref(), h.lists_at), (None, None, None));
        assert!(gaps.iter().any(|g| g.contains("no package list age")), "{gaps:?}");
        let (h, _, _) = parse_host("prod-1", &answer("@@lists\n1793000000\n")).unwrap();
        assert_eq!((h.updates, h.pm.as_deref(), h.lists_at), (Some(0), Some("apt"), Some(1_793_000_000)));
    }

    #[test]
    fn dnf_pending_with_no_row_read_is_unknown_not_zero() {
        let answer = |rows: &str, exit: i32| format!("@@episko-host 1\n@@updates dnf\n{rows}exit {exit}\n@@end\n");
        let (h, _, gaps) = parse_host("prod-1", &answer("a table this build cannot read\n", 100)).unwrap();
        assert_eq!(h.updates, None);
        assert!(gaps.iter().any(|g| g.contains("could not read")), "{gaps:?}");
        assert_eq!(parse_host("prod-1", &answer("", 0)).unwrap().0.updates, Some(0), "0 is dnf saying nothing is pending");
    }

    #[test]
    fn dnf_rows_wrap_either_way_and_stay_one_package() {
        let rows = ["java-1.8.0-openjdk-headless.x86_64", "       1:1.8.0.402.b06-2.el8     appstream", "curl.x86_64  7.76.1-29.el9_4.1", "     baseos",
            "vim-minimal.x86_64   2:8.2.2637-20.el9_1.1     baseos", "Obsoleting Packages", "grub2-tools.x86_64  1:2.06-80.el9  baseos"];
        assert_eq!(parse_dnf(&rows), ["java-1.8.0-openjdk-headless", "curl", "vim-minimal"]);
    }

    #[test]
    fn security_rows_are_matched_to_what_is_pending_whichever_table_prints_them() {
        let names: Vec<String> = ["curl", "kernel", "kernel-core"].map(String::from).to_vec();
        let dnf4 = ["RHSA-2024:1 Important/Sec. kernel-5.14.0-427.18.1.el9_4.x86_64", "RHSA-2024:2 Moderate/Sec. kernel-5.14.0-427.18.1.el9_4.x86_64", "RHSA-2024:3 Low/Sec. kernel-5.14.0-427.19.1.el9_4.x86_64"];
        assert_eq!(dnf_security(&dnf4, &names).unwrap(), ["kernel"], "one row per advisory, and security never counts past pending");
        // Recorded from dnf 5.2 in a fedora:41 container, with `--all` since nothing there was pending.
        let dnf5 = ["Name                   Type     Severity                              Package              Issued",
            "FEDORA-2025-051becf4f2 security Low                  xz-1:5.8.1-2.fc41.x86_64 2025-05-10 01:58:21",
            "FEDORA-2025-051becf4f2 security Low             xz-libs-1:5.8.1-2.fc41.x86_64 2025-05-10 01:58:21"];
        assert_eq!(dnf_security(&dnf5, &["curl".to_string(), "xz".into(), "xz-libs".into()]).unwrap(), ["xz", "xz-libs"]);
        assert_eq!(dnf_security(&[], &names), Some(vec![]), "no advisory is a known zero");
        assert_eq!(dnf_security(&dnf5[..1], &names), Some(vec![]), "a bare header too");
        assert_eq!(dnf_security(&dnf5, &names), None, "rows naming nothing pending are not zero");
        assert_eq!(dnf_security(&["RHSA-2024:1 Important/Sec. unrelated-1.0.x86_64"], &names), None, "rows nothing matched are not zero");
    }

    #[test]
    fn df_reads_a_mount_or_source_with_spaces() {
        // Recorded from Git Bash's df here, with spaces in the filesystem column.
        let lines = ["Filesystem 1024-blocks Used Available Capacity Mounted on",
            "C:/Program Files/Git  1952449532 1663396036 289053496      86% /",
            "/dev/sdc1  1000 500 500  50% /mnt/My Disk", "tmpfs 1000 0 1000 0% /tmp", "/dev/sdd1 0 0 0 - /mnt/empty"];
        let (disks, seen) = parse_df(&lines);
        assert_eq!(seen, 2);
        assert_eq!(disks[0], Disk { mount: "/".into(), size_kb: 1_952_449_532, used_kb: 1_663_396_036, avail_kb: 289_053_496 });
        assert_eq!(disks[1].mount, "/mnt/My Disk");
        let (root, _) = parse_df(&["overlay 1000 960 40 96% /", "/dev/sdb1 1000 100 900 10% /data"]);
        assert_eq!(root.iter().map(|d| d.mount.as_str()).collect::<Vec<_>>(), ["/", "/data"], "/ is a disk whatever backs it");
        assert_eq!(parse_df(&["/dev/sr0 1024 1024 0 100% /media/cdrom"]).1, 0, "a mounted disc is always full");
        assert_eq!(parse_df(&["/dev/ada0p2 1000 1030 -50 105% /"]).0[0].avail_kb, 0, "past its reserve: the fullest disk, not a lost row");
        let many: Vec<String> = (0..20).map(|i| format!("/dev/sd{i} 10 5 5 50% /m{i}")).collect();
        let (disks, seen) = parse_df(&many.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!((disks.len(), seen), (DISKS, 20));
    }

    #[test]
    fn ssh_failures_are_coverages_with_a_terminal_fix() {
        let no = |e: &str| ssh_coverage(e, "prod-1");
        for e in ["deploy@prod-1: Permission denied (publickey).", "Received disconnect: Too many authentication failures",
            "No ED25519 host key is known for prod-1 and you have requested strict checking.\r\nHost key verification failed.",
            "@@@@@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @"] {
            assert!(matches!(no(e), Coverage::NoAccess { fix: Some(ref f), .. } if f == "ssh prod-1"), "{e}");
        }
        assert!(matches!(no("ssh: Could not resolve hostname prod-1: Name or service not known"),
            Coverage::NoAccess { fix: None, ref reason } if reason.contains("Host prod-1 entry")));
        assert!(matches!(ssh_coverage("ssh: Could not resolve hostname prod-1: nodename", "deploy@prod-1"),
            Coverage::NoAccess { ref reason, .. } if reason.ends_with("add a Host prod-1 entry to ~/.ssh/config")), "a Host pattern matches the host part");
        assert!(matches!(no("ssh is not on PATH"), Coverage::NoTool { fix: None, ref tool } if tool.starts_with("ssh (install")));
        assert_eq!(no("no answer after 45s"), Coverage::Error { reason: "no answer after 45s".into() });
        assert_eq!(no("ssh: connect to host prod-1 port 22: Connection refused\n"), Coverage::Error { reason: "ssh: connect to host prod-1 port 22: Connection refused".into() });
        assert!(matches!(no(""), Coverage::Error { ref reason } if reason.contains("said nothing")));
    }

    fn repo(deploy: &str) -> String {
        let dir = scratch_dir();
        std::fs::create_dir_all(dir.join(".episko")).unwrap();
        std::fs::write(dir.join(".episko").join("episko.toml"), deploy).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn read(root: &str, ex: &FakeExec, cache: &Shared<String, Answer>) -> Result<Read, Coverage> {
        read_with(&Ctx { root, cfg: &MaintConfig::default(), forge: &NONE, account: None, force: true, hosts: &["prod-1".to_string()] }, ex, cache)
    }

    #[test]
    fn a_host_is_read_once_and_its_services_are_the_projects() {
        let cache = Shared::new(KEEP, JOIN, STALL);
        let (a, b) = (repo("[deploy]\nhost = \"prod-1\"\ncompose = [\"api\"]\n"), repo("[deploy]\nhost = \"prod-1\"\ncompose = \"worker\"\n"));
        let ex = FakeExec::recorded("ssh-host-ubuntu.txt");
        let hosts = |r: Read| match r.facts { Facts::Hosts { items } => items, f => panic!("{f:?}") };
        let first = hosts(read(&a, &ex, &cache).unwrap());
        let second = hosts(read(&b, &ex, &cache).unwrap());
        assert_eq!(ex.calls(), [["ssh", "prod-1"]], "two projects on one host share one round trip");
        assert_eq!((first[0].compose.clone(), second[0].compose.clone()), (vec!["api".to_string()], vec!["worker".to_string()]));
        assert_eq!(first[0].disks, second[0].disks);
        let none = read(&repo("[deploy]\ncompose = [\"api\"]\n"), &ex, &cache);
        assert!(matches!(none, Err(Coverage::Unsupported { .. })), "no host in [deploy]");
    }

    /// A commit can move `[deploy] host` under a tick the frontend checked against an older detection.
    #[test]
    fn a_host_this_machine_never_ticked_is_never_connected_to() {
        let cache = Shared::new(KEEP, JOIN, STALL);
        let root = repo("[deploy]\nhost = \"deploy@other-box\"\n");
        let ex = FakeExec::recorded("ssh-host-ubuntu.txt");
        assert!(matches!(read(&root, &ex, &cache), Err(Coverage::NotRun)), "prod-1 is ticked, and this is not prod-1");
        assert!(ex.calls().is_empty(), "{:?}", ex.calls());
        let ctx = Ctx { root: &root, cfg: &MaintConfig::default(), forge: &NONE, account: None, force: true, hosts: &["deploy@other-box".to_string()] };
        assert!(read_with(&ctx, &ex, &cache).is_ok());
        assert_eq!(ex.calls(), [["ssh", "deploy@other-box"]]);
    }

    #[test]
    fn a_failure_is_not_kept_past_its_answer() {
        let cache = Shared::new(KEEP, JOIN, STALL);
        let root = repo("[deploy]\nhost = \"prod-1\"\n");
        let refused = FakeExec::recorded("ssh-host-ubuntu.txt").exiting(255, "deploy@prod-1: Permission denied (publickey).");
        assert!(matches!(read(&root, &refused, &cache), Err(Coverage::NoAccess { .. })), "255 is ssh's own failure");
        let ok = FakeExec::recorded("ssh-host-ubuntu.txt");
        assert!(read(&root, &ok, &cache).is_ok());
        assert_eq!(ok.calls().len(), 1, "the next click asks again rather than reading the refusal back");
        let cut = FakeExec::answering(Ok("@@episko-host 1\n@@now\n1\n")).exiting(0, "");
        let fresh = Shared::new(KEEP, JOIN, STALL);
        assert!(matches!(read(&root, &cut, &fresh), Err(Coverage::Error { ref reason }) if reason.contains("cut off")));
    }

    #[test]
    fn versions_compare_by_their_numbers() {
        assert!(ver_nums("6.8.0-49-generic") > ver_nums("6.8.0-45-generic"));
        assert!(ver_nums("5.14.0-427.18.1.el9_4.x86_64") > ver_nums("5.14.0-427.13.1.el9_4.x86_64"));
        assert!(ver_nums("10.1") > ver_nums("9.9"));
        let (r, why) = parse_reboot(&[], &["6.8.0-45-generic", "6.8.0-45-generic", "6.8.0-49-generic"]);
        assert_eq!((r, why), (Some(true), vec!["kernel 6.8.0-49-generic installed, 6.8.0-45-generic running".to_string()]));
        assert_eq!(parse_reboot(&[], &["6.8.0-49-generic", "6.8.0-49-generic"]).0, Some(false));
        assert_eq!(parse_reboot(&[], &["6.1.0-26-amd64"]).0, None, "no /boot: nothing to compare");
        assert_eq!(parse_reboot(&[], &["6.8.12-4-pve", "6.1.0-26-amd64"]).0, None, "what runs is newer: /boot cannot say");
        assert_eq!(parse_reboot(&[], &["4.15.0-112-generic", "4.15.0-112-generic", "4.15.0-112-generic.efi.signed"]).0, Some(false), "a signed twin is no newer");
        assert_eq!(parse_reboot(&[], &["6.8.0-45-generic", "6.8.0-45-lowlatency"]).0, Some(false), "another flavour of one version");
        assert_eq!(parse_reboot(&["needs-restarting 1"], &[]).0, Some(true));
    }

    #[test]
    fn a_container_row_reads_docker_inspects_template() {
        // Recorded here from Docker Desktop with the script's own template.
        let c = parse_container("/wirksam-e2e-backend-1\twirksam-e2e-backend\trunning\thealthy\t0\t0\t2026-11-03T20:02:26.632370442Z\twirksam-e2e\tbackend").unwrap();
        assert_eq!((c.name.as_str(), c.state.as_str(), c.health.as_deref(), c.service.as_deref()), ("wirksam-e2e-backend-1", "running", Some("healthy"), Some("backend")));
        assert_eq!(c.started_at, Some(1_793_736_146));
        assert_eq!(rfc3339("2026-11-03T21:02:26+01:00"), Some(1_793_736_146));
        assert!(parse_container("a\tb\tc").is_none());
    }

    /// The longest path is dnf's: its listing, its security list and needs-restarting.
    #[test]
    fn the_scripts_worst_case_fits_its_cap() {
        assert!(HOST_SCRIPT.contains("S='timeout 5'; L='timeout 8'"));
        let (mut short, mut long) = (0, 0);
        for l in HOST_SCRIPT.lines().filter(|l| !l.contains("apt-get -s") && !l.contains("apk version")) {
            short += l.matches("$S ").count();
            long += l.matches("$L ").count();
        }
        assert_eq!((short, long), (5, 1), "a limit added or dropped: recount the sum below");
        assert!(10 + short as u64 * 5 + long as u64 * 8 < HOST_SECS, "past the cap every section read so far is lost");
    }

    fn real_sh() -> Option<std::path::PathBuf> {
        let git = std::path::Path::new(r"C:\Program Files\Git\bin\sh.exe");
        crate::maint::exec::resolve_bin("sh", &crate::platform::augmented_path()).or_else(|| git.is_file().then(|| git.to_path_buf()))
    }

    /// The real script through a real sh; `docker` on PATH runs `fake` when one is given.
    fn run_script(sh: &std::path::Path, fake: Option<&str>) -> String {
        let mut path = crate::platform::augmented_path();
        if let Some(body) = fake {
            let dir = scratch_dir();
            let file = dir.join("docker");
            std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            let all = std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&path))).unwrap();
            path = all.to_string_lossy().to_string();
        }
        let mut cmd = crate::platform::sys_command(sh);
        cmd.env("PATH", &path).arg("-s");
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(script().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// Executed: a syntax error in either shell, or a parser that does not read the real local tools,
    /// fails here. Git Bash's sh on Windows, /bin/sh elsewhere.
    #[test]
    fn the_host_script_runs_in_a_real_sh() {
        let Some(sh) = real_sh() else {
            eprintln!("no sh here; skipped");
            return;
        };
        let text = run_script(&sh, None);
        let (h, _, _) = parse_host("local", &text).unwrap_or_else(|e| panic!("{e}\n{text}"));
        assert!(h.now.is_some() && h.uptime.is_some() && h.load.is_some() && h.cpus.is_some(), "{h:?}\n{text}");
        assert!(!h.disks.is_empty(), "{text}");
    }

    const INSPECT: &str = r"printf '/api\tx\trunning\thealthy\t0\t0\t2026-11-03T20:02:26Z\tacme\tapi\n'";

    /// Each of docker's answers, from the script itself rather than from an answer written to suit the parser.
    #[test]
    fn the_script_reports_what_docker_did() {
        let Some(sh) = real_sh() else {
            eprintln!("no sh here; skipped");
            return;
        };
        let read = |fake: &str| { let text = run_script(&sh, Some(fake)); parse_host("local", &text).unwrap_or_else(|e| panic!("{e}\n{text}")) };
        let ps = |ids: &str, inspect: &str| format!("case \"$1\" in ps) {ids};; *) {inspect};; esac");
        let (h, _, _) = read(&ps("echo 0123456789ab", INSPECT));
        assert_eq!(h.containers.unwrap()[0].service.as_deref(), Some("api"));
        let (h, _, _) = read(&ps("echo 'Emulate Docker CLI using podman.' >&2; echo 0123456789ab", INSPECT));
        assert_eq!(h.containers.unwrap().len(), 1, "a warning on stderr is no id");
        let (h, _, gaps) = read(&ps("exit 0", "exit 1"));
        assert_eq!(h.containers, Some(vec![]), "{gaps:?}");
        let (h, _, gaps) = read(&ps("echo 0123456789ab; echo ba9876543210", "exit 1"));
        assert_eq!(h.containers, None);
        assert!(gaps.iter().any(|g| g.contains("0 of 2 containers (exit 1)")), "{gaps:?}");
        let (h, _, gaps) = read("echo 'permission denied on the socket' >&2; exit 1");
        assert_eq!(h.containers, None);
        assert!(gaps.iter().any(|g| g.ends_with(": permission denied on the socket")), "{gaps:?}");
    }

    /// A daemon that hangs costs one limit, and the sections already read survive it.
    #[test]
    fn a_hung_docker_costs_one_limit_and_no_other_section() {
        let Some(sh) = real_sh() else {
            eprintln!("no sh here; skipped");
            return;
        };
        let has_timeout = crate::platform::sys_command(&sh).env("PATH", crate::platform::augmented_path()).args(["-c", "timeout 5 true"])
            .output().is_ok_and(|o| o.status.success());
        if !has_timeout {
            eprintln!("no timeout here, so the script runs docker unguarded; skipped");
            return;
        }
        let started = std::time::Instant::now();
        let text = run_script(&sh, Some("exec sleep 120"));
        assert!(started.elapsed() < Duration::from_secs(HOST_SECS), "{:?}", started.elapsed());
        let (h, _, gaps) = parse_host("local", &text).unwrap_or_else(|e| panic!("{e}\n{text}"));
        assert!(h.containers.is_none() && !h.disks.is_empty(), "{h:?}");
        assert!(gaps.iter().any(|g| g.ends_with(": no answer in time")), "{gaps:?}");
    }
}
