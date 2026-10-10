# Deploying Guildwise HQ

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

### 3. Create the platform account and the first organization

The **platform account** (super admin) manages organizations, invitations, accounts and the audit log. It belongs to no organization and cannot see anyone's work. It must use two-factor login, which it sets up at its first sign-in (keep the recovery codes).

```bash
docker compose -f docker-compose.prod.yml exec app node dist/superadmin-create.mjs \
  --email platform@example.com \
  --name "Platform" \
  --password 'your-strong-password'
```

Then either sign in as the platform account and invite someone to start an organization (**Platform > Invitations**), or create the first user and organization directly. Use a different email from the platform account:

```bash
docker compose -f docker-compose.prod.yml exec app node dist/admin-create.mjs \
  --email you@example.com \
  --name "You" \
  --password 'your-strong-password' \
  --org "Your organization"
```

A lost platform password is reset with `node dist/superadmin-reset-password.mjs --email ... [--reset-two-factor]` (the flag also clears its two-factor login so it is set up again).

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

### Upgrading from before organizations (October 2026)

1. **Back up the database** first (see Backups).
2. Optional preview, which reads and prints the plan and writes nothing: `docker compose -f docker-compose.prod.yml exec app node dist/orgs-migrate.mjs --dry-run`. Pending SQL migrations are applied in a transaction that is rolled back before the plan is made, so the plan is complete even before the first boot of the new version; the command says how many were pending.
3. Deploy. On boot the schema migrations `1310_organizations`, `1311_org_fks` and `1312_two_factor` run, then the data migration `orgs-2026-10` gives **every existing user an organization** (same id as the user, so no existing row or event changes) and makes them its Owner. Users who only had shared access get an organization of their own and keep their shared projects as guest access. The migration is idempotent: running it again (or `orgs-migrate.mjs`) finds nothing to do.
4. Create the platform account (step 3 above) with a new email.
5. The old `/api/admin/*` endpoints answer 410 and point to their replacements.

### Upgrading from before org-level interests (October 2026)

Feed projects and feed schedules are replaced by **interests** (`docs/design/restructure.md` Part D). The change is one-way, so:

1. **Back up the database and the vaults** first (see Backups). The migration moves vault folders (`projects/<folder>/` becomes `interests/<name>/`) with `git mv` and a commit on the first runner that holds each vault; the history is kept, but take a copy of the vault repositories anyway.
2. Optional preview, which reads and prints what would happen and writes nothing: `docker compose -f docker-compose.prod.yml exec app node dist/restructure-migrate.mjs --dry-run`. Pending SQL migrations are applied in a rolled-back transaction first (and it reminds you if `orgs-2026-10` has not run yet), so the plan is complete on a database that was not migrated yet. It lists each feed project with its interests, unadopted feed schedules, cards, items, ratings and transcripts, and where its vault folder moves.
3. Deploy. On boot the schema migration `1316_interests_org` runs, then the data migration `restructure-2026-10` (after `orgs-2026-10`). For each feed project it makes the project the hidden backing project of its first interest and gives its other interests and unadopted feed schedules new hidden projects (members, seen-list, transcripts and taste rules copied), removes the feed schedules, links past scans to their interest (they appear in the run log as "migrated") and posts one desk note to each Owner. The vault commands (`vault.move`, then the `INTEREST.md` and taste writes) are queued and run when a workstation that holds the vault is online; until then agents read an empty folder, so keep a runner connected during the upgrade. The migration is idempotent: running it again (or `restructure-migrate.mjs`) finds nothing to do. `AOM_DATA_MIGRATIONS=false` skips it (it then runs the next time the flag is on).
4. Interests default to **immediate delivery** after migration, so nothing about what reaches the desk changes until you choose delivery times. Set a **daily quiet cap** on the Interests page if you want one.
5. The old addresses `/p/<KEY>/feed` and the board of a feed project redirect to the interest. `AOM_LEGACY_FEED_SCHEDULES` is gone.

### Upgrading from before ranked projects (October 2026)

The work/personal split is gone: your own organization is where personal work lives. Projects are ranked by their organization instead of having a domain and a priority tier, and there is one **organization vault** plus project vaults (no personal vault). The change is one-way, so:

