# GWP-128: core Caddyfile, token filter for Caddy logs and body limits on the public routes

## 1. Question

A self-hoster runs the core stack (`docker-compose.prod.yml`) behind the shipped `deploy/Caddyfile`. Two questions:

1. Can a bearer token reach Caddy's own log? This covers the token path of `/relay/in/<t>` and `/hooks/in/<t>`, the
   `x-form-link` and `x-upload-token` headers, and `Authorization`/`Cookie`.
2. Does the proxy cap the body size of the public, unauthenticated routes?

The owner asked for a check first: what does release/1.6.0 already do? Build only what is missing. The model is the
guildwise-cloud `deploy/Caddyfile` (GWP-69). It is readable at `/data/src/personal/guildwise-cloud/deploy/Caddyfile`, so
I compared against the real file and not a guess.

## 2. State on release/1.6.0 (owner check)

`origin/release/1.6.0` is an ancestor of the card branch. None of the files involved differ between the two
(`deploy/`, `docker-compose.prod.yml`, `docs/SELF-HOSTING.md`, the three route modules, `app.ts`, `config.ts`).

| Item | State | Evidence |
| --- | --- | --- |
| 1. Global log filter (URI token, x-form-link, x-upload-token, Authorization/Cookie/Set-Cookie, query on token routes) | **Missing** | `deploy/Caddyfile` has no global options block and no `log`. Caddy still writes `http.log.error` lines with `request>uri` and `request>headers` for a 502, a 413 or an abort. By default Caddy redacts only `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization` (as `REDACTED`). The token path, the query, `X-Form-Link` and `X-Upload-Token` go out in clear. |
| 2. Per-route `request_body` limits | **Missing** | The Caddyfile has no `request_body`. The compose file also passes no limit variable to the app or to Caddy (see §3.4). |
| 3. Proxy keeps working | n/a (constraint) | Current routes: `encode`, HSTS for non-localhost, `/api/worker/video/*` goes to the video worker, everything else goes to `app:4600` with `health_uri /api/health`. |
| 4. Self-hoster docs | **Partly** | `docs/SELF-HOSTING.md:392` says a proxy must not write an access log for `/relay/in/*` and that the bundled Caddy writes none. Nothing covers redaction, per-route limits or how to change them. |

**Verdict: nothing is done. Build items 1, 2 and 4.** Only one other proxy config ships to self-hosters:
`docker-compose.prod.yml` (`caddy` service, `image: caddy:2`, mounts `deploy/Caddyfile`, lines 116-130). Nothing else exists.

## 3. Findings

### 3.1 App limits per public route (what the proxy must never undercut)

| Route | App limit | Source | Changed by env? |
| --- | --- | --- | --- |
| `GET\|POST /relay/in/:token` | `AOM_RELAY_MAX_BODY_BYTES`, default 1 MiB (1048576), config max `RELAY_BODY_HARD_MAX_BYTES` = 4 MiB | `config.ts:195`, `webhook-relay/route.ts:195-197`, `packages/shared/src/relay/index.ts:24` | yes, at most 4 MiB |
| `POST /hooks/in/:token` | `AOM_JOURNEY_HOOK_MAX_BYTES`, default 65536, **no upper bound** (`envInt`) | `journeys/hooks/route.ts:56`, `:293-295` | yes, unbounded |
| `PUT /api/public/forms/:id/submissions/:sid/parts/:n` (file part, `x-upload-token`) | Streamed, not `bodyLimit`. `Content-Length` must equal the announced part size, which the submission start checked against `AOM_STORAGE_MAX_FILE_BYTES` (default 25 MiB, max 100 MiB). Chunked is refused (411) | `public-forms/routes.ts:592`, `:696-726`, `config.ts:205-210`, `shared/storage/index.ts:49-50` | yes, at most 100 MiB |
| `POST .../submissions`, `POST .../submissions/:sid/complete`, JSON parser | 4 MiB constant `SESSION_BOUND_BODY` | `routes.ts:118`, `:141`, `:574`, `:871` | no |
| `POST .../offline-requests` | 8 KiB | `routes.ts:680` | no |
| `GET /f/:id`, `GET /api/public/forms/:id` (`x-form-link`, `routes.ts:521`), `GET .../logo`, `GET .../submissions/:sid` (`x-upload-token`, `routes.ts:467`) | no body | | |
| everything else | 2 MiB app `bodyLimit` | `app.ts:322` | not touched |

