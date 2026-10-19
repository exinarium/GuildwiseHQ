# Problems the owner meets become blog research topics

Status: design, 2026-10-19. Branch `lean-team-v3`. Nothing here is built yet. It builds on
`docs/design/ceo-front-door.md` (the job log, repeats, corrections and Step 1 events) and on the server-side blog
writer (`docs/BLOG-API.md` "The blog writer", `apps/server/src/blog/writer/*`).

---

## 0. What exists today (from the code)

- **The blog writer is a platform job, not an agent.** It needs no org, no workstation and no key
  (`blog/writer/run.ts` `executeRun`). Each run is one `messages.create` call. Its **only tool is web search** (at most 5
  searches). The input is built by `writerUserPrompt({today, topic, existing})` (`blog/writer/prompt.ts`): the topic
  string plus the titles and slugs of the last 80 posts. The answer is a JSON post, and it is submitted as `in_review`
  through `submitPost` with origin `{system:'blog-writer'}`.
- **Topics are a flat string list** in `platform_settings.blog_writer_topics`, edited in Platform > Blog > Writer, with
  `DEFAULT_WRITER_TOPICS` as the seed. `pickTopic` takes the topic used longest ago, based on `blog_writer_runs.topic`.
  There is no queue, no topic id and no link from a post back to its topic.
- **The writer cannot reach back into anything.** It has no database, vault, MCP or org access. The firewall therefore
  comes down to *what text goes into the topic string*. This design keeps that property and enforces it.
- **The platform org** is the organization designated in `platform_settings['platform.team']`
  (`platform-team/settings.ts`, `getPlatformTeam`). `detectors.ts` already separates "the platform" from "client orgs"
  (`clientOf`). The blog itself belongs to no org (super admin, `/platform/blog`).
- **Problem signals the CEO can see** (after front-door Step 1): `CeoOffboardJobLogged` and `CeoRepeatDetected`,
  `CeoCorrected`, loop-breaker desk items (`loop_parked`, `commands/loop-breaker.ts`), `DevOpsRequestCompleted{failed}`, and
  `DeployRunFinished` once front-door Step 2 lands. `topicWords` (`packages/shared/src/hr/index.ts`) is the existing
  overlap function.
- **Migrations.** The highest file is `2212_card_status_held.sql`, and `ceo-front-door.md` reserves **2220 to 2229**. This
  design uses **2230** (and reserves up to 2239).

## 1. Decision summary

| # | Decision | Rejected alternatives |
|---|---|---|
| T1 | **Two separate stores with a one-way, text-only bridge.** The org side (`ceo_topic_candidates`) keeps evidence references and stays inside the org. The platform side (`blog_topics`) holds only `{topicId, question, area, origin}`: no org id, no evidence, no causation link. | One shared table with an `org_id` column: a single query joins the blog to its source. |
| T2 | **The CEO writes the generic question. Code checks it.** A deterministic scrubber (`scrubTopic`) is the gate, and a branded `ScrubbedTopic` type is the only input the hand-off accepts. | Rely on prompt instructions: not enforceable. A classifier alone: not deterministic, and it costs tokens on every proposal. |
| T3 | **The owner reviews by default.** A topic crosses only on an explicit Owner (or Admin) Accept, with the question text editable before accepting. There is no auto-accept in v1. | Auto-send after scrubbing: the owner asked for review "at least by default", and one leak is not reversible. |
| T4 | **Per-org opt-in. The platform org is on, every other org is off.** Customer orgs never send anything unless their Owner switches sharing on (a recorded consent). Even then, every topic is owner-reviewed and arrives with `origin:'customer'` and no org identity. | Collect for everyone and filter later: collection itself is the risk. Super-admin switch per org: the consent must come from the org's Owner. |
| T5 | **The writer picks queued topics first, and the rotation is the fallback.** At most one queued topic per day by default, so that the blog does not turn into a single theme. | A separate writer for topics: duplicates the cost cap, the slots and the validation. |
| T6 | **Status flows back by projection on `topicId`.** The writer and the platform side never learn the org. Only the org-side projection matches its own `topic_id` to blog events. | A callback event to the org stream from the platform side: it needs the org id on the platform side. |
| T7 | **Collection is deterministic and generalisation is the CEO's.** Signals create *problem notes*. The CEO turns notes into questions during its daily review wake (and in owner turns when he says "that's a blog topic"). | LLM clustering over all events: cost, and not repeatable. |