1. **Back up the database and the vault repositories** first (see Backups). The personal vault is merged into the organization vault by copying its files; the old repository is never changed and stays as a backup, but take a copy anyway.
2. Optional preview, which reads and prints what would happen and writes nothing: `docker compose -f docker-compose.prod.yml exec app node dist/ranking-migrate.mjs --dry-run`. Pending SQL migrations are applied in a rolled-back transaction first (and it reminds you if `orgs-2026-10` or `restructure-2026-10` have not run yet), so the plan is complete on a database that was not migrated yet. It lists, per organization, the projects in the order they will be ranked (work projects first in their old tier order, then personal projects in theirs), what happens to the personal vault, the interest folders that stay where interests live (`interests/<name>/`) and the personal project folders that move to `personal/projects/<key>`.
3. Update the runners on your workstations together with the server: the runner command `vault.merge` is new, and a runner that does not know it cannot merge the personal vault.
4. Deploy. On boot the schema migration `1322_project_ranking` runs (it adds `projects.rank` in the old order, keeps what `projects.domain` and `priority_tier` held in `legacy_project_domains`, then drops those columns and `interests.domain`, and turns `work` vaults into `org` vaults), then the data migration `no-personal-2026-10` (after `restructure-2026-10`). For each organization it ranks the projects (work before personal, by the old tier, then age), merges the personal vault into the organization vault under `personal/` (one runner command, `vault.merge`, queued for a workstation of the Owner or an Admin; the interest folders of personal interests are kept at `interests/<name>/`; an organization that only had a personal vault keeps it as its organization vault and nothing moves) and posts one desk note to each Owner. The merge runs when a workstation that holds the vaults is online, so keep a runner connected during the upgrade; until it has finished agents read an empty `personal/` folder. An organization with a personal vault and no workstation at all waits: pair one and run `node dist/ranking-migrate.mjs`. The migration is idempotent: running it again changes nothing, and it never overwrites a ranking the Owner made since. `AOM_DATA_MIGRATIONS=false` skips it (it then runs the next time the flag is on).
5. Check **Projects** (the priority order, drag and drop for the Owner and Admins) and **Vaults** (the organization vault; `personal/` inside it holds the old personal files).

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
| `AOM_RUNNER_RELEASE_DIR` | `/app/release` in the image | Directory with `aom-runner-<version>.tgz` served to the workstation installers (`/api/runner/release`); the image builds it with `scripts/package-runner.sh` |
| `AOM_SECRET_KEY` | generated on first use | Key that encrypts two-factor (TOTP) seeds at rest. **Set it in production** (any long random string) so a database dump alone cannot read the seeds; without it a random key is kept in the database. Changing it later invalidates enrolled authenticator apps, so keep it with your backups |

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
| `AOM_SUPPORT_FROM` | unset | From address of the support mails to customers (acknowledgement, replies), e.g. `Guildwise HQ Support <support@guildwisehq.com>`; unset: `AOM_MAIL_FROM`. The mail relay must be allowed to send as this address (SPF/DKIM/DMARC, see `docs/design/support-mail-from.md`) |

### Landing-page assistant ("Ask Guildwise")

An optional chat widget on the public landing page, paid by Guildwise (Claude Haiku 4.5, no tools, English only). It answers questions about the product from a fixed knowledge pack and keeps no conversations, only counters. It is **off unless `ANTHROPIC_API_KEY` is set**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Secret. The Anthropic API key the server uses for the assistant (never sent to the browser, never logged). Unset: the assistant is off and the widget is not shown. Put it in the server's environment file or secret store, not in the repository |
| `AOM_ASSISTANT` | `public` with a key, `off` without | Kill switch, read at start: `off` or `public`. `off` answers every request with "not available" and hides the widget. The super admin has a second switch (Platform, Support) that works without a restart |
| `AOM_ASSISTANT_PUBLIC_DAILY_USD` | `2` | The initial default of the spend ceiling per UTC day, in US dollars, counted from the usage the API reports. The super admin overrides it in the platform area (Platform, Support, Assistant: **Daily budget**, stored in `platform_settings`), without a restart; **Use the default** clears the override. When it is reached the widget answers "busy, use Contact us" until midnight UTC |
| `AOM_ASSISTANT_MODEL_PUBLIC` | `claude-haiku-4-5` | Model id. Change only after checking cost (about $0.003 a turn on Haiku 4.5 with a warm cache) |

Per visitor address (a salted hash, never the address): 20 messages an hour and 40 a day, and a small proof of work (about a second in the browser) from the sixth message. Rebuild the knowledge pack with `pnpm --filter @aom/server assistant:pack` after changing a help article or `docs/assistant/product-facts.md`, and commit it; a test fails when it is stale.

