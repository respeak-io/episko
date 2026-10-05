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
cp .env.example .env     # optional: only if you change a setting
docker compose up -d
```

It binds localhost and does not terminate TLS. For other machines, put
[Tailscale](https://tailscale.com) or [Caddy](https://caddyserver.com) in front. Caddy's
`reverse_proxy 127.0.0.1:7878` gives you `wss://` with nothing else to configure. On a server you
deploy from a git checkout, check out a release tag rather than `dev` (see *Update it*).

## Configure it

Every setting is an environment variable, every one is optional, and each default is what the
server does without it. [`.env.example`](.env.example) lists them all with what they do;
`episko-server --help` prints the same list. Under Docker, put yours in `.env` beside the compose
file, which passes it to the container:

| Variable | Default | |
| --- | --- | --- |
| `EPISKO_REGISTER_CODE` | off | lets people pair with this code and their own name; 12+ characters |
| `EPISKO_RETENTION_DAYS` | `30` | how long superseded events are kept; the latest per key always stays |
| `EPISKO_DB` | `episko.db` | the database file (`/data/episko.db` in the Docker image) |
| `EPISKO_BIND` | `127.0.0.1:7878` | where to listen (`0.0.0.0:7878` in the Docker image) |

**Don't edit the tracked files on a server.** `.env` and `docker-compose.override.yml` are
ignored by git, so settings and proxy wiring live there and an update never merges over them.
A release never adds a variable you must set to keep working; `./update.sh` lists the new ones.

## Behind Traefik, with or without an auth layer

WebSockets pass through Traefik as they are. Put the wiring in `docker-compose.override.yml`
beside the compose file; Compose merges it in on every command, no flag needed. Declare the
network here too, because `external: true` in Traefik's compose file does not carry over to this
one:

```yaml
services:
  episko-server:
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.episko.rule=Host(`sync.example.com`)
      - traefik.http.routers.episko.entrypoints=websecure
      - traefik.http.routers.episko.tls.certresolver=le   # your resolver's name
      - traefik.http.services.episko.loadbalancer.server.port=7878
      - traefik.http.routers.episko.middlewares=episko-auth
      - traefik.http.middlewares.episko-auth.basicauth.users=episko:$$2y$$05$$...   # htpasswd -nB, $ doubled

networks:
  traefik:
    external: true
```

`docker compose config` shows the merged result (it prints `$` doubled again, which is fine).
The localhost `ports:` from the base file stays; Traefik does not need it, and it leaves the
server reachable from the host itself.

Match `entrypoints` and `certresolver` to the names in Traefik's own `command:`
(`--entryPoints.<name>.address`, `--certificatesresolvers.<name>.acme…`). A wrong resolver name
fails quietly: the router is served with Traefik's default certificate. The image already listens
on `0.0.0.0:7878`, so nothing else is needed for Traefik to reach it.

In Episko, enter `https://sync.example.com` and, under **Extra headers**,
`Authorization: Basic <base64>`, where the base64 is of the **plaintext** `user:password`, not
of the hash in the label:

```sh
printf 'episko:your-password' | base64
```

With the hostname proxied through Cloudflare (orange cloud), set SSL/TLS to *Full* or *Full
(strict)*, since Traefik only answers on 443. Any middleware that checks a header works the
same way, including ForwardAuth that reads a static token. A middleware that redirects to a login page
(Authelia, Authentik, oauth2-proxy in browser mode) does **not**, because nothing follows the
redirect. Give those a bypass rule or a service token instead.

## Behind Cloudflare Access

Create a **service token** in Zero Trust › Access › Service credentials, and add a *Service
Auth* policy for it to the application in front of the server. In Episko, under **Extra
headers**, enter:

```
CF-Access-Client-Id: <id>.access
CF-Access-Client-Secret: <secret>
```

Cloudflare carries WebSockets. The server pings every 30 seconds, well inside Cloudflare's
100-second idle limit. The headers are sealed with the sync token (DPAPI on Windows, the
Keychain on macOS) and are never shown again. To rotate them, use *Replace the extra headers* in
Settings › Sync. A proxy that refuses the connection is named as such in the panel and on the
red badge, instead of appearing as a server fault.

## Pair a machine

```sh
episko-server invite ana        # prints EPSK-XXXX-XXXX for one of ana's machines: once, ten minutes
episko-server devices           # every paired device, and whose it is
episko-server revoke <device>   # shut one out; the app asks it to pair again
episko-server rename me ana     # rename a person; their settings and spend follow
```

Under Docker, run them inside the running container, from this folder:

```sh
docker compose exec episko-server episko-server invite ana
```

Use `exec`, not `docker compose run`, which would start a second server on the same database.

In Episko, open **Settings › Sync** and enter the server's address, the code and a name for the
machine. With `EPISKO_REGISTER_CODE` set, a teammate enters the team code and their own name
instead, and nobody has to mint an invite; their next machine joins through *Add a machine*. A
device paired before names existed belongs to `me`; `rename me <name>` gives it yours.

## Back it up

```sh
cp episko.db episko.db.bak       # Docker: data/, with the container stopped
```

The copy holds only hashes of the tokens, so it cannot be used to impersonate a device.

## Update it

Under Docker, from this folder:

```sh
./update.sh            # the newest release tag
./update.sh v0.33.0    # or a given one
```

It refuses to run over edited tracked files, then shows the server commits between the two
versions and any setting the release added. It builds the new image while the old server keeps
running, stops it, copies `data/` to `data.bak-<old version>` (the last three are kept) and
starts the new one. If the server does not come back, it prints the logs and how to go back.
The release notes are the app's [CHANGELOG](../CHANGELOG.md); the server ships with the app's
version numbers.

## What it never holds

It holds no transcripts, prompts, tool output, diffs, file contents or session titles, and no
repository access. Permission modes, trusted projects, task definitions and branch protection
never reach it either, because they change what runs or what is permitted.
