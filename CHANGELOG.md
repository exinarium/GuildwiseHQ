# Changelog

All notable changes to Guildwise HQ are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [1.3.0] - 2026-10-29

Runner 0.1.62 (unchanged). The video schedule, Short destinations and worker roles. Migrations 2740 to 2742 and a data migration (`video-schedule-2026-10`). New optional environment variables `AOM_VIDEO_MAX_BYTES`, `AOM_VIDEO_ROLE`, `AOM_VIDEO_WORKER_TOKEN`, `AOM_VIDEO_WORKER_PORT`, `AOM_VIDEO_PUSH_URL` (now requires `AOM_VIDEO_WORKER_TOKEN`), `AOM_TIKTOK_CLIENT_KEY` and `AOM_TIKTOK_CLIENT_SECRET`.

### Added

- Video worker roles: `AOM_VIDEO_ROLE=render|publish|all` (default `all`). A server that cannot render runs `publish`; a render worker elsewhere pushes each finished file over HTTPS to `PUT /api/worker/video/renders/:id/files/:name` (bearer `AOM_VIDEO_WORKER_TOKEN`, sha256 and size checked, served by the publish worker on `AOM_VIDEO_WORKER_PORT`, behind the reverse proxy) and a render counts as done only when every file is acknowledged. The video status reports `render` and `publish` heartbeats next to the combined `worker`. A rendered video whose file has not arrived yet is waited for until its slot instead of failing.
- YouTube videos: a publishing schedule (`docs/BLOG-API.md` "YouTube"). Per format (videos, Shorts) you tick the weekdays, the local time and the time zone (default Africa/Johannesburg, daylight saving handled) and the destinations; a video goes out at the next free slot. The writer's weekly limit is the number of days ticked, and it stops while twice a week's slots wait in review or are scheduled. Slots are managed with new calls: `schedule`, `unschedule`, `move`, `swap`, `preview` and `GET /slots` under `/api/platform/video`.
- Destinations for Shorts: YouTube, Facebook (Reels), Instagram (Reels), X, LinkedIn, Bluesky and TikTok can be chosen in the schedule and per video, with a caption each (the drafter can supply default captions with the video; no caption carries a link). The publish worker posts each at the slot with back-off until 6 hours after it, then marks the destination failed and mails you; one failed destination can be retried on its own (`POST /api/platform/video/posts/{id}/shares/{network}/retry`, the Queue shows a button per failed destination). Instagram and TikTok are channels in Social sharing but not share networks of the blog. TikTok connects with OAuth (`AOM_TIKTOK_CLIENT_KEY`, `AOM_TIKTOK_CLIENT_SECRET`), posts from a signed temporary media URL (`GET /api/public/video-media/...`), needs your privacy choice and consent for every post, and posts privately until you tick that the app passed TikTok's audit. X video uses OAuth 1.0a and may need an OAuth 2.0 token (see docs/BLOG-API.md). The status strip names the render and publish workers separately.
- Events `VideoPostScheduled`, `VideoPostUnscheduled` and `VideoPreviewRequested`; `VideoPostApproved` no longer needs a render. A missed slot (not rendered 30 minutes before it) slips to the next free slot, and the super admins are mailed about it, about an offline render worker, a render that failed, an empty slot and a full video disk.

### Fixed

- A video that is not rendered 30 minutes before its slot slipped twice when the app and the worker noticed at the same time; the slip now re-checks under the slot lock. A YouTube `publishAt` is at least 15 minutes ahead (otherwise the video goes public at once) and is worked out again on a retry; a post moved or unscheduled just as its upload started is not uploaded with the old slot. Two render workers can no longer both claim a render. A re-flow no longer moves posts that are rendered, close to their render, or already on a slot of the schedule. Moving a post respects the normal minimum lead time. Unscheduling clears the TikTok options and the captions edited at scheduling. Scheduling a TikTok Short without options is refused. Share links in the video pages are shown only for https addresses. The server refuses to start with `AOM_VIDEO_PUSH_URL` and no `AOM_VIDEO_WORKER_TOKEN`; a 0-byte artifact is accepted by the push; stale push temp files are cleaned up; the data migrations take a database lock so two instances do not run them at once.

- Short destinations never post twice: a destination with saved progress counts as started (unschedule, move, slip and re-flow are refused), the request that publishes is not repeated blindly when its answer is lost, X's duplicate-content 403 no longer pauses the channel, a retry keeps TikTok's publish id, TikTok token renewals and callback states are serialized and single-use, upstream-provided upload addresses are checked against the network's hosts, disconnecting TikTok revokes its token, and an upload that ends after its slot is made public.