### Blog (docs/BLOG-API.md)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_BLOG_DIGEST` | `true` | Send the weekly blog digest (Mondays 08:00 Africa/Johannesburg). `false` stops it; the super admin can also switch it off under Platform > Blog |
| `AOM_LINKEDIN_CLIENT_ID`, `AOM_LINKEDIN_CLIENT_SECRET` | unset | The LinkedIn app credentials, only used to renew the organization token with its refresh token |

The blog itself, the API keys, the kill switch and the Facebook and LinkedIn tokens are managed in the platform area, not
in the environment. The social tokens are encrypted with `AOM_SECRET_KEY`: **set it in production** (and keep it, or the
stored tokens cannot be read again). Prefer sending the digest from a dedicated address (SPF, DKIM and DMARC on the
sending domain; see `docs/design/support-mail-from.md`). The public blog pages (`/blog`, `/sitemap.xml`, `/robots.txt`)
are rendered by the server, so a reverse proxy must pass those paths to it, not only `/api`. Migrations 1450 to 1452.

### Billing

Billing runs on the fake provider (simulated payments, a "Test mode" notice in the UI) until payment keys are set, so local and UAT need nothing. **Never leave production on the fake provider**: it takes no money. Paystack is the payment provider; PayFast stays in the code as a fallback.

**Payments not configured.** With billing active (`AOM_BILLING_JOBS` not `false`), when the effective provider is `fake` and `AOM_PUBLIC_ORIGIN` is an `https` origin that is not `localhost`, a loopback address or a private LAN address (10.x, 172.16-31.x, 192.168.x), the server **still starts** and logs one WARN naming the variables to set. Until a real provider is configured it never charges or captures a card with the fake provider (billing jobs that would charge are skipped and logged once); self-service sign-up is closed (`POST /api/signup`, email verification and its resend answer 503 `signup_unavailable`; `/signup` shows "Sign-up opens soon", the landing page and sign-in page point to Contact us instead of the free trial; `GET /api/public/plans` returns `signupAvailable: false`); Owners cannot subscribe or add a card (409 `payments_unavailable`; the Billing tab says "Payments are not available yet"); and super admins see a banner in the platform area and a note under Platform > Billing. Invited and free organizations keep working. Set `AOM_PAYMENT_PROVIDER=paystack` and `AOM_PAYSTACK_SECRET_KEY` (restart) to turn it all on. `http` origins and LAN addresses (for example the local UAT stack on `http://192.168.1.10:4700`) keep the fake provider and sign-up exactly as before. A staging server on a public https domain that should use fake payments on purpose sets `AOM_ALLOW_FAKE_PAYMENTS=true`.

### Seeding test data (dev/UAT only)

`pnpm --filter @aom/server seed:dev -- --dev` fills a running local or UAT stack with realistic test data through its own HTTP API: a super admin (with TOTP set up), the five billing-state organizations (trialing, active with an add-on and a paid invoice, past due, pending cancellation, Unlimited), a populated "Pieter's organization", support tickets, and blog posts. It is idempotent (progress is kept in `~/.config/aom-uat/seed-state.json`) and writes every password, the super admin's TOTP secret and recovery codes, the blog API key and a temporary password to `~/.config/aom-uat/seed-credentials.md` (mode 0600, never committed).

It refuses to run unless **all** hold: the `--dev` flag; the server itself reports `devSeedAllowed: true` on `GET /api/public/plans` (which needs `AOM_DEV_SEED=true`, an `http` `AOM_PUBLIC_ORIGIN` on localhost or a private LAN address, and the fake payment provider); and the reported origin is local. **Never set `AOM_DEV_SEED` on production.** Useful options: `--url` (where to connect, default `http://127.0.0.1:4700`), `--mailpit` (default `http://127.0.0.1:8026`), `--sa-cmd` (the super admin CLI, default `docker exec aom-uat-app-1 node dist/superadmin-create.mjs`), `--psql` (default `docker exec -i aom-uat-postgres-1 psql -U aom -d aom -v ON_ERROR_STOP=1 -At`).

Two things need time or have no API: the first invoices of "Globex Labs" (paid) and "Initech" (declined card, past due) are produced by moving their trial end into the past with one `UPDATE billing_subscriptions` and letting the server's billing tick (every 5 minutes) issue and charge them, so a run takes up to about 6 minutes; and Desk items and "blocked" cards are only raised by agents, so none are seeded until a runner is connected.