## 2. Lifecycle

```
signal (job log, repeat, correction, deploy fail, loop breaker, desk answer)
  -> problem note (org side, deterministic, evidence ids)                  ceo/topics.ts noteSignals()
  -> CEO proposes a generic question  `aom ceo topic propose`               wake or owner turn
  -> scrubTopic(): reject | ok (+ findings)                                 packages/shared/src/blog/topic-scrub.ts
  -> dedupe (org side): merge into an open candidate, or new candidate
  -> owner review: daily report section + one coalesced desk item           Accept / Edit+Accept / Reject
  -> CeoTopicReviewed{accepted}  (org stream, user actor)
  -> hand-off sweep (after commit): re-scrub, dedupe against the platform
     queue and published titles, append BlogTopicQueued (platform stream, system actor)
  -> writer: pickTopic() takes the oldest queued topic -> run -> BlogPostSubmitted{topicId}
  -> super admin publishes (review or hold window) -> BlogPostPublished
  -> projection: blog_topics.status=published; ceo_topic_candidates (same topic_id) = published + slug
  -> CEO daily report: "Published from your topics" (link to /blog/<slug>)
```

### 2.1 Collection (`ceo/topics.ts`, run from the reporter or signals sweep)

A *problem note* is cheap and stays inside the org. It never leaves.

| Source | Becomes a note when |
|---|---|
| `CeoOffboardJobLogged` | `kind` is not in the routine list (`db-query`, `release-notes`, ...), or the job took more than 20 minutes |
| `CeoRepeatDetected` | always (a repeated struggle is the best topic signal) |
| `CeoCorrected` | the correction concerns a class in `deploy`, `devops`, `agent`, `staffing` |
| Loop breaker | a `loop_parked` desk item is resolved |
| DevOps or deploy failure | `DevOpsRequestCompleted{status:'failed'}`, or `DeployRunFinished` failed (front-door Step 2) |
| Desk | a blocking desk item the owner answered after more than 4 hours |

Notes are rows in `ceo_topic_candidates` with `status='note'` (no question yet). The CEO's daily review brief lists
up to 10 open notes as **quoted data** (front-door rule D12), and the instruction is: "For each note that is a problem
other developers likely meet, propose one research question in generic terms. Never name a project, customer, person,
repository, product of ours, host or ticket. Ask a question; do not describe our solution." A note that is not proposed
within 14 days expires (`status='expired'`).

### 2.2 The topic record (what may cross)

```ts
// packages/shared/src/blog/topic.ts
TopicProposal = {
  question: string,   // 30..160 chars, ends with '?', one sentence. "How can AI agents authorize production deploys without bypassing safety checks?"
  area: TopicArea,    // enum: deploy | sandbox | auth | secrets | agent-loops | context-limits | cost | testing | review | integrations | other
  audience?: 'developer' | 'ops' | 'founder',
}
```

That is the whole payload. There is no free-text "context", no "what we tried" and no example. The writer gets
`question` and `area`, nothing else.

## 3. Scrubbing and enforcement

### 3.1 `scrubTopic(proposal, denyList): {ok:true, topic:ScrubbedTopic, findings} | {ok:false, findings}`

The function is pure and lives in shared (`packages/shared/src/blog/topic-scrub.ts`). It returns findings with a reason
code, and any hard finding rejects the topic:

- **Shape:** question length 30 to 160, one sentence, ends with `?`, ASCII letters plus basic punctuation only, at most 3
  digits in total, `area` in the enum.