Answers to the planner's open questions: (a) `x-upload-token` goes with the part `PUT`, `GET .../submissions/:sid` and
`POST .../complete` (all through `authorise`, routes.ts:466). `x-form-link` goes with `GET /api/public/forms/:id`.
(b) Yes: `log` + `format filter` and `request_body max_size` are in the standard Caddy 2 image, no plugin needed. On
version, see §3.3. (c) The form JSON limit stays a fixed 4 MiB, the same as the app constant, and the docs say so.

### 3.2 What Caddy logs and how the filter reaches it

- With no `log` directive Caddy writes no access log. It still logs every handler error (`http.log.error`, level ERROR)
  with a `request` object: `remote_ip`, `client_ip`, `proto`, `method`, `host`, `uri` (raw path **and query**),
  `headers`, `tls`. The `msg`/`error` text of a 502 (`dial tcp ...: connection refused`), a 413
  (`http: request body too large`) or an abort (`context canceled`, `unexpected EOF`) holds no URI. So `request>uri` and
  `request>headers>*` are the fields that carry secrets. Bodies are never logged.
- A global `log default { format filter { ... } }` sets the encoder of the default logger. Every logger that is not
  routed elsewhere goes through it, including `http.log.error.*` and the TLS/ACME runtime logs. The filters act only on
  the fields they name, so the runtime logs are unchanged.
- A site-level `log` directive (an access log) creates its **own** logger with its own encoder, and the global filter
  does **not** apply to it. That is why the docs must give an access-log example with the same filter. A config test
  must also check that the shipped file has exactly one `log` block, as the cloud test does.
- Field filters available in the pinned version: `delete`, `replace`, `regexp`, `hash`, `query`, `cookie`, `rename`,
  `ip_mask`. Also `set_cookie` and `multi_regexp`, but only in 2.11.x: they are **not** in 2.10, which the cloud pins. One
  field takes one filter, so the URI rules go into **one** `regexp` with alternation. That works on 2.10 and 2.11 alike,
  and it is the technique the cloud uses.
- Header keys in the log are Go canonical (`X-Form-Link`), and field paths are case-sensitive. The filter must use the
  canonical spelling.

### 3.3 `request_body` behaviour depends on the Caddy version

I read the Caddy sources at each tag:

- **v2.10.x to v2.11.7**: `request_body` only wraps the body in `http.MaxBytesReader`. The 413 comes when a later
  handler reads past the limit. `reverse_proxy` streams, so the app gets the headers first. With proxy and app limits
  equal, the app can answer 413 itself for a declared over-limit body, and Caddy then just passes that 413 along. The
  status is the same, but the 413 is no longer "rejected by Caddy".
- **v2.11.8 and later** (current: v2.11.9, 2026-11-05): `if r.ContentLength > rb.MaxSize { return 413 }` runs before
  `next`. A declared over-limit body is refused at the proxy and never reaches the app. A chunked body is still cut off
  by the `MaxBytesReader`.

The core pins `caddy:2`, a floating major. A self-hoster who pulled it months ago keeps the old image, because
`up -d --build` does not pull images that are already there. **Pin `caddy:2.11`** (it resolves to ≥ 2.11.9). This makes
the AC "rejected by Caddy with 413" deterministic and forces a fresh pull on upgrade. The cloud pins a minor
(`caddy:2.10`) for the same reason.

### 3.4 Side finding: the compose file does not pass the limit variables to the app