**Unverified sign-ups.** A self-service sign-up whose email was never verified blocks that address. The billing job (same switch, `AOM_BILLING_JOBS`) removes such accounts 7 days after sign-up together with the empty organization created for them, so the address can sign up again. Only organizations created by sign-up with no other members, no projects, no paid invoices and no stored card are touched. Each removal is one `SignupAbandoned` event and shows in the platform audit log (system actor).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOM_PAYMENT_PROVIDER` | unset | `paystack`, `payfast` or `fake`. Unset: Paystack when `AOM_PAYSTACK_SECRET_KEY` is set, else PayFast when its keys are set, else fake. Naming a provider without its keys refuses to start. (`AOM_BILLING_PROVIDER` is a deprecated alias.) |
| `AOM_ALLOW_FAKE_PAYMENTS` | `false` | Staging only: allow the fake provider on a public https `AOM_PUBLIC_ORIGIN` (otherwise payments are "not configured": sign-up and card payments are hidden, see above) |
| `AOM_DEV_SEED` | `false` | **Dev/UAT only, never set in production.** Lets `pnpm --filter @aom/server seed:dev -- --dev` fill the stack with test data. `GET /api/public/plans` reports `devSeedAllowed: true` only when this is `true` AND `AOM_PUBLIC_ORIGIN` is plain `http` on localhost or a private LAN address AND the payment provider is the fake one; the script refuses otherwise |
| `AOM_PAYSTACK_SECRET_KEY` | unset | Paystack secret key (`sk_test_...` runs in test mode, `sk_live_...` is live). Also signs and verifies webhooks |
| `AOM_PAYSTACK_PUBLIC_KEY` | unset | Paystack public key (`pk_...`). Kept for the hosted checkout; the current flow redirects to Paystack and does not need it in the browser |
| `AOM_PAYSTACK_CARD_CHECK_ZAR` | `5` | Rand charged and refunded to save a card. `UNVERIFIED`: Paystack's minimum amount for ZAR |
| `AOM_PAYFAST_MERCHANT_ID` / `AOM_PAYFAST_MERCHANT_KEY` | unset | Your PayFast merchant credentials |
| `AOM_PAYFAST_PASSPHRASE` | unset | The salt passphrase set in PayFast; must match exactly, or every signature fails |
| `AOM_PAYFAST_SANDBOX` | `true` | Use PayFast's sandbox (hosted page and API with `testing=true`). Set `false` for live payments |
| `AOM_PAYFAST_CARD_CHECK_ZAR` | `5` | Rand charged and refunded to save a card (PayFast's minimum is R5) |
| `AOM_FX_URL` | `https://open.er-api.com/v6/latest/USD` | JSON source for the USD to ZAR rate (`{"rates":{"ZAR":..}}`); `off` uses only the fallback |
| `AOM_FX_FALLBACK_ZAR` | `18.5` | Rate used when the source is down and no earlier rate exists |
| `AOM_BILLING_JOBS` | `true` | Run renewals, retries, pauses and notices on the scheduler (idempotent). Run it on one instance only |

**Paystack set-up (primary).**

1. **Account.** Create a Paystack account for the South African business (paystack.com/za). Paystack is owned by Stripe; Stripe itself is not available to a South African company.
2. **Business verification.** Submit the company documents Paystack asks for (typically the CIPC registration, SARS tax number, director ID, bank confirmation letter and proof of address). Review is quoted at about 48 hours; the live keys are only issued after approval.
3. **International cards.** Customers pay in rand, but many pay with foreign cards. Ask Paystack (Settings > Preferences or support) to enable **international payments**; approval is separate and can take a few working days. Without it foreign cards are declined.
4. **Keys.** Settings > API Keys & Webhooks. Put the **test** secret key in `AOM_PAYSTACK_SECRET_KEY` (and the public key in `AOM_PAYSTACK_PUBLIC_KEY`) for UAT; switch to the **live** keys for production. The key decides the mode, shown on Platform > Billing as Sandbox or Live.
5. **Webhook URL.** In the same settings page set the webhook URL (one for test mode, one for live) to `https://<your public origin>/api/billing/paystack/webhook`. Paystack signs each call with `x-paystack-signature` (HMAC-SHA512 of the raw body with the secret key); anything with a bad signature is rejected with 400. The reverse proxy must pass the request body through unchanged.
6. **Sandbox pass before live.** With test keys and Paystack's test cards: sign-up, card capture on Paystack's checkout (the webhook and the return both save the card and refund the check), a merchant-initiated charge (let a trial end, or use the test clock), a decline, a webhook replay (harmless), the card update, and a plan change with proration. Then repeat one real payment with a real card on the live keys and check that the settlement arrives.
7. **Invoices.** Platform > Billing > Invoice details: enter the company's registered address, VAT number and registration number (placeholders are printed until you do), and confirm the VAT rate (15%). Have the accountant confirm the printed tax-invoice layout against SARS requirements before the first live invoice.