### Changed

- YouTube videos: the script is the review gate. Submitting or editing a script no longer renders anything; Schedule (the old Approve) gives the video its slot and the render starts `renderLeadHours` before it (48 hours for videos, 24 for Shorts), or at once for "publish now". A "Preview render" (one of the 3 renders) shows the video before you schedule it. YouTube publishes at the slot itself (`publishAt`); the limit of one upload a day is gone (one upload runs at a time).
- Storage of rendered videos: the MP4 is removed after publishing (every destination sent or skipped and the video public, or 6 hours after the slot), 3 days after a failed destination, 1 day after a rejection, 7 days after a preview in review nobody touched. A retry of a failed upload renders again. `AOM_VIDEO_MAX_BYTES` (default 5 GB) stops new renders when the disk budget is used.
- Settings `perWeek` and `shortsPerWeek` are replaced by `schedule`; until one is saved it is derived from them (3 and 3 give Monday, Wednesday and Friday at 10:00 for videos, Tuesday, Thursday and Saturday at 16:00 for Shorts).
- X: a refused video upload (401 or 403 from the media endpoints) fails that Short's X share only and no longer pauses the X channel, so articles keep posting.
- A Preview render runs while no YouTube channel is connected yet (it uploads nothing); scheduled renders still wait for the channel.
- The test suite no longer flakes under load: the media proxy's body watchdog takes an injectable clock (default `Date.now`, no behaviour change).
- Existing videos are brought over by the data migration: approved videos keep the slot they have on YouTube, ones still waiting get the next free slot, finished renders of videos in review become previews, and unfinished renders are dropped (they render when you schedule the video).

## [1.2.1] - 2026-10-29

Runner 0.1.62 (unchanged). Patch for the video weekly limit; no migration.

### Fixed

- YouTube videos: a video draft that you reject no longer uses up the week's video limit (`perWeek` and `shortsPerWeek`). Before, rejected drafts counted for seven days and could block new videos. Drafts, videos in review and approved videos still count.

## [1.2.0] - 2026-10-28

Runner 0.1.62 (unchanged). Release posts, per-network hashtags and the YouTube video worker; migrations 2720 and 2730. Videos stay off until a YouTube channel is connected and video posts are switched on.

### Added

