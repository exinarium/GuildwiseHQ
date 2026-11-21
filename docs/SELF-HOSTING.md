# Self-hosting Guildwise HQ

Guildwise HQ lets you run an organization of AI agents (set up for software delivery by default). This guide covers running your own Guildwise HQ server: installation, configuration, the platform account, connecting workstations, upgrades, backups and troubleshooting. For the quick path, see the [README](../README.md#self-host-in-10-minutes).

Every feature is included in a self-hosted install, and organizations are unlimited: there are no plans, trials, sign-up pages or limits on your own server. The platform administrator invites organizations directly.

Contents:

1. [Architecture](#1-architecture)
2. [Requirements](#2-requirements)
3. [Install](#3-install)
4. [Configuration reference](#4-configuration-reference)
5. [The platform account and organizations](#5-the-platform-account-and-organizations)
6. [Workstations (runners)](#6-workstations-runners)
7. [HTTPS and domains](#7-https-and-domains)
8. [Upgrades](#8-upgrades)
9. [Backups and restore](#9-backups-and-restore)
10. [Optional features](#10-optional-features)
11. [Operations](#11-operations)
12. [Troubleshooting](#12-troubleshooting)
13. [Security settings and signed runners](#13-security-settings-and-signed-runners)
14. [Hardening the host](#14-hardening-the-host)

---

## 1. Architecture

```
VPS (docker-compose.prod.yml)
  caddy     :80/:443  TLS (Let's Encrypt or internal CA), reverse proxy, WebSocket
  app       :4600     Fastify API, web app, dispatcher, scheduler, runner gateway
  media     internal  help videos (static)
  postgres  internal  event log and projections (Postgres 18)

Workstations
  aom-runner          connects out over wss; runs agents in sandboxed git worktrees
```

Only Caddy is published. Postgres and the app listen only inside the Docker network. Workstations connect outward to your domain, so they need no inbound port.

Files in the repository:

| File | Purpose |
| --- | --- |
| `docker-compose.prod.yml` | The production stack |
| `.env.prod.example` | Commented environment template, copied to `.env` |
| `deploy/Caddyfile` | Caddy configuration |
| `Dockerfile` | The application image |
| `media/` | Help videos and their image |

## 2. Requirements

**Server**

- A Linux server with a public address. We recommend 2 vCPUs, 4 GB of RAM and 20 GB of disk. The image build needs the most memory; a running server is light.
- Docker Engine with the Compose v2 plugin (`docker compose version`).
- A domain name with an `A` record pointing at the server (for HTTPS with a public certificate).
- Inbound ports 80 and 443. Port 22 for your own SSH access.
- Outbound HTTPS to `api.anthropic.com` only if you enable the optional Anthropic features (section 10).
- An SMTP relay for invitation and notification mail.

**Workstations**

- Node.js 22.23, Git 2.40 or later. The guided installer sets these up on Linux, macOS and WSL2.
- A Claude sign-in: a Claude subscription (`claude`) or an Anthropic API key.
- On Windows, run the runner inside WSL2. Native Windows is supported only as an explicit, unsandboxed opt-in (see [RUNNER.md](RUNNER.md) "Native Windows").
- More about workstations: [RUNNER.md](RUNNER.md) and [BYO-VPS.md](BYO-VPS.md) (a rented server over SSH).

## 3. Install

```bash
git clone https://github.com/exinarium/GuildwiseHQ.git
cd GuildwiseHQ
cp .env.prod.example .env
# edit .env (section 4), then:
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl https://guildwise.example.com/api/health    # {"ok":true,"db":true}
```

On first start the app applies all database migrations (`AOM_MIGRATE_ON_BOOT=true`). Follow progress with `docker compose -f docker-compose.prod.yml logs -f app`.

## 4. Configuration reference

Put these in `.env` next to `docker-compose.prod.yml`. Compose reads that file automatically.

### Required

| Variable | Example | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | output of `openssl rand -hex 32` | Password of the `aom` database user. Compose refuses to start without it. |
| `AOM_DOMAIN` | `guildwise.example.com` | Public name. Caddy uses it for the certificate. Unset means `localhost`. |
| `AOM_PUBLIC_ORIGIN` | `https://guildwise.example.com` | The address users open. Sets the CSRF origin, the cookie `Secure` flag and the links in invitations. Must match exactly, including the port when it is not 443. |
| `AOM_SMTP_URL` | `smtp://user:password@smtp.example.com:587` | Relay for mail. Percent-encode special characters in the password. |
| `AOM_SECRET_KEY` | output of `openssl rand -hex 32` | Encrypts stored social and GitHub tokens (and the two-factor seeds when `AOM_TWO_FACTOR_KEY` is unset). At least 16 characters. The server refuses to start in production without it. Keep it with your backups. |

### Recommended

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_MAIL_FROM` | `Guildwise HQ <noreply@aom.local>` | From address. Quote it if it has spaces: `"Guildwise HQ <noreply@example.com>"`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `AOM_HTTP_PORT`, `AOM_HTTPS_PORT` | `80`, `443` | Change only if another service uses those ports. |
| `AOM_TWO_FACTOR_KEY` | unset | Encrypts the two-factor seeds with a key of their own (AES-256-GCM). At least 32 characters (`openssl rand -hex 32`), never the same value as `AOM_SECRET_KEY` (the server refuses to start if it is). Unset: a key derived from `AOM_SECRET_KEY`, with a warning at startup in production. Setting it later locks nobody out: seeds are re-sealed under the new key when they are read. Keep it with your backups. |

### Security

All optional. The defaults below are what a server without the variable does.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_REQUIRE_SIGNED_RUNNERS` | `false` | Default of the **Only signed runners** setting (section 13). The value saved under Platform > Security wins. |
| `AOM_ENFORCE_TWO_FACTOR` | `false` | Default of the **Require two-factor login** setting (section 13). The value saved under Platform > Security wins. |
| `AOM_RUNNER_RELEASE_PUBKEY` | unset | Your own minisign public key (the `RW...` line, or the whole `.pub` text). The server then trusts runners signed with that key instead of the official key. Also a build argument (section 13). |
| `AOM_LOGIN_LOCKOUT` | `true` | Sign-in lockout: after 5 failed sign-ins an address pauses for 15 minutes (doubling up to 60); 20 failures from one IP in 15 minutes lock that IP for 15 minutes. A browser that signed in to the account in the last 30 days still gets in, a completed password reset clears the lock, and private and proxy addresses are never IP-locked. |
| `AOM_SIGNIN_NOTICES` | `all` | Who gets a mail on a sign-in from a new device: `all`, `super_admin` or `off`. |
| `AOM_INVITE_PER_ORG_HOUR`, `AOM_INVITE_PER_ACTOR_DAY`, `AOM_INVITE_PENDING_MAX` | `20`, `50`, `50` | Invitation limits: per organization per hour, per inviter per day, pending per organization. |
| `AOM_STEP_UP_WINDOW_SEC` | `600` | How long a "Confirm it's you" answer counts as fresh. At most 600 in production (the server refuses to start above it). |
| `AOM_SUPER_ADMIN_IDLE_SEC` | `1800` | Idle limit of a platform (super-admin) session; the absolute limit is 8 hours. At most 1800 in production. |
| `AOM_PLATFORM_TEAM_ORG_ID`, `AOM_PLATFORM_TEAM_PROJECT_ID` | unset | The platform team's organization and project ("Guildwise repairs itself"). Set both, then restart. The platform account can no longer choose them in the app. |

### Advanced

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_MIGRATE_ON_BOOT` | `true` | Apply migrations on start. |
| `AOM_EXTRA_ORIGINS` | unset | Extra exact origins the web app may be opened from (comma-separated, never `*`). |
| `AOM_RATE_LIMIT` | `true` | Request rate limiting. |
| `AOM_TRUST_PROXY` | loopback only (the Compose file sets `loopback,uniquelocal`) | Which proxies may set `X-Forwarded-For`, and so the client address every per-address limit uses. See [Running behind a reverse proxy](#running-behind-a-reverse-proxy). |
| `AOM_MAX_SHIFTS_PER_WORKSTATION` | `16` | Platform ceiling on shifts per workstation (`0` means no ceiling). |
| `AOM_DATA_MIGRATIONS` | on | Set to `false` to skip data migrations on boot. |

Set these only for development or tests, never in production: `AOM_TEST_CLOCK`, `AOM_MOCK_UI`, `AOM_ALLOW_LOCAL_REMOTES`, `AOM_NO_LEAN_TEAM` (does not register the lean team workflow, code v6).

## 5. The platform account and organizations

The **platform account** runs the service. It manages organizations, invitations, accounts and the audit log. It belongs to no organization and cannot see anyone's work.

### Create it

```bash
read -rs PW; printf %s "$PW" | docker compose -f docker-compose.prod.yml exec -T app node dist/superadmin-create.mjs \
  --email platform@example.com \
  --name "Platform" \
  --password-stdin
```

Sign in with it. Two-factor login is set up at the first sign-in. Keep the recovery codes. `--password-stdin` keeps the password out of the shell history and the process list; `admin-create` and `superadmin-reset-password` take it too (with `--email`, and `--name` for the create commands). `--password` still works and prints a warning.

What the platform account can do: organizations' details, plan, limits and dates, suspend, reactivate and cancel, invitations, deactivating accounts, password-reset mails, the audit log, the runner update kill switch, the blog, videos and settings. It has no way into an organization's projects, cards, workstations, secrets, vaults or runner commands. Every change it makes asks for a fresh two-factor code ("Confirm it's you"), its sessions last at most 8 hours (30 minutes idle), and a platform session that no real sign-in created is refused and reported by mail.

### Reset it

```bash
docker compose -f docker-compose.prod.yml exec app node dist/superadmin-reset-password.mjs \
  --email platform@example.com [--reset-two-factor]
```

`--reset-two-factor` also clears two-factor login, so it is set up again at the next sign-in. The console is the only way to reset the platform account's two-factor login. It cannot reset anyone else's: other users who lose their authenticator and recovery codes use **Lost your authenticator and your recovery codes?** on the sign-in page (a mailed link, then a 24-hour wait before two-factor login is removed). Either reset clears a sign-in lock on the account.

### Invite the first organization

Sign in as the platform account and open **Platform > Invitations**. Invite the owner. The owner accepts the invitation, creates the organization and becomes its Owner.

Alternatively, create a user and an organization in one step:

```bash
docker compose -f docker-compose.prod.yml exec app node dist/admin-create.mjs \
  --email you@example.com --name "You" --password 'use-a-long-passphrase' \
  --org "Your organization"
```

Use a different email from the platform account.

### Adding organizations

There is no self-service sign-up on a self-hosted install. Invitations (or `admin-create`) are how organizations and people are added, and every organization is unlimited.

## 6. Workstations (runners)

Agents run on workstations, not on the server. A workstation runs the **runner**, `guildwise-runner`, which connects out to the server.

### Install with the guided installer (recommended)

Sign in as an Owner or Admin and open **Workstations > Add a workstation**. Copy the one-line command for your system and run it on the workstation:

```bash
curl -fsSL 'https://guildwise.example.com/install/<short-lived-token>/install.sh' | bash
```

- Linux and WSL2 use `install.sh`. macOS uses `install-mac.sh`. Windows uses `install.ps1` in PowerShell.
- The link works for 30 minutes. It embeds a single-use pairing code, not a long-lived secret.
- The installer starts by **looking for an older runner** on the machine. It stops it and moves its files into one archive under `~/.guildwise-quarantine/<time>/` (readable by you only, with a `MANIFEST.txt`), or removes them with `--legacy remove`. Nothing from the old install is reused: no token, key, sealed sudo password, policy or clone. Delete the quarantine after you have looked at it. If you gave the old runner sudo, change that user's password.
- Then it installs the runner and runs **Setting local permissions** (`guildwise-runner setup`): the user the runner runs as (a dedicated `guildwise-runner` user on Linux and macOS, a separate WSL distro on Windows, or your own user), which organizations the DevOps engineer may serve (each defaults to no), Docker for the runner (its own rootless daemon by default; the installed daemon only after you type the root-equivalent acceptance; a shared rootless daemon of another user after you type its acceptance), and the deploy approval defaults. The runner never gets sudo: the installer asks for administrator rights once and installs a baseline of packages in that one go (`--skip-baseline` if you manage packages yourself); the DevOps engineer installs stack tools only in the runner's home, checksum-checked, and system packages are yours to install. Root steps go through the root-owned `/usr/local/lib/guildwise/guildwise-admin`, which the runner cannot change. Scripted installs answer with flags; the answers never come from the server. Re-run `guildwise-runner setup` at any time to change them. [docs/RUNNER.md](RUNNER.md) lists the flags.
- The installer script itself is served by your server. If you do not want to trust that, download the runner package, check it against the signed `manifest.json`, and install it with `--from-file`.
- The macOS dedicated user and the Windows WSL distro are not yet tested on real hardware.

The installer installs git, bubblewrap and socat (Linux), Node 22 and Claude Code, asks which folders hold your code, runs `guildwise-runner repos add` for each, walks you through the Claude sign-in, and installs the service (`guildwise-runner` on systemd, a launchd service on macOS).

### Two runners on one machine (UAT and production)

A test machine can serve a UAT server and production with two fully separate runners: run each server's installer with its own `--instance` name, for example `... | bash -s -- --instance uat --ca-file ~/uat-ca.pem` from the UAT server and `... | bash -s -- --instance prod` from production. Each gets its own user (`guildwise-runner-uat`, `guildwise-runner-prod`), service, data, policy, clones, CA copy and rootless Docker daemon, and neither can read the other's. This isolation is between the runners as unprivileged users only. Whoever holds either server's release signing key is effectively root on the machine, because each instance's install runs as root, so treat the UAT key as production-grade. `--docker host` for either runner makes it root-equivalent and breaks the isolation; the default `rootless` gives each runner its own daemon. Both may use one shared rootless daemon instead (`--docker shared`, with the typed acceptance at each install): runners that share a daemon can each control the other's containers. [docs/RUNNER.md](RUNNER.md) ("Two runners on one machine") has the details.

### Pair by hand

1. In the app, open **Workstations > Pair with a code** and copy the one-time code. It is valid for 10 minutes and for one pairing attempt.
2. On the workstation:

   ```bash
   guildwise-runner pair --server https://guildwise.example.com --code XXXX-XXXX --name "Desktop"
   guildwise-runner repos add ~/src ~/work
   guildwise-runner start
   ```

### Unattended pairing (scripts, cloud-init)

```bash
GUILDWISE_SERVER=https://guildwise.example.com GUILDWISE_PAIR_CODE=XXXX-XXXX GUILDWISE_NAME="Build server" guildwise-runner up
```

`guildwise-runner up` is safe to run at every boot. If the machine is already paired with that server, it just connects.

### Claude sign-in on the workstation

```bash
claude                                                  # subscription login, follow the prompts
# or, with an API key kept in the runner's config (mode 0600):
read -rs K; printf %s "$K" | guildwise-runner auth api-key
systemctl --user restart aom-runner
```

A subscription login is meant for one person's use. Parallel agents can hit its usage limits, so a team should use an API key.

### Run as a service

- Linux: systemd user unit `aom-runner`. Enable lingering (`loginctl enable-linger $USER`) so it survives logout.
- macOS: launchd agent `com.guildwisehq.runner`.
- Otherwise: `guildwise-runner start` in a terminal or your own service manager.
- The runner log is `~/.aom-runner/logs/runner.log` (the data directory is `~/.aom-runner`, or `AOM_RUNNER_HOME`). On Linux the journal also has it: `journalctl --user -u aom-runner`.

### Check a workstation

```bash
guildwise-runner status      # config summary, connection state, active shifts
guildwise-runner doctor      # Node, Git, Claude CLI, Docker, server reachability
guildwise-runner pairings    # one line per pairing
```

Exit codes of `guildwise-runner start`: `0` stopped by a signal, or refused by a server with "Only signed runners" on (reinstall, section 13); `2` the server rejected the token (pair again); `3` another runner is already connected to the same workstation; `78` the runner refused to start because its user can act as root (root, passwordless sudo, the docker group, a writable socket of another Docker daemon) or its files are writable by others. Fix the user (or run `guildwise-runner setup` and accept the risk with a typed confirmation); the service does not restart on `78`.

### Local approvals

The runner decides on the machine what it does. New deploy scripts, recipe changes, vault set-up, secret reseals, release signing and every DevOps task that was not started on the machine wait for `guildwise-runner approve <id>` there (`guildwise-runner pending` lists them). An unchanged redeploy runs by itself; pin it to a commit with `guildwise-runner deploy pin-commit` if pushes to the deployed branch should not reach production unattended. Two routine kinds (a redeploy at a new commit, a recipe change) can also be approved in the browser with a passkey that the workstation trusts (`guildwise-runner passkey trust`). Details: [docs/RUNNER.md](RUNNER.md).

## 7. HTTPS and domains

- With `AOM_DOMAIN` set to a public name, Caddy obtains and renews a Let's Encrypt certificate automatically. Ports 80 and 443 must be reachable from the internet.
- With `AOM_DOMAIN=localhost` (the default), or an IP address, Caddy uses its internal CA. Trust the root certificate on your devices:

  ```bash
  docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt .
  ```

  On Linux, copy it to `/etc/ca-certificates/extra/` and run `update-ca-certificates`. On macOS, open it and add it to the Keychain. On Windows, install it into the trusted root store.

  The workstation runner is a Node program and does not use the system store. Point it at the file with `NODE_EXTRA_CA_CERTS`: for pairing, `NODE_EXTRA_CA_CERTS=/path/to/root.crt guildwise-runner pair ...`; for the installed service, a systemd drop-in (`systemctl --user edit aom-runner`) with `Environment=NODE_EXTRA_CA_CERTS=/path/to/root.crt`. Without it the runner cannot connect or update itself.
- The bundled Caddy configuration sends HSTS for every host except `localhost`.
- If you put your own reverse proxy in front, keep the `Host` header, pass WebSocket upgrades (`/api/ws`, `/api/runner/ws`), and do not strip the security headers. `/sw.js` must not be cached.
- To open the app from a second address (for example a LAN IP), list it in `AOM_EXTRA_ORIGINS`, then restart. Only list origins you control.

Local test with Caddy's internal CA, for example on a laptop:

```dotenv
AOM_DOMAIN=localhost
AOM_PUBLIC_ORIGIN=https://localhost:9443
AOM_HTTPS_PORT=9443
AOM_HTTP_PORT=9080
```

### Proxy logs and body limits

The bundled Caddy configuration (`deploy/Caddyfile`) does two things for the public, unauthenticated routes.

**Log redaction.** Caddy logs handler errors (a `502` while the app restarts, a `413`, a client abort) with the request address and headers, even without an access log. Every Caddy log line goes through one global filter that:

- deletes the headers `X-Form-Link`, `X-Upload-Token`, `X-File-Name`, `X-Guildwise-Signature`, `X-Hub-Signature-256`, `X-Signature`, `X-Goog-Channel-Token`, `Idempotency-Key`, `X-Guildwise-Delivery`, `Cookie`, `Authorization`, `Proxy-Authorization` and the response `Set-Cookie`;
- replaces with `[redacted]` the secret part of the address: everything after `/relay/in/` and `/hooks/in/` (query included), the hook secret in `/api/hooks/<id>/<secret>` (the id stays visible), the id after `/f/` and `/api/public/forms/`, the token after `/invite/` and `/api/invitations/`, the token in `/m/desk/<token>`, and the values of `token`, `code`, `invite` and `pairing_code` in a query string.

If a relay kind of yours sends a secret in another header, add a `request>headers>Name delete` line to the filter.

**Body limits.** Caddy refuses a larger body with `413` before the app reads it.

| Route | Proxy limit | How to change |
| --- | --- | --- |
| `/relay/in/*` | 4 MiB, fixed | The app's own limit is `AOM_RELAY_MAX_BODY_BYTES` or, per kind, `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` (at most 4 MiB); the app records bodies between its limit and 4 MiB as rejected. A proxy of your own must allow at least 4 MiB on this route. |
| `/hooks/in/*` | `AOM_JOURNEY_HOOK_MAX_BYTES` (default 64 KiB) | Set it in `.env`. |
| Public form file part (`PUT /api/public/forms/<id>/submissions/<sid>/parts/<n>`) | `AOM_STORAGE_MAX_FILE_BYTES` (default 25 MiB) | Set it in `.env`. |
| Rest of `/api/public/forms/*` | 4 MiB, fixed | Same as the app. |

After you change a variable in `.env`, run `docker compose -f docker-compose.prod.yml up -d`. Compose passes it to both the app and Caddy, so the two stay equal; do not give them different values. A journey webhook over the limit is refused by the proxy, so it does not show as a call on the Journeys page.

**Access log.** A `log` directive inside the site block creates its own logger, and the global filter does not apply to it. If you add one, give it the same filter, for example:

```caddyfile
log {
	output file /data/access.log
	format filter {
		wrap json
		fields {
			request>headers>X-Form-Link delete
			request>headers>X-Upload-Token delete
			request>headers>Cookie delete
			request>headers>Authorization delete
			resp_headers>Set-Cookie delete
			request>uri regexp "(?i)(/(?:relay|hooks)/in/)[^#]*|(/(?:f|api/public/forms)/)[^/?#]+" "${1}${2}[redacted]"
		}
	}
}
```

Copy every line of the global filter in `deploy/Caddyfile` rather than this short example. A reverse proxy of your own in front must delete the same headers and not log the address of these routes.

### Running behind a reverse proxy

`AOM_TRUST_PROXY` decides which peers the server believes when they send `X-Forwarded-For`. The address it resolves is the
client address used by every per-address limit (public forms, the landing-page assistant, help videos, sign-in and
password reset, the general request limit), by blog API key address allow lists, and in the logs and audit trail.

**Default (unset): loopback only.** The server trusts `X-Forwarded-For` only from `127.0.0.0/8` and `::1`. A reverse
proxy on the same host keeps working, and a client that reaches the server directly cannot choose its own address.

| Value | Meaning | Use it for |
| --- | --- | --- |
| unset | Trust loopback only. | Caddy or nginx on the same host, proxying to `127.0.0.1:4600`. |
| `loopback,uniquelocal` | Trust loopback and the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). | The bundled `docker-compose.prod.yml`. It already sets this value, overridable from `.env`. |
| `172.18.0.0/16` or `172.18.0.5` | Trust only these addresses or CIDR ranges (IPv4 or IPv6, comma-separated). The names `loopback`, `linklocal` and `uniquelocal` are accepted too. | Docker Compose with your own proxy in another container (its network address or the network's CIDR), or a proxy on another host. |
| `10.0.0.5,203.0.113.0/24` | The proxy's address plus the CDN's published ranges. | A CDN in front of your proxy. Configure the proxy to keep the CDN's `X-Forwarded-For`. |
| `1`, `2`, ... up to `32` | Trust exactly that many hops: the client is the address that many entries back from the server. | A proxy (`1`) or a CDN in front of a proxy (`2`), when the server cannot be reached except through them. |
| `false`, `0` or `none` | Never trust `X-Forwarded-For`; the client is the socket address, even from loopback. | A server that clients reach directly, with no proxy. |
| `true` | Trust every hop (the behaviour before this setting existed). | Not recommended. |

Prefer addresses over a hop count: a hop count does not check who the peer is, so anyone who can reach port 4600
without going through the proxy can write the address they want into the header. Use a hop count only when the server
is reachable through the proxy alone.

> **Warning:** `AOM_TRUST_PROXY=true` on a server that can be reached without the proxy lets every client choose its own
> address and get past the per-address rate limits. The server logs a warning at startup when it is set.

An invalid value (a word, a negative number, a hop count above 32, an address or CIDR range that does not parse) stops
the server at startup with a message that names `AOM_TRUST_PROXY` and the accepted forms. The server never falls back to
trusting every hop. At startup the log has a `trusted proxy` line that shows what is trusted.

If every visitor seems to share one address (limits trigger for everyone, the logs show only the proxy's address), the
proxy is not trusted: set `AOM_TRUST_PROXY` to its address or network.

## 8. Upgrades

Back up first (section 9), then:

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
curl https://guildwise.example.com/api/health
```

Migrations run on boot. Downtime is usually a few seconds. Watch the logs with `docker compose -f docker-compose.prod.yml logs -f app`.

- **Caddy image.** A release that changes the Caddy image tag is picked up with `docker compose -f docker-compose.prod.yml pull caddy` (or `up -d --pull always`).
- **Keep runners in step.** When a release changes the runner, update the workstations too. Runners with auto-update on take the runner release your server ships by themselves; a re-run of the installer also upgrades them. With **Only signed runners** on, a runner from before 1.10.0 cannot update itself and must be reinstalled (section 13).
- **Build from a release tag.** The image build verifies the official signed runner release of the version it builds (`RUNNER_RELEASE=official`). Build a release tag (`git checkout v1.10.0`). To build an unreleased commit, set `RUNNER_RELEASE=dev` (unsigned; fine while Only signed runners is off) or sign your own (`own-key`, section 13).
- **Data migrations.** Some releases include data migrations. They are idempotent, and they run on boot unless `AOM_DATA_MIGRATIONS=false`. Some have a `--dry-run` preview, for example `node dist/orgs-migrate.mjs --dry-run`, run with `docker compose ... exec app`.
- **Do not** run `down -v` during an upgrade. It deletes the volumes.

### Upgrading to 1.10.0

**1.10.0 is a breaking change for self-hosted installs.** With the defaults nobody is locked out: runners and two-factor logins keep working. This is the complete list of what changes.

1. **Runners keep working.** With **Only signed runners** off (the default) nothing is revoked or refused. Runners with auto-update on move to the runner that ships with 1.10.0 by themselves, normally within a day. On each workstation, run `guildwise-runner setup` once after that: until then sandboxed card work goes on, but DevOps, deploys and other steps outside the sandbox wait. **To opt in** to signed runners: sign your own runner builds (or use the official signed image), set `AOM_RUNNER_RELEASE_PUBKEY` for your own key, reinstall each runner from your server's installer, then turn the setting on (section 13).
2. **Two-factor logins keep working.** `AOM_TWO_FACTOR_KEY` is optional (a warning in production without it). The `two-factor-reseal` data migration re-seals existing seeds at first boot; nobody enrols again and recovery codes keep working. **To opt in** to enforcement: Platform > Security > Security settings > **Require two-factor login**.
3. **Removed:**
   - `/api/admin/workstations` (answers 410);
   - the platform account's two-factor reset of other users (users recover by email with a 24-hour wait; `superadmin-reset-password --reset-two-factor` stays for the platform account);
   - choosing the platform team in the app (`PUT /api/platform/team`): set `AOM_PLATFORM_TEAM_ORG_ID` and `AOM_PLATFORM_TEAM_PROJECT_ID`; an existing choice keeps working read-only until you do;
   - simulation tools on real organizations (only organizations created as simulations have them);
   - DevOps command text and runner error messages in the platform view (counts only; Owners and workstation owners see their own);
   - the database-connected remote render worker: `AOM_VIDEO_PUSH_URL` makes the video worker refuse to start; run `video-worker --remote` with a render worker token instead (section 10), and `AOM_VIDEO_WORKER_TOKEN` is no longer accepted as a credential for uploads.
4. **New behaviour, on by default:** sign-in lockout, new-device mails, invitation limits, a password reset of a two-factor account needs a code, "Confirm it's you" before secrets and platform changes, platform accounts sign in once more after the upgrade, ownership transfers need the Owner's consent, an Owner or Admin cannot reset the password or two-factor login of a member who also belongs to another organization (they send a reset link instead), and a workstation serves only the organizations its owner owns until the owner switches others on under **Works for**.
5. **New variables and build arguments** (all optional in core, section 4): `AOM_TWO_FACTOR_KEY`, `AOM_REQUIRE_SIGNED_RUNNERS`, `AOM_ENFORCE_TWO_FACTOR`, `AOM_PLATFORM_TEAM_ORG_ID`, `AOM_PLATFORM_TEAM_PROJECT_ID`, `AOM_STEP_UP_WINDOW_SEC` and `AOM_SUPER_ADMIN_IDLE_SEC` (above their maximum the server refuses to start in production), `AOM_INVITE_PER_ORG_HOUR`, `AOM_INVITE_PER_ACTOR_DAY`, `AOM_INVITE_PENDING_MAX`, `AOM_LOGIN_LOCKOUT`, `AOM_SIGNIN_NOTICES`, `AOM_RUNNER_RELEASE_PUBKEY`; build argument `RUNNER_RELEASE` (`official` by default; an unreleased commit needs `dev` or `own-key`).

Back up first (section 9), then upgrade as above.

## 9. Backups and restore

You are responsible for backing up your own server. Guildwise does not back up self-hosted installs.

**What to back up**

| What | Where | Why |
| --- | --- | --- |
| The database | `pgdata` volume, dumped with `pg_dump` | The event log and projections. This is the critical data. |
| `.env` (including `AOM_SECRET_KEY` and `AOM_TWO_FACTOR_KEY`) | Next to the compose file | Without them, stored tokens and enrolled authenticator apps cannot be read (users then recover two-factor login by email). |
| Caddy data | `caddy_data` volume | Certificates. Recreated automatically, but keep it to avoid rate limits. |
| Vault repositories | Your git hosts or the workstations | Vault contents live in git, not on the server. |

The `simulation` volume holds throwaway demo files and is not part of the database backup.

**Dump**

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U aom aom | gzip > backup-$(date +%F).sql.gz
```

Run it on a schedule (cron or a systemd timer), and copy the file off the server. Also use your provider's snapshots if it offers them.

**Restore** (into an empty database; try it on a second server before you rely on it)

```bash
docker compose -f docker-compose.prod.yml stop app
docker compose -f docker-compose.prod.yml exec -T postgres psql -U aom -d postgres \
  -c 'DROP DATABASE IF EXISTS aom WITH (FORCE)' -c 'CREATE DATABASE aom OWNER aom'
gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U aom -d aom
docker compose -f docker-compose.prod.yml up -d --build
```

Use the same `.env` (in particular the same `AOM_SECRET_KEY` and `AOM_TWO_FACTOR_KEY`) as the server the backup came from.

Point-in-time recovery is not provided. Take dumps often enough for the loss you can accept.

**Deleting data.** Deleting a simulation organization removes its events from the log permanently. Take a dump first.

## 10. Optional features

Each feature is off until its variables are set. None is required for the core product.

### Web Push (installed phone app)

Push notifications need HTTPS. Generate a key pair once per environment, with the running stack:

```bash
docker compose -f docker-compose.prod.yml exec app node dist/vapid-generate.mjs
```

Add `AOM_VAPID_PUBLIC_KEY`, `AOM_VAPID_PRIVATE_KEY` and `AOM_VAPID_SUBJECT` (for example `mailto:ops@example.com`) to `.env`, then restart. All three or none. Changing the pair makes every device subscribe again.

### Landing-page assistant and the blog writer

Set `ANTHROPIC_API_KEY` to enable the public assistant on the landing page and the optional blog writer. Both are off without the key. Costs are paid to Anthropic by you. `AOM_ASSISTANT=off` is a kill switch. `AOM_ASSISTANT_PUBLIC_DAILY_USD` caps daily spend.

### Weekly blog digest

`AOM_BLOG_DIGEST=true` (the default) sends the weekly digest on Mondays. Set `false` to stop it.

### YouTube videos (the `video` profile)

Guildwise HQ can turn articles, releases and tutorials into narrated, faceless videos and upload the ones you approve to YouTube
(docs/BLOG-API.md, "YouTube"). It is off by default. The render and the upload run in a separate container, the **video worker**
(`docker compose -f docker-compose.prod.yml --profile video up -d --build`). It uses the same image sources, database and
`AOM_SECRET_KEY` as the app, plus Chromium, ffmpeg and the offline voice (Kokoro, about 0.5 GB), and shares a `video` volume
with the app (read-only there) for the rendered files. Give it 2 CPUs and 3 GB. It renders one video at a time, so a render
(a few minutes) never starves the app.
A video renders shortly before its slot, not when its script is written, and the MP4 is removed after publishing; `AOM_VIDEO_MAX_BYTES` (default 5 GB, on the app and the worker) is the disk budget: no render starts while the rendered videos plus 300 MB would pass it. `AOM_VIDEO_ENCODE_THREADS` (worker only, default 4) caps the threads of each H.264 encode and keeps the render's memory the same on any machine; a value above the machine's cores is lowered to the cores, and a missing or invalid value (not a whole number, or below 1) uses 4. Raise it only on a large machine with memory to spare: memory grows with it. The bundled compose file does not pass it through, so the default applies there.

The help videos (the clips are cut from them) are not in the build context: `.dockerignore` leaves out `media/videos/*.mp4` and
`*.webm` (about 180 MB) so every app build stays small. The app image only needs their metadata (the `.json` and `.vtt` files, from
which it builds its library manifest), and the worker image gets the MP4s through a named build context, `media`, which the compose
file sets (`additional_contexts: media: ./media`). Building the worker by hand:
`docker build --target video-worker --build-context media=media -t aom-video-worker .`

**Rendering elsewhere (a remote render worker, optionally on a GPU).** If the server cannot render (Chromium and the voice need a CPU
with AVX), or you want a GPU to encode, set `AOM_VIDEO_ROLE=publish` for the worker here and run a remote render worker on a machine
that can. The remote worker has **no database access and no `AOM_SECRET_KEY`**: it asks your server for jobs over HTTPS with a token
of its own, gets only the script it must render and short-lived signed upload links, and the server does every database write.

1. As the platform account, open **Platform > Video > Settings > Render workers** and add a worker. Copy the token (shown once) into a
   file only the worker can read.
2. On the render machine, run the `video-worker` image as `node dist/video-worker.mjs --remote` with
   `AOM_RENDER_SERVER_URL=https://<your host>`, `AOM_RENDER_WORKER_TOKEN_FILE=<the token file>` (or `AOM_RENDER_WORKER_TOKEN`) and a
   scratch volume for `AOM_VIDEO_DIR`. It refuses plain `http` (loopback aside), `NODE_TLS_REJECT_UNAUTHORIZED=0`, `DATABASE_URL` and
   `AOM_SECRET_KEY`. A private CA goes in with `NODE_EXTRA_CA_CERTS`.
3. **GPU (NVIDIA).** The image carries a second ffmpeg with NVENC. Give the container the GPU (`--gpus all`, the NVIDIA container
   toolkit, `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`) and install the host's NVENC library for your driver (for example
   `libnvidia-encode-595` for driver 595). At start the worker tests NVENC; when it works it encodes on the GPU, otherwise on the CPU.
   A CPU fallback is never silent: the Render workers card shows a warning with the reason, and the platform accounts get one mail per
   worker a day. `AOM_VIDEO_GPU=off` forces the CPU, `AOM_VIDEO_GPU=require` makes the worker stop when NVENC does not work.
4. Revoke the worker on the same card to cut it off at once.

The worker on the server (`AOM_VIDEO_ROLE=all`, the default, which renders and publishes) stays CPU-only. `AOM_VIDEO_PUSH_URL` (the
old database-connected remote worker) is no longer supported: the video worker refuses to start with it. See docs/VIDEO-RENDERER.md.

**Short destinations.** Shorts can also go to Facebook (Reels), Instagram (Reels), X, LinkedIn, Bluesky and TikTok (docs/BLOG-API.md,
"Short destinations"): the publish worker posts them at the slot. They need nothing but the accounts connected under Social sharing,
except TikTok, which needs a developer app: set `AOM_TIKTOK_CLIENT_KEY` and `AOM_TIKTOK_CLIENT_SECRET` (app and worker), register
`https://<your host>/api/platform/social/tiktok/callback` as its redirect URI and verify your domain in the app. TikTok pulls the
video from `https://<your host>/api/public/video-media/...` (a signed link that lives under 2 hours), so `AOM_PUBLIC_ORIGIN` must
be your public HTTPS address, the app must be able to read the video volume, and `AOM_SECRET_KEY` must be the same on the app and the worker.

The `video` volume must be writable by the worker (uid 1000, user `node`). The app image creates `/data/video` owned by `node`, so a
new volume is right. A volume that already exists (made by an older image) is root-owned and the worker fails with `EACCES`; fix it once:
`docker run --rm -v <project>_video:/data/video alpine chown 1000:1000 /data/video` (`docker volume ls` shows the name).

1. Create an OAuth client in Google Cloud (APIs & Services > Credentials, type "Web application" or "Desktop"), enable the
   **YouTube Data API v3** and publish the OAuth consent screen (**In production**: a client left in Testing loses its refresh
   tokens after 7 days; an unverified app in production is fine for your own channel).
2. Set `AOM_YOUTUBE_CLIENT_ID` and `AOM_YOUTUBE_CLIENT_SECRET` in `.env`.
3. Make a refresh token for the channel's Google account with the one scope `https://www.googleapis.com/auth/youtube.force-ssl`
   (for example with Google's OAuth Playground using your own client) and paste it under Platform > Blog > Posts > Social
   sharing > YouTube channel. It is checked with YouTube and stored encrypted.
4. Platform > Blog > Videos: switch **Videos on**. The page shows "Video worker not running" while the worker's heartbeat is missing.

Nothing is drafted, rendered or uploaded unless a YouTube channel is connected **and** Videos is on. YouTube may keep videos
uploaded by an API project that has not passed Google's compliance audit private: the video is then shown as "kept private",
you get one email with the audit form (https://support.google.com/youtube/contact/yt_api_form) and uploads pause until you say
you dealt with it. Quota: about 500 units a video of the 10,000 a day, and the worker uploads at most one video a day.
Files are cleaned up daily (replaced revisions after a day, rejected ones after 7 days, uploaded MP4s 30 days after the upload).

### Inbound e-mail

Organizations can receive mail at their own addresses. This needs an inbound mail provider, a receiving domain and a secret. Set `AOM_INBOUND_PROVIDER` (`postmark` or `sendgrid`), `AOM_INBOUND_DOMAIN` and `AOM_INBOUND_SECRET` together (generate the secret with `openssl rand -hex 24`). Point the provider's inbound webhook at `https://inbound:<secret>@<your domain>/api/inbound/mail/<provider>`. Both adapters are included; use the one your mail provider offers.

### Inbound webhook relay (Business mode)

A Business mode organization can give an outside provider (the WhatsApp Cloud API, a form, a calendar) a public address, `https://<your domain>/relay/in/<token>`. The server only passes each request, raw, to the runner of a workstation that serves the integration, and hands the provider the runner's answer. It stores no message content, headers, query string, token or provider secret; the provider's secrets and the signature checks stay on the workstation. When no runner is connected the provider gets `503` with `Retry-After` and retries on its own (Meta retries for up to 7 days); nothing is queued on the server. All settings are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_RELAY_MAX_BODY_BYTES` | `1048576` | Largest request body forwarded (at most 4 MiB). Larger is `413`. The bundled proxy caps this route at 4 MiB. A `whatsapp_cloud` integration accepts at least 3 MiB whatever this is, because Meta sends payloads of up to 3 MB. |
| `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` | unset | Per kind body limits, for example `whatsapp_cloud=3145728,generic=2097152`. Each value is 1 to 4194304 (more is capped, zero or less becomes 1); an unknown kind or a non-number is ignored, as in `AOM_RELAY_TIMEOUTS`. An entry overrides the built-in `whatsapp_cloud` 3 MiB. |
| `AOM_RELAY_RATE_PER_MINUTE`, `AOM_RELAY_RATE_BURST` | `60`, `20` | Requests per minute and burst, per integration. More is `429`. |
| `AOM_RELAY_TIMEOUT_MS` | `5000` | How long the server waits for the runner's answer (`504` after that); 1000 to 15000. Keep it below the provider's own timeout. |
| `AOM_RELAY_TIMEOUTS` | unset | Per kind overrides, for example `whatsapp_cloud=5000,calendar_push=8000`. |
| `AOM_RELAY_RETRY_AFTER_SEC` | `60` | The `Retry-After` of the `503` when no runner serves the integration. |
| `AOM_RELAY_MAX_IN_FLIGHT` | `200` | Requests waiting for a runner at once; more get `503`. |
| `AOM_RELAY_RETENTION_DAYS` | `30` | How long the per-request metadata (time, integration, size, status, latency, outcome) is kept. |

A reverse proxy in front of the server must not write an access log for `/relay/in/*`: the address and query string carry the integration's secret path and the provider's verify token. The bundled Caddy configuration writes no access log; it logs only errors, through a filter that redacts the address and query (see "Proxy logs and body limits" in section 7).

On a workstation, `guildwise-runner relay add <integration-id> --kind <kind>` tells the runner to serve an integration (restart the runner to apply); `relay list` and `relay remove` manage the list.

### Public forms

A form published from the forms builder is open to anyone with its address (`https://<your domain>/f/<id>`) or a personal link. Answers and files go to the firm's own storage through its runner; the server keeps references only. Read [docs/security/public-forms.md](security/public-forms.md) before you enable it for strangers.

- The per-address limits use the client address the server resolves (the per-form limit does not depend on it). Behind a proxy in another container or on another host, set `AOM_TRUST_PROXY` (see [Running behind a reverse proxy](#running-behind-a-reverse-proxy)).
- Set `AOM_SECRET_KEY`. Personal links and page sessions are signed with a key derived from it; rotating it ends every personal link.
- A public request to `/f/*` must not be cached by the proxy (the server sends `Cache-Control: no-store`).
- The bundled proxy limits request bodies: a file part to `AOM_STORAGE_MAX_FILE_BYTES`, everything else on the form API to 4 MiB (section 7, "Proxy logs and body limits").

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_FORMS_POW_BITS` | `16` | Zero bits of the proof of work a page solves before sending. `0` turns it off, at most `22`. |
| `AOM_FORMS_MIN_FILL_MS` | `3000` | A page must have been open this long before it can send. |
| `AOM_FORMS_SESSION_TTL_MIN`, `AOM_FORMS_SUBMISSION_TTL_MIN` | `240`, `120` | How long a page session and an open submission stay valid. |
| `AOM_FORMS_MAX_FILES`, `AOM_FORMS_MAX_SUBMISSION_BYTES` | `20`, `104857600` | Files and total bytes of one submission. |
| `AOM_FORMS_OFFLINE_IP_PER_HOUR`, `AOM_FORMS_OFFLINE_IP_BURST` | `3`, `2` | Requests for a secure link (runner offline) per client address and hour, and the burst. |
| `AOM_FORMS_OFFLINE_FORM_PER_HOUR`, `AOM_FORMS_OFFLINE_MAX_OPEN` | `30`, `500` | Requests per form and hour, and open cases per organization. |
| `AOM_FORMS_OFFLINE_HOLD_DAYS` | `7` | Days a client's email is held (encrypted) while the runner stays offline, 1 to 30. After that the case closes and the address is deleted. |
| `AOM_FORMS_OFFLINE_LINK_DAYS` | `7` | Days a secure link lasts, 1 to 30. A form's own setting overrides it. |
| `AOM_FORMS_OFFLINE_SETTLE_SEC` | `30` | Seconds a runner must stay connected before secure links go out. `0` sends at once. |
| `AOM_FORMS_IP_PER_MIN`, `AOM_FORMS_IP_BURST` | `120`, `60` | Public form requests per client address. More is `429`. |
| `AOM_FORMS_IP_SUBMITS_PER_HOUR`, `AOM_FORMS_IP_SUBMIT_BURST` | `10`, `5` | Submissions started per client address. |
| `AOM_FORMS_FORM_SUBMITS_PER_MIN`, `AOM_FORMS_FORM_SUBMIT_BURST` | `60`, `30` | Submissions started per form, whatever the address. |

## 11. Operations

```bash
docker compose -f docker-compose.prod.yml ps                  # status and health
docker compose -f docker-compose.prod.yml logs -f app         # application log
docker compose -f docker-compose.prod.yml logs -f caddy       # TLS and routing
docker compose -f docker-compose.prod.yml logs -f postgres    # database log
docker compose -f docker-compose.prod.yml restart             # restart everything
curl https://guildwise.example.com/api/health                 # {"ok":true,"db":true}
```

The app container has a health check against `/api/health`.

**Logs** redact invitation tokens, pairing codes, password-reset and email-verification links, and signed render links in URLs, and never print passwords, tokens, keys or the configuration's secrets.

**Scaling.** One server instance. Run one instance only, because the dispatcher, scheduler and billing jobs must not run twice.

## 12. Troubleshooting

**Caddy does not get a certificate**

- Check that the DNS record points at this server: `dig +short guildwise.example.com`.
- Check that ports 80 and 443 are open in your firewall and at your provider.
- Read the log: `docker compose -f docker-compose.prod.yml logs caddy`.
- For an IP address or a private name, use the internal CA (section 7).

**The app does not start, or migrations fail**

- Check the database: `docker compose -f docker-compose.prod.yml logs postgres`.
- `DATABASE_URL` and `POSTGRES_PASSWORD` must agree. The compose file builds the URL from `POSTGRES_PASSWORD`, so change the password only in `.env`.
- Check disk space. Postgres cannot write when the disk is full.

**Every write returns `403 bad_origin`**

The page is open at an address other than `AOM_PUBLIC_ORIGIN`. Add that exact origin to `AOM_EXTRA_ORIGINS` and restart.
Public forms are not affected: the `/api/public/forms/` routes do not compare the `Origin` value, so a form opened at a
LAN address (for example `http://192.168.1.20:4700/f/…`) can be sent without listing that address.

**Sign-in does not stick on a plain `http` address**

With an `https` `AOM_PUBLIC_ORIGIN`, session cookies are `Secure` and are not sent over plain HTTP. Open the app over HTTPS.

**Encrypting secrets needs HTTPS or localhost**

Browser-side encryption needs a secure context. Open the app over HTTPS, or over `localhost`.

**Runner does not connect, or disconnects often**

- On the workstation: `guildwise-runner doctor` and `guildwise-runner status`.
- Exit code `2`: the token was rejected. Pair the workstation again.
- Exit code `3`: another runner is connected to the same workstation. Stop the other one.
- Outbound WebSocket on port 443 must not be blocked by a firewall or proxy.
- The server logs: `docker compose -f docker-compose.prod.yml logs app`.

**A workstation shows "Reinstall required"**

Only signed runners is on and the runner was unsigned or from before 1.10.0. Reinstall it (section 13). Pairing such a runner answers `403 signed_runner_required`; its old update path answers `410 reinstall_required`.

**The runner exits with code 78**

The runner refused to start because its user can act as root or its files are writable by others. Reinstall with the dedicated runner user (`--runner-user dedicated`), which gets its own rootless Docker, or remove the user from the docker group (or the group of another daemon's socket) and passwordless sudo. The workstation page shows the reason.

**Someone cannot sign in: `429 too_many_attempts`**

The address (or the IP) is locked after failed sign-ins; the answer says when to try again. A completed password reset clears the lock, and so does `superadmin-reset-password` for the platform account. Platform > Security > Failed sign-ins shows the failures and the locks in force.

**Every page answers `two_factor_setup_required`**

Require two-factor login is on (or the organization requires it) and the account has no two-factor login yet. Sign in and set it up; nothing else works until then.

**Installer fails**

The installer reports each step. Re-run the same command; installers are idempotent. The guided installer's help link is shown on the wizard page.

**Videos do not play**

The help videos are served by the `media` container. If it is down, the video UI is hidden and `/videos/*` answers 503. Check `docker compose -f docker-compose.prod.yml ps media`.

**Deleting everything**

`docker compose -f docker-compose.prod.yml down -v` deletes `pgdata` and `caddy_data`. Only run it when you have a verified backup and mean it.

**Held email addresses (runner offline).** A client who tries a form while the firm's runner is offline leaves an email
address. The server holds only that address, encrypted (AES-256-GCM with a key derived from `AOM_SECRET_KEY` for this
purpose, the case id as authenticated data), in the table `form_offline_requests`. It never appears in events, logs or
desk items, and no answer or file is held. It is deleted when the case closes: the secure link is used, the journey is
continued, the link or the hold expires, or the desk cancels. Closed rows (references and times only) are pruned after 30
days. The longest an address can be held is the hold days plus the link days (14 by default). Database backups follow your
own backup retention. Rotating `AOM_SECRET_KEY` makes held addresses unreadable: those cases close as failed with a desk notice.

## 13. Security settings and signed runners

### Security settings

Two settings on **Platform > Security > Security settings** (platform account only) decide how strict your server is. Both are **off by default** in a self-hosted install, so upgrading changes nothing for your runners and users until you turn one on.

| Setting | Variable (default) | When on |
| --- | --- | --- |
| **Only signed runners** | `AOM_REQUIRE_SIGNED_RUNNERS` (`false`, off) | The server pairs and accepts only runners signed with the key it trusts and not older than the runner that ships with 1.10.0. Unsigned and older runners are refused and their workstations unlinked; they must be reinstalled (below). |
| **Require two-factor login** | `AOM_ENFORCE_TWO_FACTOR` (`false`, off) | Anyone who signs in without two-factor login is sent to set it up and can use nothing else until it is done. People whose only memberships are simulation organizations are exempt. |

- **Which value wins:** a lock (below), else the value saved on the Security settings tab, else the variable, else off. The startup log prints both values and where they came from.
- **Turning one on** asks you to confirm it's you, and every change is in the audit log. The tab shows how many workstations are unsigned and how many users have no two-factor login. Turning Only signed runners on while unsigned workstations exist asks you to confirm that they will be unlinked; they are unlinked in the same step. It is refused (`409 runner_release_unsigned`) while your server's own runner release does not verify, because the server would otherwise refuse to start at its next boot.
- **Guildwise Cloud** locks both settings on through its extension, so they cannot be turned off there: the switches are disabled with a lock and the text "Set by Guildwise Cloud; cannot be changed here", the API answers `409 setting_locked`, and a `false` in the variables or in the database is ignored. A lock can only make an install stricter. Every Cloud sign-up sets up two-factor login before it can continue.

**What Only signed runners does when on**

- Pairing an unsigned or older runner is refused with `403 signed_runner_required`; the pairing code is not spent.
- A connected unsigned runner is disconnected and stops cleanly (no restart loop). Its workstation is unlinked at once, and at every boot while the setting is on: its runner token, workstation keys, sealed sudo key and pairing codes are deleted, so nothing can be re-paired in place.
- The old update path (`/api/runner/release`) answers `410 reinstall_required`, so an old runner can never update itself into a trusted one. Runners from 1.10.0 on use `/api/runner/releases/` (a signed `manifest.json`, its `.minisig` and the package).
- The server refuses to start when its own runner release does not verify against the trusted key.
- A runner told that the setting is on refuses to start when its user can act as root (exit `78`).
- Each owner of an unlinked workstation gets one mail asking to reinstall.

With the setting off, the server still records whether each runner is signed, but refuses nothing, and the old update path keeps serving, so runners update themselves as before.

The server's check of a runner's signature proof cannot prove what code really runs on a remote machine. The protection is the runner's own check: a runner from 1.10.0 on verifies the signature of every update against the key built into it and never installs an older version than its floor.

### Reinstalling unsigned runners

When Only signed runners is on, an unsigned runner (or one from before 1.10.0) cannot be re-paired in place or update itself: pairing it answers `403 signed_runner_required`, and its old update path `410 reinstall_required`. Reinstall it from the installer your own server serves:

1. Open **Workstations**. An unlinked workstation shows **Reinstall required**. Click it, or open **Workstations > Add a workstation**.
2. Copy the one-line command and run it on that machine. The installer first looks for an older runner, stops it and quarantines its files under `~/.guildwise-quarantine/<time>/` (`--legacy remove` deletes them instead). Nothing from the old install is reused.
3. Answer **Setting local permissions** (or pass the flags), and let it pair.
4. Delete the quarantine once you have looked at it. If you gave the old runner sudo, change that user's password: the old runner's sealed sudo password may be known.

Never copy files from the old runner folder into the new one. With the setting off you do not need any of this: runners with auto-update on move to the new runner by themselves, normally within a day.

### Signing your runners with your own key

Signing is **optional** for a self-hosted server. You need it only to turn Only signed runners on. Official releases are signed with the Guildwise release key, and the `official` image build verifies them; a server you build from your own commits signs with **your own** minisign key. The secret key never goes to the server, into the build context or into an image (the build only verifies), so keep it on the machine where you sign.

**What you need.** `minisign` where you sign (`sudo apt install minisign`, or `brew install minisign` on macOS). In the checkout you build the server from: Node 22 (for example from [nodejs.org](https://nodejs.org) or `nvm install 22`) with pnpm (`corepack enable`), network access, and the dependencies installed once (`pnpm install`). Run steps 2 and 4 in that checkout of the release you build, with a copy of `guildwise-runner.pub` there; only step 3 needs the secret key.

1. **Create a key pair** once, on the machine where you sign (a laptop is fine; the passphrase protects the secret key):

   ```bash
   minisign -G -p guildwise-runner.pub -s ~/.minisign/guildwise-runner.key
   ```

2. **Build the runner release** with your public key compiled in, so your runners trust only that key:

   ```bash
   scripts/package-runner.sh --pubkey guildwise-runner.pub --out runner-release
   ```

   This writes `runner-release/aom-runner-<version>.tgz` and an unsigned `runner-release/manifest.json` (it holds the package's sha256).

3. **Sign the manifest** where the secret key is:

   ```bash
   scripts/sign-runner-release.sh runner-release/manifest.json --key ~/.minisign/guildwise-runner.key --pub guildwise-runner.pub
   # or directly:
   minisign -S -s ~/.minisign/guildwise-runner.key -m runner-release/manifest.json -t "guildwise-runner <version>"
   ```

   Copy `manifest.json.minisig` back into `runner-release/` if you signed on another machine. Never copy the secret key to the server.

4. **Point the server at your public key and build in own-key mode.** In `.env` (the compose file passes both to the build and the app):

   ```dotenv
   RUNNER_RELEASE=own-key
   AOM_RUNNER_RELEASE_PUBKEY=RW...   # the second line of guildwise-runner.pub
   ```

   Then `docker compose -f docker-compose.prod.yml up -d --build`. The build verifies `runner-release/` with that key and stops if the signature does not match.

5. **Reinstall each runner** from your server's installer (above), so every workstation runs a runner signed with your key.
6. **Turn on Only signed runners** under Platform > Security > Security settings.

Repeat steps 2 to 4 for every release you build. Without your own key, leave the setting off (or build with `RUNNER_RELEASE=dev` for an unsigned runner): self-hosted servers keep working with unsigned runners.

**Signing per environment from the app.** When Guildwise deploys an app of yours that ships a runner (such as Guildwise itself), a deploy target can require a runner signed with that target's key. The release sheet then offers to package the runner for that place and sign it on a workstation that holds the key (after `guildwise-runner signing add-key`, with a yes on that workstation), or to download `manifest.json` and upload a signature you made offline. The deploy waits until it is signed. See the user guide, "Releases".

## 14. Hardening the host

The bundled compose file publishes only Caddy. Keep it that way.

- Publish nothing else: Postgres and the app listen inside the Docker network only. Do not run a Docker management UI or mount the Docker socket into any container.
- Firewall: deny incoming by default; allow 80 and 443, and SSH only from where you administer (a VPN is better). Docker publishes ports past `ufw`; set `"ip": "127.0.0.1"` in `/etc/docker/daemon.json` so a published port without an address binds to loopback.
- SSH: keys only, no root login, no passwords.
- `.env`: mode `600`, owned by the user that runs compose; no copies (`.env.bak`) next to it. `AOM_TWO_FACTOR_KEY` protects the two-factor seeds against a database-only leak, but it sits in the same `.env`: root on the host still yields every key.
- Set `AOM_TRUST_PROXY` to exactly your proxy (section 7), so lockouts and limits see the real client address.
- Keep sign-in notices on (`AOM_SIGNIN_NOTICES=all`), and read the mails: a sign-in from a new device, a lock notice or a "session refused" mail is how you learn of an attack early.
- Consider turning on Require two-factor login, and Only signed runners with your own key (section 13).
