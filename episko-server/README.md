# episko-server

The self-hosted sync server for [Episko](../README.md): one binary, one SQLite file. Your
preferences, spend and limits follow you between machines. A team's shared notes, presence
and claims stop making a round trip through git.

The server is **an accelerator, never an authority**. Every Episko feature works with it
down or absent, and a solo user never needs one. The design is in [docs/sync.md](../docs/sync.md).

## Run it

```sh
cargo build --release
EPISKO_DB=/srv/episko.db ./target/release/episko-server          # ws://127.0.0.1:7878/
```

Or with Docker, from this folder:

```sh
docker compose up -d
```

It binds localhost and does not terminate TLS. For other machines, put
[Tailscale](https://tailscale.com) or [Caddy](https://caddyserver.com) in front. Caddy's
`reverse_proxy 127.0.0.1:7878` gives you `wss://` with nothing else to configure.

| Variable | Default | |
| --- | --- | --- |
| `EPISKO_DB` | `episko.db` | the database file |
| `EPISKO_BIND` | `127.0.0.1:7878` | where to listen |
| `EPISKO_RETENTION_DAYS` | `30` | how long superseded events are kept; the latest per key always stays |

## Pair a machine

```sh
episko-server invite            # prints EPSK-XXXX-XXXX, good once, for ten minutes
episko-server invite --user ana # a teammate: their prefs and spend stay theirs
```

In Episko, open **Settings › Sync** and enter the server's address, the code and a name for the
machine.

```sh
episko-server devices           # every paired device
episko-server revoke <device>   # shut one out; the app asks it to pair again
```

## Back it up

```sh
cp episko.db episko.db.bak
```

The copy holds only hashes of the tokens, so it cannot be used to impersonate a device.

## What it never holds

It holds no transcripts, prompts, tool output, diffs, file contents or session titles, and no
repository access. Permission modes, trusted projects, task definitions and branch protection
never reach it either, because they change what runs or what is permitted.
