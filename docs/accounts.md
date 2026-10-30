# Claude accounts

> Rules and their reasons, compressed. Trust the code over the docs when they disagree, and fix the doc in the same commit.

Someone with two subscriptions used to switch between them with `/login`, which moves every running session at once and rewrites `~/.claude.json`. Settings › Accounts lists setup-token accounts in priority order instead, and each new embedded Claude session starts on the first one that is switched on and not full. A session keeps its account for life.

## Shape

- **A token per account, handed to one process.** `claude setup-token` mints a long-lived OAuth token for the subscription the browser is signed in to. `spawn_claude` sets it as `CLAUDE_CODE_OAUTH_TOKEN` in that pane's environment and removes `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, which would outrank it. Nothing in `~/.claude` changes, so transcripts, History, memory and the usage scan stay one tree, and `--resume` works across accounts. `CLAUDE_CONFIG_DIR` would also separate logins, but it splits all of that too.
- **The token never reaches the webview.** `accounts.rs` stores, lists, checks and forgets; `spawn_claude` reads it by label. The frontend holds labels and their order (`cc-claude-accounts`, local: the tokens are this machine's). Storage is `platform::seal_secret`, the one sync's token uses: a login-keychain item under service `episko-claude-token` with the label as its account, DPAPI on Windows, a 0600 file elsewhere. Because the service is fixed, an item added by hand with `security add-generic-password -s episko-claude-token -a <label> -w` shows up under *In your keychain*.
- **Embedded panes only.** An external terminal gets a command line, and a token in it would land in that terminal's scrollback and shell history. Those launches use the login, and the panel says so.
- **Adding one never involves a copy.** `setup-token` prints the token across two lines in a normal-width terminal, and the first hand copy came out at 72 of its 108 characters (a 401 on every call). *Sign in* prefills `claude setup-token` in a shell (prefilled, not entered: CLAUDE.md's two-places rule), reads the token back off the pane (`tokenFromLines`: xterm's soft wraps joined, a hard wrap continued while the next line is all token characters), stores it and closes the shell so it is not left on screen. A pasted token has its whitespace removed, and `accounts.rs` refuses one shorter than 100 characters by name.

## What Episko can know about a token

Measured on CLI 2.1.312, 2026-10-28. A setup token is narrower than a login:

- **`claude auth status`** says `oauth_token` and nothing else: no email, no plan. An account is its label.
- **The usage probe** (`get_usage`, ./rlprobe) answers `rate_limits_available: false`. So there is no free check, and a model's own weekly window (Fable's) is visible only for the login.
- **A turn's own figures do arrive.** The statusLine carries `rate_limits` for the token's account, and `claude -p --output-format stream-json` emits a `rate_limit_event` with both windows (`utilization` is a fraction). The *Check* button is that: one Haiku turn of a few words with `--no-session-persistence`, which proves the token and gives the account its first reading.

## Rules

- **Readings are filed by the pane's account, never by the payload's.** `episko_account` names the login (`usage::current_account`), which a token pane does not use, so `applyStatusline` reads `Sess.account` first and files the reading under `tok:<label>` (`applyAccountReadings`). The `/login` guard (`acctSince`) only applies to panes that follow the login.
- **The meters show the account a new session would take.** `syncShownAccount` runs after every statusLine and every list change: the pick if there is one, else the login. Swapping goes through `showAccount` (the swap #229 added), so a change of account never reads as a window closing. `noteAccount` records a `/login` but leaves a token account on show alone.
- **Full is 99%, or a refused turn.** A session started at 99% gets one turn at best. A `StopFailure` of kind `rate_limit` marks its account in `limitHits` until its 5h reset (an hour if unknown), because the window that refused it may be one no reading shows (Fable's weekly). `rate_limit` also names a passing 429, so that hold applies only when the message gives a reset or a window was already at 90% (`quotaHit`); otherwise it is fifteen minutes. A revive retry refused again offers nothing a second time.
- **A pick never lands on an account that cannot launch.** One whose token is missing from the last listing (made at startup and on every Settings open) or whose last *Check* failed is skipped and tagged in the panel, rather than failing every launch until someone switches it off.
- **Token readings stay on this machine.** A label is local, so another machine's `max20` may be a different subscription: sync sends no `rl` while a token account is on show and drops a peer's `tok:` reading.
- **When every account is full, the login is the fallback.** It is not an entry in the list; someone who wants it first adds that account as a token too.
- **A refused session is offered the next account, never moved.** `onLimitHit` shows an action toast; *Resume on …* stops the pane, then `launch({resume, account})` in the same checkout, the drift-move path. Nothing is typed into the session, and the prompt cache does not survive: the first turn on the new account reads the whole context again.
- **Terms.** Holding several subscriptions is allowed and sharing one is not (Consumer Terms §2). Choosing between your own at launch is ordinary use; quietly hopping accounts mid-session to dodge a limit would read as bypassing a protective measure (§3), which is why nothing here moves a running session by itself.