- **Identifier patterns:** URLs, e-mail addresses, IPs, host-like tokens (`a.b.c`, `:port`), file paths (`/`, `\`, `~`),
  ticket keys (`[A-Z]{2,}-\d+`), uuids and hex runs of 8 or more, `@handles`, quoted strings, backticks, braces,
  `=`, `;`, `$`, CLI flags (`--x`), camelCase and snake_case tokens.
- **Org deny-list (built on the server per org, never shipped to the writer):** org name, project names and keys, repo
  names, vault names, agent names, member names and e-mail local parts, workstation names, deploy target hosts, support
  and customer contact names, intake source names. Matching is case-insensitive on whole words, plus fuzzy matching for
  names of 5 letters or more (edit distance 1).
- **Proper-noun gate:** every capitalised word that is not sentence-initial must be on the **public-terms allow-list**
  (`packages/shared/src/blog/public-terms.ts`: Docker, Kubernetes, GitHub, OAuth, Claude Code, Postgres, AWS, ...). An
  unknown proper noun is a hard finding that the owner can override per topic (see 3.2). The override adds the word to
  the org's allow-list only after a second confirmation.
- **Narrative gate:** first-person and possessive phrasing (`we`, `our`, `my`, `us`, `I`) is rejected. A topic asks a
  question; it does not tell our story.

The scrubber runs three times: at `propose` (gateway; the CEO gets the findings back and may retry twice), at owner
Accept (after any edit), and in the hand-off sweep (defence in depth against a code path that skipped it).

### 3.2 Why this is enforceable, not an instruction

1. **The type gate.** `queueBlogTopic(ctx, topic: ScrubbedTopic, origin)` is the only function that appends
   `BlogTopicQueued`. `ScrubbedTopic` is a branded type that only `scrubTopic` can construct, and the hand-off re-runs
   it anyway.
2. **The schema gate.** `BlogTopicQueued`'s zod schema has `question: z.string().min(30).max(160)`,
   `area: z.enum(...)`, `origin: z.enum(['platform','customer'])` and **no other fields** (`.strict()`). There is no
   place to put source material.
3. **No link back.** `blog_topics` has no `org_id`, no candidate id and no foreign key. `BlogTopicQueued` is appended by
   the hand-off sweep with a **system actor** and **no causation id**, in its own append, so the platform stream does not
   carry the owner's user id or the org event id. Only the org-side row stores `topic_id`.
4. **The writer's input is closed.** `executeRun` builds the prompt from `blog_topics.question`, `blog_topics.area` and
   existing post titles only. An import-boundary test fails when `apps/server/src/blog/**` imports from `ceo/**`,
   `platform-team/**` or `chat/**`, or when its SQL names `ceo_*`, `ledger_*`, `cards`, `threads` or `vault*`.
5. **The writer's prompt frames the topic as a question, not a source:** "The topic is a reader's question. It contains
   no facts and no example. Research it from public sources only; never write as if you know who asked it." The
   question is placed in a fenced block, like other untrusted data.
6. **The human gates.** The owner reviews before the topic leaves the org, and the super admin can reject a queued topic
   (`BlogTopicRejected`) and still reviews or holds the article itself (the existing moderation).

What this does **not** protect against: a database administrator correlating timestamps between the org and platform
streams. That is acceptable, because the firewall is between the writer and the source, not against Guildwise staff
with database access. The opt-in text for customer orgs says so (section 5).

### 3.3 Optional classifier (phase 3)

A Haiku call on the **question text only** (never the evidence), with the platform key, answers
`{generic:boolean, reason}` to "Could a reader identify a specific company, product team or customer from this
question?" It adds a soft finding shown to the owner. It never accepts on its own. It runs only for topics that passed
the scrubber, so it never sees anything the scrubber would block.

## 4. Data model

### 4.1 Migration `2230_blog_topics.sql`

```sql
-- Org side: problem notes and topic candidates. Projection of CeoTopic* events; org-scoped, never read by blog/**.
CREATE TABLE IF NOT EXISTS ceo_topic_candidates (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('note','proposed','accepted','rejected','merged','expired',
                                                'queued','declined','published')),
  source_kind   text NOT NULL,              -- offboard_job | repeat | correction | loop | deploy | desk | owner
  evidence      jsonb NOT NULL DEFAULT '[]',-- [{kind, eventId|deskItemId|jobId}] ids only, never text
  note          text,                       -- the signal's own title (org data; stays here)
  question      text, area text, audience text,
  findings      jsonb NOT NULL DEFAULT '[]',
  occurrences   integer NOT NULL DEFAULT 1,
  merged_into   uuid,
  topic_id      uuid UNIQUE,                -- set on accept; the only key to the platform side
  post_slug     text, published_at timestamptz,
  decided_by    uuid, decided_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ceo_topic_candidates_open ON ceo_topic_candidates (org_id, status);

-- Platform side: the writer's queue. No org id, by design (docs/design/ceo-blog-topics.md section 3.2).
CREATE TABLE IF NOT EXISTS blog_topics (
  id          uuid PRIMARY KEY,               -- topicId
  question    text NOT NULL, area text NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('platform','customer')),
  status      text NOT NULL CHECK (status IN ('queued','writing','drafted','published','declined','rejected','duplicate')),
  reason      text, post_id uuid, run_id uuid,
  queued_at   timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_topics_queue ON blog_topics (queued_at) WHERE status = 'queued';

ALTER TABLE blog_writer_runs ADD COLUMN IF NOT EXISTS topic_id uuid;               -- operational, as the table is
ALTER TABLE organizations    ADD COLUMN IF NOT EXISTS blog_topic_sharing boolean NOT NULL DEFAULT false;
```

Both new tables are projections (add them to `PROJECTION_TABLES` and the saved lists). `blog_topics` is mirrored in
`platform_audit_log` like the other blog events.

### 4.2 Events (all new, or new optional fields)

| Event | Stream | Payload |
|---|---|---|
| `CeoTopicNoted` | `ceo-<orgId>` | `{candidateId, sourceKind, evidence[], note}` |
| `CeoTopicProposed` | `ceo-<orgId>` | `{candidateId, question, area, audience?, findings[], by:'ceo'\|'owner'}` |
| `CeoTopicMerged` | `ceo-<orgId>` | `{candidateId, intoId}` (bumps `occurrences`, unions evidence) |
| `CeoTopicReviewed` | `ceo-<orgId>` | `{candidateId, decision:'accepted'\|'rejected', question?, topicId?, by}` (`question` set when edited) |
| `CeoTopicExpired` | `ceo-<orgId>` | `{candidateId}` |
| `OrgBlogTopicSharingSet` | `org-<orgId>` | `{orgId, enabled, by, consentVersion}` (Owner only; mirrors `OrgTwoFactorPolicySet`) |
| `BlogTopicQueued` | `blog-topics` | `{topicId, question, area, origin}` (strict; system actor; no causation) |
| `BlogTopicRejected` | `blog-topics` | `{topicId, reason, by}` (super admin) |
| `BlogTopicDeclined` | `blog-topics` | `{topicId, reason, runId}` (the writer's `problem` field: no public sources) |
| `BlogTopicDuplicate` | `blog-topics` | `{topicId, postId}` (the hand-off found an existing post) |
| `BlogPostSubmitted.topicId?` | existing | optional; set by the writer for a queued topic |

The projections set `blog_topics.status` from `BlogPostSubmitted{topicId}` (drafted), `BlogPostPublished` (published)
and `BlogPostRejected` (back to `queued` once, then `declined`). The **org-side projection** listens to the same blog
events plus `BlogTopic*` and updates `ceo_topic_candidates WHERE topic_id = $1`. This read runs inside the projector;
the writer is not involved.

### 4.3 Deduplication

- **Org side, at propose:** same `area`, and `topicWords` overlap of 0.6 or more with a candidate in `proposed`,
  `accepted`, `queued` or `published` within 180 days, becomes `CeoTopicMerged`. A merged-into candidate that is still
  `proposed` shows "seen N times" to the owner, which helps him decide.
- **Platform side, in the hand-off:** overlap of 0.6 or more with a `queued` topic or a published post title within 180
  days becomes `BlogTopicDuplicate` (the org side shows "already covered: <link>"). This compares question text only.
- **Notes:** one open note per `(org, source_kind, subject)` (for example a repeat key or a card id), coalesced as
  `openItemForSubject` does for desk items.

## 5. Opt-in and other orgs

- **The platform org** (`getPlatformTeam().orgId`): collection is on, and `origin='platform'`. No consent step is needed;
  the owner is the super admin.
- **Any other org:** nothing is collected while `organizations.blog_topic_sharing` is false (the default). The CEO's
  `topic` verbs answer `sharing_off`, and `noteSignals` skips the org. The Owner turns it on in Settings > CEO >
  "Suggest research topics to the Guildwise blog", which shows the consent text (versioned): what leaves (one generic
  question per accepted topic), what never leaves, that each topic needs his Accept, and that Guildwise staff with
  database access could correlate timing. Turning it off withdraws the queued topics that have not been written yet
  (`BlogTopicRejected{reason:'withdrawn'}`, appended by the sweep from the org's list of `topic_id`s).
- **Plan limits:** customer topics are capped at 4 a month per org at the hand-off, so one org cannot steer the blog.

## 6. UI touchpoints

| Where | What |
|---|---|
| CEO daily report (`ceo/report.ts`) | Section **"Research topics from this week"**: each proposed topic with its area, "seen N times" and the evidence kinds (not the text). Buttons: **Accept**, **Edit**, **Reject**. A second section, **"Published from your topics"**, shows titles linked to `/blog/<slug>` |
| Desk | One coalesced, non-blocking item, subkind `ceo_blog_topics`, subject `blog-topics:<orgId>`: "3 research topics to review". It opens the Topics tab. It is resolved when nothing is left in `proposed` |
| `/ceo` Topics tab (new) | Lists by status: proposed, queued, published, declined. Edit runs the scrubber live and shows findings inline. Evidence links open the source job, correction or desk item (org-internal) |
| CEO chat | "Make that a blog topic" leads to `aom ceo topic propose` in an owner turn. The CEO shows the scrubbed question as a card with Accept |
| Settings > CEO | The opt-in toggle (customer orgs) with the consent text. In the platform org it shows as on, with a note |
| Platform > Blog > Topics (new tab) | The queue (question, area, origin bucket, queued at, status), **Reject** with a reason, **Move up**. No org shown, ever. Platform > Blog > Writer gains "Queued topics per day" (default 1) |

## 7. Plugging into the blog writer

- `pickTopic(ctx, s)` becomes: when `queuedToday < s.queuedPerDay` and a `blog_topics` row is `queued`, take the oldest
  one (`FOR UPDATE SKIP LOCKED`), set it to `writing`, and record `blog_writer_runs.topic_id`. Otherwise use the existing
  rotation.
- `writerUserPrompt` gains `{topicKind:'rotation'|'question', area?}`. For a question, it adds the framing from 3.2(5)
  and asks for a `how-to` or `llm-ops` tag where it fits.
- On success, `submitPost(..., {system:'blog-writer', topicId})`. When the model returns `problem`, append
  `BlogTopicDeclined{reason}`. On a technical failure, the topic goes back to `queued`, and after 2 failures it becomes
  `declined`.
- The duplicate-title check stays. The cost cap, slots and moderation are unchanged: a topic article is an ordinary
  post that the super admin reviews or that the hold window publishes.

## 8. Phased plan

### Phase 1: platform side and the writer (no CEO yet; the super admin can type questions)
- Migration `2230_blog_topics.sql`.
- Shared: `ids.ts` (`streamId.blogTopics()`), `blog/topic.ts` (schema, `TopicArea`), `blog/topic-scrub.ts`, `blog/public-terms.ts`, `events/blog.ts`
  (`BlogTopic*`, `BlogPostSubmitted.topicId?`).
- Server: `blog/topics.ts` (`queueBlogTopic`, platform dedupe, withdraw); `projections/blog.ts` (`blog_topics`);
  `blog/writer/run.ts` (`pickTopic`, declined path); `blog/writer/prompt.ts`; `blog/writer/settings.ts`
  (`queuedPerDay`); `routes/blog-platform.ts` (`GET/POST /api/platform/blog/topics`, reject, move).
- Web: Platform > Blog > Topics tab; the Writer setting.
- Tests: `packages/shared/test/topic-scrub.test.ts` (a fixture corpus: identifiers, deny-list hits, fuzzy names,
  first person, proper nouns, good questions pass); `apps/server/test/blog-topics.test.ts` (queue order, per-day limit,
  declined, retry, duplicate, status from post events, replay equality); `blog-writer-boundary.test.ts` (import and SQL
  boundary from 3.2(4); `BlogTopicQueued` rejects extra fields).

### Phase 2: the CEO side (needs front-door Step 1 for the job log, repeats and corrections)
- Server: `ceo/topics.ts` (`noteSignals`, propose, merge, review, hand-off sweep with system actor), the deny-list
  builder `ceo/topic-denylist.ts`, `ceo/gateway.ts` (op `topic`), `ceo/brief.ts` (open notes as quoted data, plus the
  instruction), `ceo/report.ts` (the two sections), the desk item in `ceo/topics.ts`, `projections/ceo.ts`
  (`ceo_topic_candidates`, including updates from blog events by `topic_id`), `routes/ceo.ts` (`/topics`, review),
  `commands/orgs.ts` (`OrgBlogTopicSharingSet`, Owner only).
- Shared: `ceo/ipc.ts` (`topic propose|list`), `events/ceo.ts`, `events/org.ts`.
- Runner: `aom/aom-cli.ts` `aom ceo topic propose --question .. --area .. --from <ids>`; bump `RUNNER_VERSION`.
- Web: the `/ceo` Topics tab, the report sections, the desk item card, the Settings toggle and consent text.
- Tests: `ceo-topics.test.ts` (each signal source makes one note; coalescing; expiry; propose is rejected with findings
  and the deny-list blocks the org's own project name; org-side merge; Accept appends nothing to `blog-topics` until
  the sweep runs; the sweep's event has a system actor and no causation; status flows back to the candidate on
  publish); `ceo-topics-optin.test.ts` (a customer org with sharing off collects nothing and the verb answers
  `sharing_off`; opt-in plus Accept gives `origin:'customer'` and no org id anywhere in the `blog-topics` stream;
  turning it off withdraws queued topics; the monthly cap).
- E2E: a mock CEO proposes, the owner accepts in the report, the mock writer publishes, and the report shows the link.

### Phase 3: optional
- The classifier (3.3), an org allow-list editor, and auto-accept for the platform org after 20 clean accepts (only if
  the owner asks).

## 9. Risks

| Risk | Mitigation |
|---|---|
| **A leak through a generic-looking question** (a rare stack, a distinctive combination of tools) | Owner review is the last gate. The proper-noun allow-list makes unusual names a hard finding. The narrative gate blocks "our". The super admin can reject at the queue |
| **The owner stops reviewing** and the queue fills up | Topics stay `proposed` (nothing leaves). After 14 days without a decision they expire, and the report shows a single count, not a growing list |
| **The CEO pastes evidence into the question** | The shape limits (160 characters, one sentence, a question) and the identifier patterns. Rejections go back to the CEO with reason codes |
| **The blog becomes one theme** (deploys, every week) | `queuedPerDay` (default 1), area round-robin when several are queued, platform dedupe against the last 180 days of posts |
| **A false sense of anonymity for customer orgs** | The consent text states the database-level correlation limit. There is no org id on the platform side, and topics need an opt-in plus a per-topic Accept |
| **Over-blocking** (the scrubber rejects good questions) | Findings are shown with codes. The owner can edit, and can override an unknown proper noun with a second confirmation. The test corpus is tuned in phase 1 |
| **Replay** | All new state is projections of new events; the one optional field (`topicId`) is replay-safe. `blog_writer_runs.topic_id` is operational, like its table |

## 10. Open questions (each with a recommended default)

1. **Q1. Should customer orgs ever feed Guildwise's blog?** *Recommended: yes, but only with the Owner's opt-in
   (default off), per-topic Accept, `origin:'customer'` with no identity, and a cap of 4 a month. Phase 2 can ship with
   the toggle hidden until the consent text has been checked under POPIA.*
2. **Q2. How many topic articles a day?** *Recommended: at most 1 a day from the queue (the writer runs 1 or 2 slots a
   day), with the rotation filling the rest. Raise it once the queue proves good.*
3. **Q3. May Admins accept topics, or only the Owner?** *Recommended: Owner only in customer orgs (it is his consent);
   Owner or Admin in the platform org.*

## 11. Owner decisions (2026-10-19)

These override §5 and §10 where they differ.

1. **Customer orgs may feed the blog, under a "diagnostic data" opt-in.** The switch is not a blog-only setting: it is
   one organization-level consent, **"Share diagnostic data with Guildwise"** (Owner only, off by default, versioned
   consent text). Diagnostic data covers the problems the CEO notices (job-log repeats, failures, loops, corrections, as
   generic scrubbed records): Guildwise uses it to build better features for that customer and as blog research topics.
   `organizations.blog_topic_sharing` becomes this consent (e.g. `diagnostics_sharing`, event
   `OrgDiagnosticsSharingSet {orgId, on, consentVersion, by}`); the blog-topic hand-off is one use of it. The POPIA
   check of the consent text still applies before it is shown to customers.
2. **The Owner is asked, per batch.** With the consent on, the customer org's CEO does not send topics silently: it
   raises an open question to the Owner: "These might make good blog articles for the community. May I send them to
   Guildwise as research topics?", listing the scrubbed questions with Accept / Edit / Reject per topic. Only the Owner
   answers in customer orgs; Owner or Admin in the platform org (§10 Q3 default).
3. **Cadence unchanged:** the writer keeps one article a day; queued topics take that slot before the rotation. The
   number can be raised later. The 4-a-month cap per customer org stays.
