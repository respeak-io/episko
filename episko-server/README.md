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

## Behind Traefik, with or without an auth layer

WebSockets pass through Traefik as they are. Drop the compose file's `ports:` and add labels:

```yaml
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.http.routers.episko.rule=Host(`sync.example.com`)
      - traefik.http.routers.episko.entrypoints=websecure
      - traefik.http.routers.episko.tls.certresolver=le
      - traefik.http.services.episko.loadbalancer.server.port=7878
      - traefik.http.routers.episko.middlewares=episko-auth
      - traefik.http.middlewares.episko-auth.basicauth.users=episko:$$apr1$$...   # htpasswd output, $ doubled
```

In Episko, enter `https://sync.example.com` and, under **Extra headers**,
`Authorization: Basic <base64 of user:password>`. Any middleware that checks a header works the
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
