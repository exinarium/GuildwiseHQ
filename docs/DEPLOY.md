# Deploying Agent Org Manager

Production deployment with Docker Compose, Caddy HTTPS, and Postgres. Agents run on your workstations via the runner (see `docs/RUNNER.md`).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ VPS (docker-compose.prod.yml)                           │
├─────────────────────────────────────────────────────────┤
│ caddy (Caddyfile)                                       │
│   reverse proxy, TLS, WebSocket                         │
│   ↓                                                     │
│ app (fastify, :4600)                                    │
│   REST /api/*, WebSocket /api/ws (browsers)            │
│   Dispatcher, scheduler, runner gateway                │
│   ↓                                                     │
│ postgres (port 5432, local)                            │
│   Event store (append-only)                            │
│   Projections (denormalized views)                     │
│   One instance per deployment                          │
└─────────────────────────────────────────────────────────┘

Workstations (users' machines)
  runner → server over wss (port 443)
  git repos, vaults, agent sandboxes (local only)
```

## Pre-deployment checklist

- [ ] Domain name with DNS pointing to your VPS IP
- [ ] Postgres user/password chosen (set `POSTGRES_PASSWORD` in `.env`)
- [ ] SMTP relay configured (for invitation emails)
- [ ] Caddy ports 80/443 open (for TLS)
- [ ] Docker and docker compose installed
- [ ] `git pull` latest code

## Deployment

### 1. Set up environment

On your VPS, create `.env` next to `docker-compose.prod.yml`:

```bash
cp .env.prod.example .env
# Edit .env with your values
```

**Required variables** (see "Environment variables" section below):
- `POSTGRES_PASSWORD`: strong password for the aom database
- `AOM_DOMAIN`: public domain name (e.g., `aom.example.com`)
- `AOM_PUBLIC_ORIGIN`: full URL users open (e.g., `https://aom.example.com`)
- `AOM_SMTP_URL`: SMTP relay URL (e.g., `smtp://user:pass@relay.example.com:587`)

### 2. Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This:
- Builds the app image (Node, bundles web + server)
- Starts `app` (Fastify on :4600), `postgres` (internal), `caddy` (on :80/:443)
- Applies migrations on boot (via `AOM_MIGRATE_ON_BOOT=true`)
- Logs to docker compose (use `docker compose logs -f` to watch)

### 3. Create the first admin account

```bash
docker compose -f docker-compose.prod.yml exec app node dist/admin-create.mjs \
  --email you@example.com \
  --name "You" \
  --password 'your-strong-password'
```

### 4. Test the deployment

Open `https://aom.example.com` in a browser. If using `localhost` or internal IP with Caddy's internal CA, add the root certificate to your trusted CAs or browser:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .
# On Linux: sudo cp root.crt /etc/ca-certificates/extra/ && sudo update-ca-certificates
# On macOS: open root.crt (double-click) and add to Keychain
# On Windows: double-click root.crt and select "Install Certificate"
```

Test the API:
```bash
curl https://aom.example.com/api/health
# Should return: {"ok":true,"db":true}
```

## Upgrades

Pull the latest code and rebuild:

```bash
git pull
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run on boot. Downtime is minimal (seconds).

## Environment variables (server)

Set these in `.env` before starting the server. All have defaults suitable for development or HTTPS deployment.

### Connection and hosting

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_HOST` | `127.0.0.1` | Server bind address (use `0.0.0.0` in Docker) |
| `AOM_PORT` | `4600` | Server port (expose through Caddy, not directly) |
| `AOM_PUBLIC_ORIGIN` | `http://localhost:5173` | Full URL users open; determines CSRF origin, cookie Secure flag, invitation links |
| `AOM_DOMAIN` | — | Public domain (used by Caddy for Let's Encrypt certs; omit for internal IP/CA) |
| `AOM_HTTP_PORT` | `80` | Caddy HTTP port (for ACME challenges) |
| `AOM_HTTPS_PORT` | `443` | Caddy HTTPS port |

### Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://aom:aom@127.0.0.1:5433/aom` | Postgres connection string; in Docker use `postgres://aom:$POSTGRES_PASSWORD@postgres:5432/aom` |
| `POSTGRES_PASSWORD` | — | Database password (set this; used by postgres container and DATABASE_URL) |

### Email

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_SMTP_URL` | `smtp://127.0.0.1:1025` | SMTP relay URL (e.g., `smtp://user:pass@smtp.example.com:587`) |
| `AOM_MAIL_FROM` | `Guildwise <noreply@aom.local>` | From address in emails |

### Features

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_MIGRATE_ON_BOOT` | `true` | Apply migrations on server start (set to false once deployed if you prefer manual control) |
| `AOM_SERVE_WEB` | `false` | Serve the built web app from the server (enabled in `docker-compose.prod.yml`) |
| `AOM_MIGRATIONS_DIR` | — | Override the directory SQL migrations are read from (defaults to the bundled `migrations/`) |
| `AOM_WEB_DIST` | — | Path to built web assets (auto-set in Docker to `/app/dist/web`) |
| `AOM_RATE_LIMIT` | `true` | Enable request rate limiting |
| `AOM_ALLOW_LOCAL_REMOTES` | `false` | **Tests only.** Accept `file://` and local-path git remotes for repositories and vaults; production refuses them |
| `AOM_MOCK_UI` | `false` | **Dev and tests only.** Show the mock-runtime card fields (Mock script, ...) in the UI and accept them on the API; off, the API refuses them with 422 |
| `AOM_MAX_SHIFTS_PER_WORKSTATION` | `16` | Ceiling for a workstation's `maxConcurrentShifts` (the runner's own setting, default 4, is what normally applies) |
| `AOM_TEST_CLOCK` | `false` | **Never enable in production.** Exposes `POST /api/test/clock` for testing |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |

### Security headers

The app sends a Content-Security-Policy (same-origin scripts, `connect-src` for the WebSocket origin derived from
`AOM_PUBLIC_ORIGIN`, no framing, no objects) and, when `AOM_PUBLIC_ORIGIN` is `https://...`, `Strict-Transport-Security`.
The bundled `deploy/Caddyfile` also adds HSTS for every host except `localhost`/`127.0.0.1`, so a locally trusted test
certificate never pins your browser. If you terminate TLS elsewhere, keep forwarding the `Host` header and do not strip
these headers. Access logs redact invitation tokens and pairing codes in URLs.

### Development only (never in production)

- `AOM_TEST_CLOCK=1`: exposes test clock endpoints for E2E tests

## Database and backups

Postgres stores the event log (immutable, append-only) and projections. The database is critical.

### Backup strategy

Use your VPS provider's snapshot or automated backup tools. Postgres data is in the `pgdata` volume.

```bash
# Manual backup (example)
docker compose exec postgres pg_dump -U aom aom > backup-$(date +%s).sql
# Restore
docker compose exec -T postgres psql -U aom aom < backup.sql
```

Point-in-time recovery is out of scope for v1. Keep automated snapshots (e.g., daily).

### Database maintenance

Postgres is stable. No manual maintenance needed for v1. Monitor disk usage and ensure backups are running.

## Operations and monitoring

### Health check

```bash
curl https://aom.example.com/api/health
# Response: {"ok":true,"db":true}
```

Included in the Docker health check (container marked healthy if endpoint returns 2xx).

### Logs

```bash
docker compose -f docker-compose.prod.yml logs -f app       # app logs
docker compose -f docker-compose.prod.yml logs -f postgres  # database logs
docker compose -f docker-compose.prod.yml logs -f caddy     # TLS and routing
```

### Performance tuning (v1 defaults)

- `postgres` max connections: 100 (sufficient for small deployments)
- `app` max concurrent requests: rate limited (to 100 req/s by default if enabled)
- Event store uses a global append lock for consistency (acceptable latency: <50 ms per append)

No scaling for v1 (single server instance). Revisit if response times degrade.

### Restart and recovery

To restart all services:
```bash
docker compose -f docker-compose.prod.yml restart
```

To fully recreate (loses data in named volumes if not backed up):
```bash
docker compose -f docker-compose.prod.yml down -v   # WARNING: deletes pgdata and caddy_data
docker compose -f docker-compose.prod.yml up -d --build
```

## Disaster recovery

1. **Database is lost**: restore from backup (`pg_restore` or `psql < dump.sql`)
2. **Code is lost**: `git clone` the repo again
3. **Caddy TLS is lost**: recreated on next startup (Let's Encrypt if public domain, internal CA if localhost/IP)
4. **Config (.env) is lost**: recreate from `.env.prod.example`

## Workstations (runners)

Agents run on your workstations. See `docs/RUNNER.md` for installation and configuration.

Once the server is running, pair runners:

```bash
aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"
aom-runner repos add ~/src ~/work
aom-runner start
```

Workstations connect outbound over WebSocket (no inbound ports needed). Code, credentials and work stay local.

## Isolation and multi-tenancy

Each user is sandboxed: they see only their own org, projects, cards, and shared projects (invited). The server enforces org-scoped queries and authorization checks in every route. Tests verify cross-user isolation.

v1 runs a single server instance. Runner connections are identified by token (not session); a second runner with the same token closes the first (preventing duplicate shifts).

## Troubleshooting

**Caddy won't get a certificate (Let's Encrypt fails):**
- Check DNS points to your IP
- Ensure ports 80 and 443 are open
- Check Caddy logs: `docker compose logs caddy`
- For internal IP/hostname, Caddy uses its internal CA (configure `AOM_DOMAIN=localhost`)

**Migrations fail on boot:**
- Check database connectivity: `docker compose logs postgres`
- Verify `DATABASE_URL` and `POSTGRES_PASSWORD` match
- Check disk space: Postgres may fail to write if disk is full

**High error rates or slow responses:**
- Check logs: `docker compose logs app | tail -100`
- Check database size: `docker compose exec postgres du -sh /var/lib/postgresql/data`
- Check CPU/memory: `docker stats`

**Runner disconnects frequently:**
- Check server logs: `docker compose logs app`
- Ensure runner has internet connectivity
- Check firewall rules for WebSocket on port 443

## Maintenance windows and no-downtime deployments

To minimize user impact during upgrades:

1. Ensure all runners are idle (board shows no active shifts)
2. Run `git pull && docker compose -f docker-compose.prod.yml up -d --build` (Caddy will proxy during rebuild)
3. Migrations run on boot; typically takes <1 second
4. Test: curl `/api/health`

Downtime is typically <5 seconds (container rebuild + migration).

## See also

- `docs/RUNNER.md`: runner installation, config, troubleshooting
- `docs/SPEC.md`: product specification
- `docs/ARCHITECTURE.md`: technical design and event store
- `.env.prod.example`: commented environment template
- `docker-compose.prod.yml`: production compose file
- `deploy/Caddyfile`: Caddy configuration