- Blog: hashtags per social network (Facebook up to 3, LinkedIn 3 to 5, X and Bluesky 1 to 2), stored without `#` in `social.hashtags` of a post. The post editor shows a caption editor per network with a hashtag chip input, a live counter and the exact text that will be posted. X keeps its hashtags (the caption is cut first); Bluesky hashtags are clickable `#tag` facets. Caption limits live in one place (`SOCIAL_LIMITS`). Posts written before this keep their inline hashtags.
- Blog: release announcements. Platform > Blog > Releases lists each release from `CHANGELOG.md` with a post that you write (or, on a hosted installation, a drafter proposes), edit and approve; it is shared once per connected network and never without your approval. New public pages `/releases` and `/releases/<version>` (What's New plus the changelog, in the sitemap) are the link target. Optional `release:` in What's New entries pins an entry to a release. Migration 2720 (`social_posts`, `social_shares.source`).
- Blog writer setting `releasePosts` (on by default): whether a drafter creates a release post for each new release.
- YouTube push (`docs/BLOG-API.md` "YouTube"): Platform > Blog > Videos turns articles, releases and tutorials into narrated, faceless videos and uploads the ones you approve. One review gate on the rendered video (player with captions, script, title, description, tags, hashtags and privacy, edits render again, at most 3 renders), a Short per video approved separately, a YouTube channel in Social sharing (paste a refresh token; `AOM_YOUTUBE_CLIENT_ID`, `AOM_YOUTUBE_CLIENT_SECRET`), at most one upload a day at 10:00 Johannesburg time, a "kept private" warning when YouTube locks an unaudited API project, a Library import of the existing help videos, a Video topics list for new showcase videos, an optional cross-post of a tutorial, and YouTube embeds on `/blog/<slug>` and `/releases/<version>`. A separate `video-worker` container (compose profile `video`) renders and uploads. Off by default and a no-op without a connected channel. Migration 2730 (`video_posts`, `video_renders`, `video_topics`, `social_shares.detail`).
- Video renderer (`@aom/video`, `docs/VIDEO-RENDERER.md`): turns a script into a narrated 1920x1080 video or a 1080x1920 Short with captions, thumbnail and YouTube description, using the help videos' voice and clips of the help videos. Run from the command line with `node dist/video-worker.mjs --render script.json --out dir`; not used by the app yet.

### Changed

- Bluesky posts no longer repeat the link in the text: the link card carries it.
- LinkedIn posts use API version 202610 (202509 was sunset) and Facebook posts Graph API v26.0 (v21.0 ends 2027-01-21). LinkedIn captions are escaped for LinkedIn's text format.
- The X caption limit is 256 characters with its hashtags (the link is added and counts 23); Bluesky 300 characters. Before, the limits were 250 and 270 and differed between the editor and the server.
- Connecting LinkedIn: a pasted `urn:li:organization:<id>` is cut down to the id. The Social sharing panel is at the bottom of Platform > Blog (Posts tab).


## [1.1.0] - 2026-10-27

Runner 0.1.62. Workstations update themselves; pack agents on seats need 0.1.62.

### Added

- CEO: a new signal flags a high-risk card (review risk "high") that has waited more than 24 hours for approval, counted from when it started waiting. Report only; it does not wake the CEO unless you add it to the urgent signals.
- CEO: the daily report lists the day's high-risk cards finished (merged, PR or push).
- Runner: `guildwise-runner` is installed alongside `aom-runner`; both names run the same command.
- Webhooks: outgoing signed webhooks carry `X-Guildwise-Signature`. `X-AOM-Signature` is still sent with the same value until October 2027.
- Packs: agents can be hired from an approved pack onto the built-in roles as their seat (analyst, BA, planner, architect, builder, pre-reviewer, reviewer, tester, researcher, writer), one at a time or the whole pack at once (all or nothing, Owners and Admins). They keep the pack agent's name and approach, join the agents already there, and the role's rules, gates and permissions are unchanged. Owners and Admins mark which skills of a pack are agents and which are playbooks. Pack agents without a seat get a role of their own that holds none of the pack's text. API in docs/ARCHITECTURE.md section 38.14; migration 2710.
- Packs: the Claude Code plugin layout is read (`agents/*.md` as personas, `commands/*.md` as one-step playbooks, at any depth); a pack may list 1000 capabilities. Needs runner 0.1.62. Only folders that belong to a Claude Code plugin are read. A pack approved before keeps working without these items until the Owner approves them.

### Changed

- New projects use `guildwise/` card branches (existing projects keep their prefix), and the runner's temporary integration branches are `guildwise/integration/<card>`. Branch cleanup recognises the old and new names.
- New local vaults are marked `.guildwise-local-vault` (the old marker is still written for one release and both are read); agent commits to vault repositories use `agents.guildwise.invalid`.
- New environment setups default to `~/guildwise-backups`. Deploy scripts' markers are read under both their old and new names, ahead of renaming them in a later release.
- One name for the CEO's report: "Daily report", on the desk, in the e-mail digest option and subject, and in the Help.
- Wording: "Add a workstation" (with "Pair with a code" for pairing codes) everywhere; the BA designs the organization with the Owner and Admins; "Agents page" instead of "HR board".
- The in-app Help and page help were checked against the current app and updated section by section.
- Removed the unused CEO cooling-off setting (`delayMinutes`); saved policies that contain it still load.
- The retired `.aom/test-env.json` is no longer read.
- Self-hosting: a runner connecting to a server with a private certificate authority needs `NODE_EXTRA_CA_CERTS` (docs/SELF-HOSTING.md).

### Fixed

- A bare skill key that is a playbook or a persona (`release`) is no longer rewritten to a pack skill of the same name when skills are qualified, and the key migration keeps it.
- Skills given to an agent (thanks to @Creative2911, #1): the skills added to a role with Extend now reach every agent on the role, in chats, sessions and card shifts alike, as loadable skills in the `# Capabilities` index and the runtime's skills folder. Before, chats got only the skills stored on the agent at hire, and card shifts listed the extension's skills as plain text only.
- A bare pack skill name typed into the hire form or a role extension (`bmad-prd`) is stored as the pack's full key (`bmad-method:bmad-prd`) when exactly one pack has it, instead of showing as "not found in the registry". The data migration `pack-skill-keys-2026-10` does the same for existing agents and extensions.
- Hiring with an empty Skills box gives the agent its role's skills (the form sent an empty list, which hired with none).
- An agent's skills follow its role: a new role version brings its new skills, and the agent's own additions and removals stay (`AgentPermissionsRebased` carries the skills).
- Reopening a published research card marks its publication superseded: the Research tab, phase completion and interest counts no longer count it, and publishing again leaves one live note.
- Reopening a bug card that was cancelled after a test failure puts its parent back to waiting when the parent is still queued or claimed in Test; otherwise both cards get a warning and the parent is left as it is.
- Media: a paused video is no longer cut after 30 seconds. Only real upstream silence (30 seconds) cuts a stream; a client that makes no progress for 10 minutes is closed. An upstream error mid-stream ends the response instead of throwing.
- Costs: the project filter lists every project, not only the selected one.
- Settings: you see and set your own time zone; non-Owners are told the daily report follows the Owner's zone.
- Intake and vault registration are offered only to people who may use them (desk, palette, empty board, discovery, Vaults).
- New research card from the Research tab starts on the research type.
- The org chart draws escalation to the CEO when one is active, as the routing does.
- CEO chat shows the error when the CEO status cannot be loaded, instead of "not set up yet".

## [1.0.1] - 2026-10-26

### Security

- Resolved all open security advisories: 21 Dependabot alerts (5 high, 15 moderate, 1 low) and the further findings from `pnpm audit`, which now reports no known vulnerabilities. Upgrades include nodemailer 10.2.1, @fastify/static 10.1.7, fastify 5.12.6, undici 8.12.2, zod 4.6.6, vite 7.3.7 and vitest 4.1.12, plus `overrides` for transitive packages (shell-quote, fast-uri, esbuild, @vitest/mocker).

### Fixed

- Runner: the outbox no longer throws when its data directory is removed while a shift or chat is still finishing. Nothing is persisted, the frame is sent best-effort, and a warning is logged, instead of an unhandled rejection that could stop the runner.

### Changed

- The site assistant's open-source facts (repository, self-hosting, license) are on by default.

## [1.0.0] - 2026-10-26

The first public release of Guildwise HQ, a way to run an organization of AI agents (set up for software delivery by default), under the Apache License 2.0. The repository keeps the development history, with the parts specific to the hosted service removed.

### Summary of what ships

**Work and delivery**

- Board with cards that move through spec, build, review, test, finalize and QA, with filters for blocked work, rework and items waiting for you.
- Project backlog, intake of tickets, and research cards.
- Discovery: turn an idea into a PRD with an analyst agent.
- Boardroom: a multi-persona discussion run by a chair agent, with minutes and "pull into PRD".
- Documents, including PRDs and minutes, with approval and version history.
- Phases, follow-ups, a release queue, environments and delivery recipes for deploys.

**Agents and team**

- Agent roles: business analyst, planner, architect (optional), builder, pre-reviewer, reviewer, tester and DevOps engineer.
- Hiring with seniority and per-project allow-lists; pausing, resuming and changing models.
- CEO agent in each organization, with a daily report and a desk for routine items.
- Org chart, custom roles, departments and workflows.
- Ledger of decisions, requirements and standing orders.

**Runtimes**

- Claude Code, Codex CLI, Gemini CLI, opencode and direct model APIs.

**Safety and control**

- Desk for questions, approvals and go-aheads; approval gates for risky steps.
- Sandboxed sessions: bubblewrap and socat on Linux and WSL2, Seatbelt on macOS, and a separate git worktree per session.
- Budgets and cost tracking per project and organization, with CSV export.
- Governance: "What it may do" per agent, audit log with CSV export, and an offboarding checklist.
- Two-factor login; organizations are isolated from each other.

**Knowledge**

- Vaults: git repositories of notes, synced to workstations.
- Capabilities and packs from git repositories, reviewed before use; playbooks and the `/` menu.
- Interests and automations.

**Operations**

- Workstations: runner for Linux, macOS and WSL2, with a guided installer; native Windows as an explicit, unsandboxed opt-in.
- Cloud workstations: a VPS over SSH, or a GitHub Codespace.
- Integrations: git hosts (GitHub, GitLab, Azure DevOps, Bitbucket Cloud) and Jira.
- Metrics, in-app help articles and a glossary.

**Self-hosting**

- Docker Compose stack: Caddy for HTTPS, the application, Postgres 18 and a media service for help videos.
- Migrations applied on boot. Platform account and organization invitations.
- Optional: Web Push, inbound mail, a landing-page assistant and a weekly blog digest.
- Every feature is included and organizations are unlimited: a self-hosted install has no plans, trials or limits.

### Notes for self-hosters

- Set `AOM_SECRET_KEY` and keep it with your backups.
- Back up the database before every upgrade. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- Update workstation runners together with the server.
