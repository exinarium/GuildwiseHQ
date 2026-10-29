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
| `AOM_SECRET_KEY` | output of `openssl rand -hex 32` | Encrypts two-factor seeds and stored social and GitHub tokens. At least 16 characters. The server refuses to start in production without it. Keep it with your backups. |

### Recommended

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_MAIL_FROM` | `Guildwise HQ <noreply@aom.local>` | From address. Quote it if it has spaces: `"Guildwise HQ <noreply@example.com>"`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `AOM_HTTP_PORT`, `AOM_HTTPS_PORT` | `80`, `443` | Change only if another service uses those ports. |

### Advanced

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_MIGRATE_ON_BOOT` | `true` | Apply migrations on start. |
| `AOM_EXTRA_ORIGINS` | unset | Extra exact origins the web app may be opened from (comma-separated, never `*`). |
| `AOM_RATE_LIMIT` | `true` | Request rate limiting. |
| `AOM_MAX_SHIFTS_PER_WORKSTATION` | `16` | Platform ceiling on shifts per workstation (`0` means no ceiling). |
| `AOM_DATA_MIGRATIONS` | on | Set to `false` to skip data migrations on boot. |

Set these only for development or tests, never in production: `AOM_TEST_CLOCK`, `AOM_MOCK_UI`, `AOM_ALLOW_LOCAL_REMOTES`.

## 5. The platform account and organizations

The **platform account** runs the service. It manages organizations, invitations, accounts and the audit log. It belongs to no organization and cannot see anyone's work.

### Create it

```bash
docker compose -f docker-compose.prod.yml exec app node dist/superadmin-create.mjs \
  --email platform@example.com \
  --name "Platform" \
  --password 'use-a-long-passphrase'
```

Sign in with it. Two-factor login is set up at the first sign-in. Keep the recovery codes.

### Reset it

```bash
docker compose -f docker-compose.prod.yml exec app node dist/superadmin-reset-password.mjs \
  --email platform@example.com [--reset-two-factor]
```

`--reset-two-factor` also clears two-factor login, so it is set up again at the next sign-in.

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
- Re-running the installer upgrades the runner and keeps existing pairings.

The installer installs git, bubblewrap and socat (Linux), Node 22 and Claude Code, asks which folders hold your code, runs `guildwise-runner repos add` for each, walks you through the Claude sign-in, and installs a user service (`guildwise-runner` on systemd, a launchd agent on macOS).

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

Exit codes of `guildwise-runner start`: `0` stopped by a signal; `2` the server rejected the token (pair again); `3` another runner is already connected to the same workstation.

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

## 8. Upgrades

Back up first (section 9), then:

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
curl https://guildwise.example.com/api/health
```

Migrations run on boot. Downtime is usually a few seconds. Watch the logs with `docker compose -f docker-compose.prod.yml logs -f app`.

- **Keep runners in step.** When a release changes the runner, update the workstations too. The installer re-run upgrades them, and the server offers the runner release it ships.
- **Data migrations.** Some releases include data migrations. They are idempotent, and they run on boot unless `AOM_DATA_MIGRATIONS=false`. Some have a `--dry-run` preview, for example `node dist/orgs-migrate.mjs --dry-run`, run with `docker compose ... exec app`.
- **Do not** run `down -v` during an upgrade. It deletes the volumes.

## 9. Backups and restore

You are responsible for backing up your own server. Guildwise does not back up self-hosted installs.

**What to back up**

| What | Where | Why |
| --- | --- | --- |
| The database | `pgdata` volume, dumped with `pg_dump` | The event log and projections. This is the critical data. |
| `.env` (including `AOM_SECRET_KEY`) | Next to the compose file | Without `AOM_SECRET_KEY`, enrolled authenticator apps and stored tokens cannot be read. |
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

Use the same `.env` (in particular the same `AOM_SECRET_KEY`) as the server the backup came from.

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
A video renders shortly before its slot, not when its script is written, and the MP4 is removed after publishing; `AOM_VIDEO_MAX_BYTES` (default 5 GB, on the app and the worker) is the disk budget: no render starts while the rendered videos plus 300 MB would pass it.

The help videos (the clips are cut from them) are not in the build context: `.dockerignore` leaves out `media/videos/*.mp4` and
`*.webm` (about 180 MB) so every app build stays small. The app image only needs their metadata (the `.json` and `.vtt` files, from
which it builds its library manifest), and the worker image gets the MP4s through a named build context, `media`, which the compose
file sets (`additional_contexts: media: ./media`). Building the worker by hand:
`docker build --target video-worker --build-context media=media -t aom-video-worker .`

**Rendering elsewhere.** If the server cannot render (Chromium and the voice need a CPU with AVX), set `AOM_VIDEO_ROLE=publish` in
`.env` for the worker here and run a second worker with `AOM_VIDEO_ROLE=render` on a machine that can, on the same database. That
machine sets `AOM_VIDEO_PUSH_URL` (your public URL) and `AOM_VIDEO_WORKER_TOKEN` and pushes each finished file over HTTPS; set the
same `AOM_VIDEO_WORKER_TOKEN` (a long random string) here, and the publish worker accepts them on `AOM_VIDEO_WORKER_PORT`
(default 4610, internal network only; the bundled Caddy forwards `/api/worker/video/*` to it). See docs/VIDEO-RENDERER.md "Worker roles and the artifact push". Default
`AOM_VIDEO_ROLE=all` keeps one worker doing both.

**Short destinations.** Shorts can also go to Facebook (Reels), Instagram (Reels), X, LinkedIn, Bluesky and TikTok (docs/BLOG-API.md,
"Short destinations"): the publish worker posts them at the slot. They need nothing but the accounts connected under Social sharing,
except TikTok, which needs a developer app: set `AOM_TIKTOK_CLIENT_KEY` and `AOM_TIKTOK_CLIENT_SECRET` (app and worker), register
`https://<your host>/api/platform/social/tiktok/callback` as its redirect URI and verify your domain in the app. TikTok pulls the
video from `https://<your host>/api/public/video-media/...` (a signed link that lives under 2 hours), so `AOM_PUBLIC_ORIGIN` must
be your public HTTPS address, the app must be able to read the video volume, and `AOM_SECRET_KEY` must be the same on the app and the worker.
`AOM_VIDEO_PUSH_URL` now requires `AOM_VIDEO_WORKER_TOKEN`: the server refuses to start with one and not the other.

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

**Logs** redact invitation tokens and pairing codes in URLs.

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

**Installer fails**

The installer reports each step. Re-run the same command; installers are idempotent. The guided installer's help link is shown on the wizard page.

**Videos do not play**

The help videos are served by the `media` container. If it is down, the video UI is hidden and `/videos/*` answers 503. Check `docker compose -f docker-compose.prod.yml ps media`.

**Deleting everything**

`docker compose -f docker-compose.prod.yml down -v` deletes `pgdata` and `caddy_data`. Only run it when you have a verified backup and mean it.