The Paystack adapter was written from Paystack's public documentation without a merchant account, so these points are `UNVERIFIED` (also marked in `apps/server/src/billing/paystack.ts`) and must be checked in the sandbox: the minimum transaction amount in ZAR for the card check; that `channels: ['card']` and the `authorization.reusable` flag behave as documented for South African cards; the exact `charge_authorization` response for a decline and for a charge that needs further action (anything other than `success` or `failed` is left in `charging` for the webhook or a human); whether Paystack sends `charge.failed` for card charges (it is handled but only reconciles an unknown outcome); that the refund endpoint accepts the numeric transaction id and the `refund.processed` and `refund.failed` event names; the card brand strings in the `authorization` object; and Paystack's own fee for international cards (2.9% or 3.1% + R1: the two official pages disagree).

PayFast set-up (fallback): PayFast is told the notification URL `https://<your public origin>/api/billing/payfast/itn` with each card capture, so keep `AOM_PUBLIC_ORIGIN` exact, and make sure the proxy forwards the real client address (the ITN source check compares it with PayFast's hosts; Fastify runs with `trustProxy`). Enable tokenization on the merchant account. Before going live, run a full sandbox pass: sign-up, card capture and refund of the card check, an ad hoc charge, a decline, and the ITN. The adapter was written from PayFast's public documentation without a merchant account; the signature rules, the ad hoc response shape and refunds are marked `UNVERIFIED` in `apps/server/src/billing/payfast.ts`. Mail uses the normal `AOM_SMTP_URL` and `AOM_MAIL_FROM`. The USD prices (VAT included), limits and add-on prices live in the database and are edited under Platform > Billing, together with the VAT rate (15% by default, taken out of the price), the invoice details and the exchange-rate override. Migration 1490 adds the invoice VAT columns and the billing profiles.

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

### Azure DevOps sign-in on workstations

Azure DevOps personal access tokens that are not scoped to one organization stop working on **2026-12-01**. For workstations (especially cloud ones, which have no browser) use a **Microsoft Entra service principal** or workload identity as the main sign-in: put `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (or `AZURE_FEDERATED_TOKEN_FILE`, plus optionally `AZURE_DEVOPS_ORGANIZATION`) in the runner's environment (service unit, Codespaces secret, VPS env file). The runner exchanges them for an Entra token itself; nothing is sent to the server. The step-by-step setup is in `docs/RUNNER.md` (Git hosts). A PAT scoped to one organization and `az login` stay supported as fallbacks.

### Cloud workstations (VPS over SSH, Codespaces)

Users can run agents on a server of their own (any VPS reached over SSH) or on a GitHub Codespace (`docs/RUNNER.md` "Cloud workstations", `docs/BYO-VPS.md`). What this means for the server:

- **Outbound access.** The app container connects out over SSH (port of the user's VPS) to install the runner, and to `api.github.com` for Codespaces. Nothing inbound is added.
- **`AOM_SECRET_KEY` is required in production** when users connect GitHub: their token is kept encrypted with it (AES-256-GCM). Without the variable a random key is generated in the database, which a database dump would also contain.
- **No SSH password, key or Claude credential is ever stored.** The runner release must be published (`AOM_RUNNER_RELEASE_DIR`), because both the VPS installer and the Codespaces bootstrap download it from this server. `AOM_PUBLIC_ORIGIN` must be the address cloud machines can reach.
- The scheduler wakes and stops Codespaces every 15 seconds; run one server instance, as for the dispatcher.
- Migration `1470_cloud_workstations.sql` adds `cloud_workstations` and `cloud_github_connections` (operational tables).

## Isolation and multi-tenancy

Each organization is sandboxed: members see only their organization's projects, cards and desk (the projects they were added to), and guests see only the projects they were invited to. The server enforces org-scoped queries and authorization checks in every route, and the platform account sees organization metadata only. Tests verify cross-organization isolation.

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
