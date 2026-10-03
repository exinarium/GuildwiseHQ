# Deploying Agent Org Manager

One Docker image runs the API server and serves the built web app; Postgres stores the event log; Caddy terminates HTTPS. Agents run on your own machines through the runner (see "Workstations").

## Server stack

```sh
cp .env.prod.example .env      # edit: POSTGRES_PASSWORD, AOM_DOMAIN, AOM_PUBLIC_ORIGIN, SMTP
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec app node dist/admin-create.mjs \
  --email you@example.com --name "You" --password '<12+ characters>'
```

- `app` runs `node dist/main.mjs`. Migrations run on boot (`AOM_MIGRATE_ON_BOOT=true`); `/api/health` reports `{"ok":true,"db":true}` and backs the container health check.
- `caddy` (config in `deploy/Caddyfile`) proxies everything, WebSockets included (`/api/ws` for browsers, `/api/runner/ws` for runners), to `app:4600`. For a public DNS name in `AOM_DOMAIN` it obtains a Let's Encrypt certificate (ports 80 and 443 must be reachable). For `localhost` or an IP it uses Caddy's internal CA.
- `AOM_PUBLIC_ORIGIN` must be exactly the URL users open (scheme, host and non-default port). It is used for the CSRF origin check, invitation links and the Secure cookie flag.
- Mail: set `AOM_SMTP_URL` (e.g. `smtp://user:pass@smtp.example.com:587`). To try the stack without a relay, start with `--profile mail` and use `AOM_SMTP_URL=smtp://mailpit:1025`; the Mailpit UI is on `127.0.0.1:${AOM_MAILPIT_PORT:-8025}`.
- Data lives in the `pgdata` volume (back it up with `pg_dump`) and Caddy's certificates in `caddy_data`.
- Upgrade: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

Local HTTPS test on other ports (internal CA): `AOM_DOMAIN=localhost AOM_PUBLIC_ORIGIN=https://localhost:9443 AOM_HTTPS_PORT=9443 AOM_HTTP_PORT=9080`. The browser (and the runner, via `NODE_EXTRA_CA_CERTS`) must trust Caddy's root: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`.

`pnpm e2e:prod` (`scripts/check-prod-compose.sh`) automates exactly this on free ports under the compose project `aom-prod-test`: build, boot, HTTPS health, admin, pairing and a connected runner, then `down -v`. It is the scripted check for M1 AC10.

## Workstations (runner)

Each workstation that hosts agents needs Node 22, git 2.40+ and the runner:

```sh
pnpm package:runner                 # writes release/aom-runner-<version>.tgz (self-contained, no pnpm needed on the target)
tar xzf aom-runner-0.1.0.tgz && cd aom-runner
./aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"   # code from Workstations > Pair
./aom-runner repos add ~/src        # folders scanned for git clones that have an origin
./aom-runner start                  # run under systemd / launchd / Task Scheduler; add --mock for the token-free mock runtime
```

On Windows use `aom-runner.cmd`. See `apps/runner/README.md` for the data directory, Claude credentials and restart behaviour.

The Workstations page lists, per workstation, the repositories that match a project repository (same normalised remote URL) of a project you belong to, so a repo shows up after it is added to a project.

## Operations notes

- There is no hire cap any more (the first-run cap ended with the HR board); hire as many agents as you need.
- `AOM_RATE_LIMIT`, `AOM_TEST_CLOCK` and `AOM_SERVE_WEB`/`AOM_WEB_DIST` are documented in `.env.example`. Never set `AOM_TEST_CLOCK` in production: it exposes `POST /api/test/clock`.