`docker-compose.prod.yml` sends the `app` service only the variables it lists, and there is no `env_file`.
`AOM_RELAY_MAX_BODY_BYTES`, `AOM_JOURNEY_HOOK_MAX_BYTES` and `AOM_STORAGE_MAX_FILE_BYTES` are not listed. A self-hoster
who sets them in `.env` (as SELF-HOSTING.md §10 and RUNNER.md:714 tell them to, for Meta's 3 MB payloads) changes
nothing today. The app keeps its defaults.

That matters here. If Caddy reads a variable that the app does not get (or the reverse), the two limits drift apart, and
Caddy could end up below the app. So the three limit variables must go to **both** services with the **same** default,
as the cloud compose does. The same gap exists for the other documented `AOM_RELAY_*`/`AOM_FORMS_*` variables, and for
`AOM_VIDEO_WORKER_PORT` on the caddy service. Those are outside this card and filed as a backlog suggestion.

### 3.5 Secrets in other core URLs

Core `redactUrl` (`app.ts:220-231`) treats more URL parts as secrets than the cloud Caddy filter does. It also covers
invitation tokens (`/invite/<t>`, `/api/invitations/<t>`), one-time desk links (`/m/desk/<t>`, `/api/m/desk/<t>`, also
percent-encoded inside `next=`) and `?token=|code=|invite=|pairing_code=`. The core Caddyfile fronts all of these, so a
502 while the app restarts would log them too. The cloud file's own comment says "the URI rule matches core redactUrl".
Mirroring all of `redactUrl` is the faithful version of that rule, and it costs only more alternatives in the same
`regexp`. RE2 has no look-ahead, so the desk-link alternative over-redacts slightly (it can swallow a following `%2F...`),
which is harmless. The relay kind `calendar_push` (Google) sends its channel token in `X-Goog-Channel-Token`: delete it.
`Referer` is not a risk, because the app sends `Referrer-Policy: no-referrer` (`app.ts:429`, `routes.ts:500`).

## 4. Options compared

| Decision | Options | Choice |
| --- | --- | --- |
| Filter technique | (a) global `log default` + `format filter` with `delete`/`regexp` (cloud) · (b) delete the whole `request>headers` object · (c) `multi_regexp` | **(a)**. It matches GWP-69 and works on 2.10/2.11. (b) is the strongest, but it throws away `User-Agent`/`Content-Type`, which a self-hoster needs to debug a 502, and it diverges from the cloud. (c) needs 2.11 and diverges too. |
| Placeholder | `REDACTED` · `[redacted]` | **`[redacted]`**: the same wording as GWP-69 and core `redactUrl`. The constraint says to stay consistent with GWP-69. |
| URI rules | cloud set only (relay, hooks, `/f/`, `/api/public/forms/`) · full `redactUrl` mirror | **Full mirror**, case-insensitive `(?i)` (Caddy path matchers are case-insensitive, and so is `redactUrl`). The cloud gap is filed as a backlog suggestion. |
| Relay limit | (a) `{$AOM_RELAY_MAX_BODY_BYTES:1048576}`, equal to the app · (b) fixed **4MiB**, the app's hard ceiling | **(b)**. It is ≥ every value the app accepts (config refuses > 4 MiB), so legitimate traffic is never cut, whatever the env says. The app keeps recording `rejected_size` in the relay activity for bodies between its limit and 4 MiB, a diagnostic a firm debugging Meta payloads needs. With (a) on 2.11.8+ those rows would disappear. |
| Hook limit | env-matched · fixed | **env-matched** `{$AOM_JOURNEY_HOOK_MAX_BYTES:65536}`: the app has no upper bound, so no fixed value is safe. Same as GWP-69. Trade-off, documented: a declared over-limit hook body now stops at the proxy, so it no longer shows as a `too_large` call on the Journeys page. |
| Form limits | — | Part `PUT` = `{$AOM_STORAGE_MAX_FILE_BYTES:26214400}`. Rest of `/api/public/forms/*` = `4MiB`. Same as GWP-69. |
| Part vs JSON precedence | cloud: `handle @formPart` placed before `handle /api/public/forms/*` (it relies on stable sort order) · two mutually exclusive `request_body` matchers inside one `handle` | **Mutually exclusive matchers.** The Caddyfile sort keeps a named matcher and a single-path matcher in file order today (issue #5037 logic), but the safety of the file-part limit should not depend on that. With `@formPart` and `not path_regexp` the order no longer matters. |
| Caddy image | `caddy:2` · `caddy:2.11` · `caddy:2.11.9` | **`caddy:2.11`** (§3.3). |

## 5. Design

### 5.1 `deploy/Caddyfile` (target; the builder confirms it with `caddy validate`/`caddy adapt` on `caddy:2.11`)

```caddyfile
# TLS terminator and reverse proxy for the app container.
# (keep the existing AOM_DOMAIN comment lines)
{
	# Caddy logs handler errors (a 502 while the app restarts, a 413, a client abort) with the request URI and headers,
	# even without an access log. Secrets travel in some of them: delete or redact them in every log line. The URI rule
	# matches redactUrl in apps/server/src/app.ts; keep the two in step.
	log default {
		output stderr
		format filter {
			wrap json
			fields {
				request>headers>X-Form-Link delete
				request>headers>X-Upload-Token delete
				request>headers>X-File-Name delete
				request>headers>X-Guildwise-Signature delete
				request>headers>X-Hub-Signature-256 delete
				request>headers>X-Signature delete
				request>headers>X-Goog-Channel-Token delete
				request>headers>Idempotency-Key delete
				request>headers>X-Guildwise-Delivery delete
				request>headers>Cookie delete
				request>headers>Authorization delete
				request>headers>Proxy-Authorization delete
				resp_headers>Set-Cookie delete
				request>uri regexp "(?i)(/(?:relay|hooks)/in/)[^#]*|(/(?:f|api/public/forms|api/invitations|invite)/)[^/?#]+|((?:/|%2F|%252F)m(?:/|%2F|%252F)desk(?:/|%2F|%252F))(?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f][0-9A-Fa-f])+|([?&](?:token|code|invite|pairing[_-]?code)=)[^&#]*" "${1}${2}${3}${4}[redacted]"
			}
		}
	}
}

{$AOM_DOMAIN:localhost} {
	encode zstd gzip
	# No access log on purpose. If you add one, give it the same `format filter` as the global log above
	# (docs/SELF-HOSTING.md "Proxy logs and body limits"): a site `log` does not use the global filter.
	# (keep the HSTS lines and the video-worker handle exactly as they are)

	# Public form API. A file part is one raw PUT with an exact Content-Length, streamed to the app (no request_buffers:
	# Caddy never writes a body to disk). Its ceiling is the variable the app enforces. Everything else there is JSON, at
	# most 4 MiB in the app. The two matchers exclude each other, so their order does not matter.
	handle /api/public/forms/* {
		@formPart path_regexp ^/api/public/forms/[^/]+/submissions/[^/]+/parts/[0-9]+$
		@formJson not path_regexp ^/api/public/forms/[^/]+/submissions/[^/]+/parts/[0-9]+$
		request_body @formPart {
			max_size {$AOM_STORAGE_MAX_FILE_BYTES:26214400}
		}
		request_body @formJson {
			max_size 4MiB
		}
		reverse_proxy app:4600
	}
	# Inbound journey webhooks: the same limit as the app (AOM_JOURNEY_HOOK_MAX_BYTES).
	handle /hooks/in/* {
		request_body {
			max_size {$AOM_JOURNEY_HOOK_MAX_BYTES:65536}
		}
		reverse_proxy app:4600
	}
	# Inbound webhook relay: the app's own limit (AOM_RELAY_MAX_BODY_BYTES) can be at most 4 MiB, so the proxy caps at
	# 4 MiB and the app refuses (and records) anything between its setting and that.
	handle /relay/in/* {
		request_body {
			max_size 4MiB
		}
		reverse_proxy app:4600
	}

	# WebSocket upgrades (/api/ws, /api/runner/ws) pass through reverse_proxy unchanged.
	handle {
		reverse_proxy app:4600 {
			health_uri /api/health
			health_interval 15s
		}
	}
}
```

Notes for the builder:

- In a Caddyfile, `{$VAR:default}` is parse-time env substitution. `${1}` is not (no `{$`), and the cloud file already
  ships `${1}${2}`. The pattern has no `{n}` quantifier on purpose (`[0-9A-Fa-f][0-9A-Fa-f]`), so a brace can never be
  read as a placeholder. Use no backslashes (the `-` sits last in the class).
- If `caddy adapt` rejects `request_body @matcher { ... }` (it should not: `request_body` takes a matcher like any
  directive), fall back to the cloud shape: `handle @formPart` first, then `handle /api/public/forms/*`. Then check in the
  adapted JSON that the part route comes first.
- The new `handle` blocks use a plain `reverse_proxy app:4600` (no active health check), as in the cloud. Each
  `reverse_proxy` with `health_uri` starts its own checker, and one is enough.
- `/relay/in` with no trailing segment is not matched. It reaches the catch-all, and the app answers 404 without reading
  a body. That is unchanged.
- Leave `output stderr` and `wrap json` in place. Without a TTY the default is already JSON on stderr, so
  `docker compose logs caddy` looks the same as before.

### 5.2 `docker-compose.prod.yml`

- `caddy`: change `image: caddy:2` to `image: caddy:2.11`. Add to `environment` (with a comment saying these are the same
  values as the app):
  `AOM_STORAGE_MAX_FILE_BYTES: ${AOM_STORAGE_MAX_FILE_BYTES:-26214400}` and
  `AOM_JOURNEY_HOOK_MAX_BYTES: ${AOM_JOURNEY_HOOK_MAX_BYTES:-65536}`.
- `app`: add the same two lines, plus `AOM_RELAY_MAX_BODY_BYTES: ${AOM_RELAY_MAX_BODY_BYTES:-1048576}`, so the documented
  overrides reach the app. The defaults are the app's own defaults, so behaviour does not change for anyone who has not
  set them. The `:-` form also turns an empty value into the default.
- Nothing else changes: ports, volumes, `depends_on`.

### 5.3 `.env.prod.example`

Add an optional, commented block: "Body limits shared by the app and the proxy". It lists the three variables with
their defaults and maxima (relay ≤ 4194304, file ≤ 104857600) and a pointer to the SELF-HOSTING section.

### 5.4 `docs/SELF-HOSTING.md`

GWP-137 also edits this file. Keep the edits to the places below and do not reword other sections.

- §7 HTTPS and domains: add a new subsection **"Proxy logs and body limits"** at the end of §7, after the local-test
  example. It covers:
  - What is redacted: every Caddy log line goes through the global filter, which deletes the headers listed in §5.1 and
    replaces with `[redacted]` the secret part of `/relay/in/…` and `/hooks/in/…` (including the query),
    `/f/<id>`, `/api/public/forms/<id>`, `/invite/<t>`, `/api/invitations/<t>`, `/m/desk/<t>` and `token`/`code`
    query values.
  - A table of per-route limits: relay 4 MiB fixed (app limit `AOM_RELAY_MAX_BODY_BYTES`); hooks
    `AOM_JOURNEY_HOOK_MAX_BYTES` (default 64 KiB); form file part `AOM_STORAGE_MAX_FILE_BYTES` (25 MiB); rest of the form
    API 4 MiB fixed. Over the limit, Caddy answers `413`.
  - How to change them: set the variable in `.env` and run `docker compose -f docker-compose.prod.yml up -d`. Compose
    passes it to both the app and Caddy, so the two stay equal. Do not set different values for the two.
  - Access log: a site `log` directive does not use the global filter. If you add one, copy the `format filter` block.
    Show a full example (`log { output file /data/access.log  format filter { wrap json  fields { … same lines … } } }`).
    For your own proxy in front: delete the same headers and do not log the URI of those routes.
  - Trade-off: a journey webhook over the limit is refused by the proxy and does not appear as a call on the
    Journeys page.
- §10 Inbound webhook relay: replace line 392. The bundled Caddy now logs only errors, through the filter that redacts
  the address and query. A proxy of your own must do the same or log nothing for `/relay/in/*`. Add to the
  `AOM_RELAY_MAX_BODY_BYTES` row: "the bundled proxy caps this route at 4 MiB".
- §10 Public forms: add a bullet linking to the new subsection for the proxy limits (file part = `AOM_STORAGE_MAX_FILE_BYTES`,
  JSON 4 MiB).
- §8 Upgrades: one line saying a release that changes the Caddy image tag is picked up by
  `docker compose -f docker-compose.prod.yml pull caddy` (or `up -d --pull always`).
- `CHANGELOG.md` (Unreleased, if the file has that section): one line on the proxy log filter and body limits.

### 5.5 Tests (builder)

New pure-file test `apps/server/test/deploy-proxy-config.test.ts` (vitest). It reads `deploy/Caddyfile`,
`docker-compose.prod.yml` and `.env.prod.example` relative to `import.meta.dirname`. Model it on the cloud's
`server/test/hosted-edge-config.test.ts` (strip comments, a balanced-block helper). It asserts:

1. Exactly one `log` block in the Caddyfile, and it is `log default` inside the global block. Every header in §5.1 has
   `request>headers>X delete`, and there is `resp_headers>Set-Cookie delete`.
2. URI rule. Extract the pattern and the replacement. Drop the leading `(?i)` and compile with flags `gi`. Turn
   `${n}` into `$n`. Assert:
   `/relay/in/rly_FAKE?hub.verify_token=FAKEV` → `/relay/in/[redacted]`, `/hooks/in/FAKE-HOOK` →
   `/hooks/in/[redacted]`, `/RELAY/IN/FAKE` → redacted, `/f/FAKE` → `/f/[redacted]`,
   `/api/public/forms/FAKE/submissions/s/parts/1` → `/api/public/forms/[redacted]/submissions/s/parts/1`,
   `/api/m/desk/FAKE/apply`, `/login?next=%2Fm%2Fdesk%2FFAKE`, `/invite/FAKE`, `/api/invitations/FAKE/accept`,
   `?code=FAKE&x=1` → `code=[redacted]&x=1`; `/api/health`, `/api/ws`, `/assets/x.js` unchanged. No output contains
   `FAKE`.
   **Parity check:** for the same sample list, the Caddy rule and `redactUrl` (imported from `../src/app`) both remove
   every `FAKE` value. Do not compare strings exactly, because the desk rule over-redacts on purpose. This catches a
   future `redactUrl` rule that the proxy is missing.
3. Limits. `/api/public/forms/*` holds `@formPart` with `max_size {$AOM_STORAGE_MAX_FILE_BYTES:26214400}` and the
   negated matcher with `max_size 4MiB`. The two regexes are identical. `handle /hooks/in/*` →
   `{$AOM_JOURNEY_HOOK_MAX_BYTES:65536}`. `handle /relay/in/*` → `4MiB`.
   **Parity with the app:** the Caddy defaults equal the app defaults. Import `STORAGE_MAX_FILE_BYTES` and
   `RELAY_BODY_HARD_MAX_BYTES` from `@aom/shared` (as `config.ts` does), check 4 MiB ==
   `RELAY_BODY_HARD_MAX_BYTES`, and check 65536 against the literal default in `journeys/hooks/route.ts` (read the file).
4. Streaming and regression: no `request_buffers|response_buffers`, no `header_up` on `Content-Length`/
   `Transfer-Encoding`. Still present: `{$AOM_DOMAIN:localhost} {`, `encode zstd gzip`, the HSTS line,
   `handle /api/worker/video/*` with `video-worker:{$AOM_VIDEO_WORKER_PORT:4610}`, and the catch-all `reverse_proxy app:4600`
   with `health_uri /api/health`.
5. Compose: `caddy` uses `image: caddy:2.11`. `app` and `caddy` both carry the two shared variables with identical
   `:-` defaults. `app` carries `AOM_RELAY_MAX_BODY_BYTES: ${AOM_RELAY_MAX_BODY_BYTES:-1048576}`.

Static validation: there is no `caddy` binary on the workstation. Run
`docker run --rm -e AOM_DOMAIN=localhost -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
and the same with `caddy adapt --pretty`. If the sandbox refuses Docker, ask DevOps to run it. Check the adapted JSON:
`logging.logs.default.encoder.format == "filter"`, the `request_body` handlers on the four routes, and no adapter
warnings except the usual "not formatted" one (run `caddy fmt --overwrite` locally on a copy, or fix the tabs).

Runtime checks (test plan steps 2-7: stopped upstream, 413, abort, access log, legitimate sizes, regression) need a
running stack. They are left to testers/DevOps per standing orders, using `FAKE-` sentinels and
`docker compose logs caddy | grep FAKE-`.

## 6. Risks

- **Over-strict limits.** The proxy is always ≥ the app: relay 4 MiB ≥ the app maximum, hooks/file equal by a shared
  variable, JSON 4 MiB equal to the constant. `>` vs `>=` match too (Caddy refuses `ContentLength > max`, Fastify refuses
  `> bodyLimit`), so exactly-at-limit passes both.
- **Drift.** If someone changes an app default or adds a `redactUrl` rule, the parity tests in §5.5 fail.
- **Access log added later without the filter.** This is documented, and the test forbids a second `log` in the shipped
  file. A self-hoster's own edit is their responsibility, so the docs say it plainly.
- **Image pin.** `caddy:2.11` stops automatic jumps to a future 2.12. That is intentional: a new minor is a deliberate
  bump.
- **Unknown provider secret headers** on `generic`/`webhook_in` relay kinds. The explicit delete list covers the known
  ones. The docs tell a self-hoster to add a `delete` line for any custom secret header.
- **Unchanged areas.** TLS/ACME, `encode`, HSTS, the video worker, WebSocket/SSE and static assets all stay on the
  untouched catch-all or their existing handles. `request_body` only wraps bodies on the four public prefixes.

## 7. Acceptance criteria → design

| AC | Covered by |
| --- | --- |
| Card records state on release/1.6.0 per item | §2, also posted as a card comment |
| `caddy validate`/`adapt` pass | §5.1 + static validation in §5.5 |
| Relay/hook token never in a 502/413/abort log line | URI `regexp` (path + query) §5.1; test §5.5-2; runtime check by tester |
| x-form-link / x-upload-token / Authorization / Cookie never logged | header `delete` lines §5.1; test §5.5-1 |
| Access log redacted the same way | docs example with the same filter §5.4; single `log` test §5.5-1; `resp_headers>Set-Cookie delete` |
| Over `max_size` → 413 by Caddy, redacted | `request_body` per route §5.1; `caddy:2.11` up-front check §3.3; filter applies to `http.log.error` |
| At/under app limit passes | §3.1 limits, §6 first bullet; tests §5.5-3 |
| Other routes unchanged | §5.1 keeps catch-all/video/HSTS/encode; test §5.5-4 |
| Docs describe redaction, limits, how to change | §5.4 |

## 8. Out of scope / follow-ups (filed as backlog suggestions)

- The core `docker-compose.prod.yml` does not pass the documented `AOM_RELAY_*`, `AOM_FORMS_*` and other optional
  variables to the app, or `AOM_VIDEO_WORKER_PORT` to Caddy, so `.env` settings for them are silently ignored. This card
  fixes only the three limit variables.
- Cloud parity: the guildwise-cloud Caddyfile filter does not cover the invitation/desk/query-token rules,
  `X-Goog-Channel-Token`, or upper-case paths. It has no `/relay/in/*` limit, and on `caddy:2.10` its 413 is not
  guaranteed to come from the proxy.
- App-side logging: no gap found. `redactUrl` covers all four public prefixes, and the part route logs at `silent`.
