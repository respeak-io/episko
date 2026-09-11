# macOS permission dialogs (Settings › Privacy)

**Episko gets blamed for what its children read.** macOS keys every TCC prompt to the
*responsible* process, and for anything spawned out of a PTY that is `io.respeak.episko`.
So when an agent's search wanders into `~/Library`, or a tool reads another app's config,
the dialog says *"Episko would like to access data from other apps"* — a permission Episko
itself never asks for and does not use. The system log states the split outright:

```
AttributionChain: responsible={identifier=io.respeak.episko, responsible_path=/Applications/Episko.app/…},
                  accessing={identifier=com.apple.installer, binary_path=/usr/sbin/installer}
```

With an external terminal engine the same access is attributed to Terminal or iTerm
instead. The dialogs do not go away; they change their name.

**They arrive in bursts because the answer is remembered per app that was read**, not per
app that read. One sweep through a home directory with several hundred containers in it
raises one dialog for each container it touches, five or ten in a row.

## What the app may and may not do about it

There is no API to request a TCC grant, no per-directory or per-project grant, and no pane
in System Settings for the app-data ones at all — a grant there is invisible and can only
be reset from the command line. So the tab does the four things that are actually possible:
say what the dialog means, detect the one grant that can be given in advance, point at the
pane that gives it, and undo a denial.

- **The probe is `~/Library/Application Support/com.apple.TCC/TCC.db`** — gated on Full
  Disk Access exactly, refused with `EPERM` rather than a prompt, so checking costs nothing
  and asks nobody. Probing an app-data path to find out would *raise* the dialog we are
  explaining. The attempt is also what lists Episko in that pane; if it is still missing,
  the pane's `+` adds it.
- **`open_privacy_pane` takes a whitelist, never a passthrough** (`privacy_pane_url`). It
  builds a `x-apple.systempreferences:` URL from a settings row, which is the same trust
  story as the permission-mode whitelist in `pty.rs`.
- **`tccutil reset SystemPolicyAppData <id>` needs no privileges** for the user's own store,
  and is the only way back from a mistaken *Don't Allow* — macOS caches that answer for that
  app forever and offers no UI to clear it.
- **Full disk access is offered, never recommended.** It is the only thing that ends the
  prompts, and every agent Episko launches inherits it: the prompts are the guard-rail on a
  fleet of autonomous sessions, and trading it away is the user's call to make with the
  trade-off in front of them. The hint states both halves and stops.

## The scan

`privacy_asks` runs one `log show --last 24h` predicated on `subsystem == "com.apple.TCC"`
and our bundle id. Pushing the id into the predicate rather than filtering afterwards is
what keeps it ~3s instead of a minute.

**One line carries all three facts**, so nothing is paired across lines:

```
Handling access request to kTCCServiceDeveloperTool, from Sub:{io.respeak.episko}Resp:{TCCDProcess:
  identifier=io.respeak.episko, …, binary_path=/usr/sbin/installer}, ReqResult(…)
```

`Resp:` is the *responsible* half and the only one that may be matched: the predicate
matches our id anywhere in the line, including somebody else's `Sub:`, and the
`AttributionChain` line above says the same thing with two more joins to get wrong.

Two honesty limits, both in the copy. The scan lists permission **checks**, not prompts —
most are answered from TCC's cache without asking anyone, and the log does not reliably
separate the two. And the service keeps its raw TCC name in Rust (`SystemPolicyAppData`);
`tccLabel` in ./format spells it for a person and un-camels anything it has not heard of,
because a row whose only fact is *what was checked* must not render blank.

## The tab

macOS only, and **hidden rather than dimmed** elsewhere (`SetTab.when`): nothing on it has
a meaning on an OS with no TCC. The release intro that walks it is a tour chapter with
`only: "mac"`, gated by `setTourPlatform` — ./tour stays platform-free and ./tourui, which
already knows `IS_MAC`, sets it once. Neither reading (the probe, the scan) is stored:
either can be false by the time you look again, and `null` means *not looked yet*, which is
not the same as *no*.
