// OS-shaped leaves every other module calls.
//
// Two hard constraints from CLAUDE.md live here: a GUI app (and a Claude hook)
// runs with a stripped PATH, so `resolve_claude` probes known install locations
// and `augmented_path` rebuilds a usable PATH; and a GUI app spawning a console
// subprocess flashes a window on Windows unless it goes through `sys_command`.
// `norm_path` is the third: one folder has several spellings on Windows and the
// frontend merges projects by exact string equality.
//
// Nothing here touches `portable_pty` or `AppState` — that is the boundary. A
// cfg-gated OS helper with one consumer belongs to *that* module instead:
// `apply_utf8_locale`, `interactive_shell` and `task_shell` stayed with the PTY
// spawners, `same_path` with git.

/// User's home directory — `USERPROFILE` on Windows, `HOME` elsewhere.
pub(crate) fn home_dir() -> String {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").unwrap_or_default()
    }
}

/// Canonical spelling for an absolute path the frontend will compare as a string.
/// The sidebar merges projects/worktrees by exact string equality (`byPath` in
/// projectList), but on Windows the same folder arrives in several spellings:
/// git prints forward slashes (`E:/repo`), the folder dialog native backslashes
/// (`E:\repo`), and VS Code-hosted claude sessions register a lowercase drive
/// letter (`e:\repo`) — so the same repo splits into duplicate sidebar groups.
/// Every command that hands a path to the frontend funnels it through here;
/// on other platforms it's the identity.
pub(crate) fn norm_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let mut s = p.replace('/', "\\");
        if s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_lowercase() {
            s[..1].make_ascii_uppercase();
        }
        s
    }
    #[cfg(not(windows))]
    {
        p.to_string()
    }
}

/// A `std::process::Command` that never flashes a console window on Windows. A GUI
/// app spawning a console subprocess (git, where, curl, taskkill) pops a black
/// window for each call without `CREATE_NO_WINDOW`; on other platforms this is a
/// plain `Command::new`.
pub(crate) fn sys_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let c = std::process::Command::new(program);
    #[cfg(windows)]
    let mut c = c;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Resolve the absolute path to the `claude` binary. GUI apps get a stripped PATH
/// (Finder on macOS, no inherited shell env on Windows), so we check common install
/// locations first and fall back to a `which`/`where` probe.
#[cfg(not(windows))]
pub(crate) fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(o) = sys_command(&shell).args(["-lic", "command -v claude"]).output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "claude".to_string()
}

/// Windows: prefer the native installer's `claude.exe` (spawnable directly via
/// CreateProcess, unlike the npm `.cmd` shim which needs a shell), then `where`.
#[cfg(windows)]
pub(crate) fn resolve_claude() -> String {
    let home = home_dir();
    let candidates = [
        format!(r"{home}\.local\bin\claude.exe"),
        format!(r"{home}\.claude\local\claude.exe"),
        format!(r"{home}\AppData\Local\Programs\claude\claude.exe"),
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    // `where` may print several lines (claude.exe + claude.cmd); prefer a .exe.
    if let Ok(o) = sys_command("where").arg("claude").output() {
        let text = String::from_utf8_lossy(&o.stdout);
        let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if let Some(exe) = lines.iter().find(|l| l.to_lowercase().ends_with(".exe")) {
            return exe.to_string();
        }
        if let Some(first) = lines.first() {
            return first.to_string();
        }
    }
    "claude".to_string()
}

/// A PATH that includes the usual per-user bin dirs, so the spawned `claude`
/// (and anything it shells out to) is found even under a stripped PATH.
#[cfg(not(windows))]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:{home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}")
}

/// Windows uses `;` as the PATH separator; include the native-installer bin dir and
/// System32 (where `curl.exe` lives), then whatever we inherited.
#[cfg(windows)]
pub(crate) fn augmented_path() -> String {
    let home = home_dir();
    let base = std::env::var("PATH").unwrap_or_default();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    format!(r"{home}\.local\bin;{home}\.claude\local;{sysroot}\System32;{base}")
}

/// Single-quote a string for safe inclusion in a POSIX shell script.
#[cfg(not(windows))]
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// One `ps -o <fields>=` line for a single pid (trimmed), or None if the process
/// is gone / no output. Windows has no `ps`; the remaining `ps` consumers
/// (per-session CPU/RAM, terminal-window focus) are macOS-only for now, so this
/// is None there. External-session listing does NOT go through here — it uses
/// the cross-platform `ProcTable` (in `lib.rs`, and `external.rs` once split).
#[cfg(windows)]
pub(crate) fn ps_one(_pid: u32, _fields: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub(crate) fn ps_one(pid: u32, fields: &str) -> Option<String> {
    let out = sys_command("ps")
        .args(["-p", &pid.to_string(), "-o", fields])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All three real-world spellings of one Windows folder (git's forward
    /// slashes, the dialog's native path, VS Code's lowercase drive) must
    /// collapse to a single string, or the sidebar splits the project.
    #[cfg(windows)]
    #[test]
    fn norm_path_unifies_windows_spellings() {
        assert_eq!(norm_path("E:/Programming/Work/repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"e:\Programming\Work\repo"), r"E:\Programming\Work\repo");
        assert_eq!(norm_path(r"E:\already\native"), r"E:\already\native");
        assert_eq!(norm_path(r"\\server\share\x"), r"\\server\share\x");
        assert_eq!(norm_path(""), "");
    }

    #[cfg(not(windows))]
    #[test]
    fn norm_path_is_identity_off_windows() {
        assert_eq!(norm_path("/Users/tim/dev/episko"), "/Users/tim/dev/episko");
        assert_eq!(norm_path("a\\b"), "a\\b"); // a backslash is a legal filename char here
    }

    /// The external-terminal engines hand `open -a` a generated `.command` *script*,
    /// so a workdir or title containing a quote must not be able to close the quoting
    /// and run as its own command.
    #[cfg(not(windows))]
    #[test]
    fn sh_quote_neutralises_embedded_quotes() {
        assert_eq!(sh_quote("/Users/tim/dev/episko"), "'/Users/tim/dev/episko'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("a'; rm -rf /; echo '"), r"'a'\''; rm -rf /; echo '\'''");
    }
}
