# Guildwise HQ: product facts for the landing-page assistant

This file is the curated source of truth for the public "Ask Guildwise" assistant on the landing page. It is built into the assistant's knowledge pack together with the help articles (`pnpm --filter @aom/server assistant:pack`). Edit it here, rebuild the pack and commit both: a test fails when the committed pack is stale. Write plain, true, checkable statements only. Do not add anything the product does not do today.

Open-source switch: text between `{{#oss}}` and `{{/oss}}` is kept only when the repository is public (`OPEN_SOURCE_LIVE` in `apps/server/src/assistant/pack-builder.ts`, or `pnpm --filter @aom/server assistant:pack -- --open-source-live`); text between `{{^oss}}` and `{{/oss}}` is kept only before launch. Flip the constant in the launch commit and rebuild the pack. The hosted-service prices below must match `shared/src/pricing.ts` in the guildwise-cloud repository (a test there checks it).

## What it is

Guildwise HQ is a way to run an organization of AI agents: roles, a lean team, a board, your desk, approval gates, budgets and an audit trail, on your own machines and AI accounts. You hire agents by role (business analyst, builder, reviewer, tester, architect, DevOps engineer), give them work as cards on a board, and answer the questions they cannot decide on one desk. Agents work in parallel, each on its own card, and work passes separate review and test stages.

It comes set up for software delivery by default, and does not stop there: the same organization can run other work you hand to agents, through packs (skills, personas, playbooks), Discovery (an idea to an approved PRD), the Boardroom (a debate run by a Chair) and Documents. You can write your own roles and workflows. No ready-made setups for non-software fields exist.

Tagline: "You manage. They work." The landing page also says "Many hands, one master."

{{#oss}}Guildwise HQ is free and open source under the Apache 2.0 license, written and maintained by Pieter Jordaan. The source is at github.com/exinarium/GuildwiseHQ. You can run it yourself (self-hosted, free) or use Guildwise Cloud, the hosted service at guildwisehq.com.{{/oss}}{{^oss}}Guildwise HQ is being released as free and open source under Apache 2.0, with the source on GitHub, at launch. Until then it is available as Guildwise Cloud, the hosted service at guildwisehq.com. It was created by Pieter Jordaan.{{/oss}}

## Who it is for

The person who manages the agents: the one who sets the standard, answers the hard questions and signs off the result. It does not replace your people. For the default software setup you need a code repository for the agents to work in, but you do not need to know git: by default cards speak in plain results ("Your change is live on main") and Guildwise HQ takes care of branches. Each person can turn on an expert mode in Settings to see branch names and the git controls. A guided installer sets up a workstation, and a Get started checklist, a guided tour and a three-minute training video walk through the first project.

## How it works

1. Hire your crew: pick roles and seniority, choose which projects each agent may work on.
2. Cards cross the board: work moves through the stages of a workflow (for example spec, build, review, test, done) by itself as agents work.
3. Decide at your desk: questions, approvals and alerts reach one desk with context, options and a recommendation. You answer once and the crew carries on.

## Where the agents run

Guildwise HQ can be self-hosted or used as the hosted Guildwise Cloud. Either way you use it in the browser, and the agents run on a workstation you choose, one of:

- your own computer (Linux, macOS or Windows; Windows uses WSL2), set up by a guided installer;
- a Linux server you rent (a VPS) that you can log in to over SSH: Guildwise HQ logs in once, installs the runner and pairs it; the password or key is not stored;
- a GitHub Codespace, which pairs itself, stops after 30 minutes without work, wakes when a card is queued and can keep office hours. A Codespace cannot run Docker, so Docker deploys need your own computer or a VPS.

You pay the VPS company or GitHub directly; Guildwise HQ adds no charge for them. Every cloud workstation shows an estimated monthly cost.

Code, secrets and files stay on the workstation and in your own git repositories. The Guildwise HQ server (yours, or Guildwise Cloud) holds the board, the desk, the ledger and the records. A small helper program, the runner, connects each workstation to the server. The agent runtime is Claude Code, Codex, the Gemini CLI, opencode or a direct API, using your own accounts or keys, so the agents' model usage is billed by those providers to you. You choose the model per agent. Guildwise HQ never receives or stores a provider key or token.

## Git hosts

Each repository can be on GitHub, GitLab, Bitbucket Cloud, Azure DevOps or a plain git server, and one project can mix them. The login for each host stays on the workstation (a one-line connect command, or the DevOps engineer helps in a chat). Finished work is committed and pushed to the working branch after review and test by default, or arrives as a pull request if the project prefers that or the working branch is protected (a plain git server gets a pushed branch instead of a pull request).

## What you get

- A board with every card and its stage, and a desk for decisions.
- A ledger: every decision is recorded once and given to every agent that asks later, so you are not asked the same thing twice.
- Review and test gates. Risk is assessed from the size of a change and large changes need two reviewers. Each agent works on its own copy of your code, and a change reaches your main code only after review and testing, with the checks you set up.
- Phases: group cards into a milestone; when the last card is done, follow-ups such as deploys or regression runs run in order once you approve them.
- Environments: one page per project for where the app runs (start steps, test copies per card, a test site, a live site, extra sites, the computers and servers they use, rules, history); apps that run in Docker or directly on a machine (a service, pm2); Releases lists what waits, what is live and the history, and the Owner or an Admin can go back to an earlier version.
- Budgets: a monthly budget per project, a warning at 80 percent and dispatching pauses at 100 percent. Running shifts finish.
- A business analyst agent that turns tickets and ideas into cards, and writes a daily report: what is stuck, what was solved, what it cost.
- Intake from Jira and GitHub: the BA maps incoming tickets to projects and drafts cards with specs and test plans. It can look at a Jira ticket's screenshots and design files (downloaded on your workstation with your Jira token, which never leaves it), and cards carry file attachments for builders and testers.
- Outbox: posts to Jira, GitHub or email wait for your approval before they go out.
- Org design: roles, departments and workflows, designed in a chat with the BA and approved by the Owner.
- Standing orders and automations (formerly schedules): recurring instructions and work that starts by itself, on a time or when something happens in a workflow.
- Vaults: knowledge repositories (git) for the organization and per project that sync to your workstations.
- A DevOps engineer agent on every workstation, free: it installs tools and the project's packages, keeps repositories tidy (unsaved edits are kept in a local git stash, never pushed), tries to fix conflicting changes itself, and runs commands, Docker builds and deploys you ask for in a chat. It works as you, outside the sandbox the other agents use; privileged actions on a team member's machine need an Owner or Admin and the machine's user to agree.
- Several AI runtimes: Claude Code, Codex, the Gemini CLI, opencode and direct APIs (Anthropic, OpenAI, Gemini, any OpenAI-compatible endpoint, Amazon Bedrock and Vertex AI). Each workstation has a main account and any number of named accounts; a project can use its own account and fall back to the main one when an account is out.
- Governance: a "What it may do" screen per agent (tools, repositories, provider, key, delegation grants, skills, budgets), approval gates, approving or rejecting from a push notification (a one-time link that asks you to sign in first), an audit log you can export, and an offboarding checklist when a person is removed.
- @agent in card comments: ask an agent a small question in a card's thread; it answers there and the cost is booked to the card.
- Describe the agent you need: write one sentence and get a draft agent. A starter gallery lists ready-made personas and playbooks (product brief, brainstorm, release notes, weekly status, pull request triage, incident follow-up; Analyst, Devil's advocate, Security reviewer, Operations, Cost hawk).
- Reminders for open items: a question, approval or escalation open for 3 days (the period is an organization setting; 0 turns it off) reminds the person it waits for; Snooze holds it back for 1 day to 2 weeks.
- Discovery (an analyst takes an idea through five phases to a brief or PRD that you approve and hand to the BA), the Boardroom (personas and agents debate a question, run by a Chair, with a whiteboard and minutes) and Documents (every brief, PRD and set of minutes, with versions).
- Capabilities and packs: skills, personas and playbooks, imported as packs from any git repository in the Agent Skills format. Nothing in a pack is used until an Owner or Admin reviews and approves that exact commit. A repository laid out for BMad Method imports as skills like any other pack. Type / in a chat to run a playbook.
- 30 short narrated videos, one per screen, shown on the website and in the Help centre.
- A project backlog: a Backlog tab next to the board for work you want but have not started. Items (title, description, priority, tags, star) stay out of development until you send them to the BA; sending creates a normal intake and card and marks the item done. Agents can suggest follow-ups there, and the CEO's daily report lists the new suggestions.
- Cards explain themselves on the board: why they are blocked, a repository problem, or a budget that is nearly used up, each with a link to fix it.
- A What's new window after updates, and in-app help with articles, a glossary and a page-by-page help panel.
- Shared projects: invite people as additional managers on a single project.
- Organizations with roles Owner, Admin and Member. Two-factor login with authenticator codes and recovery codes; Owners can require it for everyone.
- An append-only audit trail: state is a log of events that is only appended to, so you can see what happened, in order, and who approved it.

## Security and hosting (say only this)

- Guildwise HQ is open source, so its code can be read and audited. You can self-host it, or sign up for Guildwise Cloud. The agents run on your own workstation, a VPS or a GitHub Codespace, and your code stays in your own repositories.
- Agents talk to the model provider you configure and to your code host. Posts to Jira, GitHub or email leave only after approval in the outbox. Vaults are kept with your own code, on your side; the Guildwise HQ server (yours, or Guildwise Cloud) keeps the board, the desk, the ledger and the audit trail.
- The Privacy policy (`/privacy`) and the Terms and conditions (`/terms`) are on the website.
- There is no SOC 2 or ISO 27001 certification today, and the assistant must not imply one. The product is designed around controls such as approvals, audit logging, role-based access and two-factor login. A customer's own review decides whether it fits.

## Open source and self-hosting (say only this)

- License: Apache 2.0. Any use is allowed, commercial use included, with no fee and no permission needed. Every feature is in the free version; there are no paid tiers of the software.
- {{#oss}}Source: github.com/exinarium/GuildwiseHQ. Questions and ideas go in GitHub Discussions; bugs in GitHub Issues; contributions follow CONTRIBUTING.md in the repository.{{/oss}}{{^oss}}The source code is going public on GitHub at launch; until then do not give a repository address.{{/oss}}
- Feature requests: suggest a feature in GitHub Discussions (the Ideas category) or open an issue with the feature request template. Anyone can.
- Self-hosting: run it with Docker Compose (the app, Postgres and a Caddy reverse proxy) on your own server with a domain name, an SMTP relay for invitation emails, and ports 80 and 443 open. The deployment guide is `docs/DEPLOY.md` in the repository. Agents run on your own workstations, not on the server. Self-hosting includes no backups, support or hosting from us; you run those.
- Author: created by Pieter Jordaan, who maintains it in the open. Supporting the project is optional: star the repository, GitHub Sponsors, Ko-fi (ko-fi.com/exinarium), or the commercial license.
- Do not say who operates Guildwise Cloud beyond what the footer and the Terms say. If asked who runs it, say the Terms and Privacy pages name the operating company.

## Pricing and trial (say only this)

Guildwise HQ software is free. There are three ways to pay, all optional. Prices are in US dollars and include VAT.

- Self-hosted: free. Every feature, unlimited organizations, Apache 2.0, any use. Hosting, backups and support are not included.
- Commercial license: pay what you want, once, from $5 (suggested $25, $50 or $100). It gives a commercial license issued in the buyer's name, a certificate and the "Commercial supporter" badge. It is voluntary: Apache 2.0 already allows commercial use.
- Guildwise Cloud: $30 per organization per month, which includes the organization and its owner, plus $10 per month for each additional member. Yearly billing is ten times the monthly price (two months free). Examples per month: 1 member $30, 3 members $50, 5 members $70, 10 members $120, 25 members $270. It is already hosted, with no install or updates. It has a 7-day free trial. It does not include backups or data maintenance: we do not own your data, so we do not keep copies of it, and you can export it whenever you like. Customers get community membership with free occasional webinars and training. Agents, workstations and projects are unlimited and do not count towards the price; guests do not count as members.
- Customization and setup support: custom workflow and agent development, and organizational planning, are quoted on request through the Contact us page. There is no listed price.

The AI usage itself is billed by the AI provider, and a VPS or Codespace by its provider. Prices are charged to the card in South African rand at that day's exchange rate, and each invoice shows the dollar price, the VAT and the rand charged. A company name is asked at sign-up and a billing profile (company name, address, VAT number) is printed on the tax invoice. Payments go through Paystack; the card number is never seen or stored. Cancel any time: the organization stays active until the end of the paid term (or the trial), then it is paused and nothing more is charged. There are no pro-rata refunds for the unused part of a paid period.

Do not give discounts, custom prices, other trial lengths, other refund terms, other currencies' amounts or dates beyond this. Do not mention any plan that is not listed here. For anything else about pricing or a contract, point to the Contact us page (`/contact`).

## How to get access

To run it yourself, follow the self-hosting guide in the GitHub repository. To use Guildwise Cloud, click "Try Guildwise Cloud" on the website to sign up at `/signup`; existing users sign in at `/login`. Questions, a demo, support or sales go to the Contact us page (`/contact`).

## The blog

The Guildwise HQ blog at `/blog` has practical articles on AI agents and automation, written by an AI agent and reviewed before they go public; the author is always "The Guildwise HQ team". It has an RSS feed at `/blog/rss.xml`, and signed-in users can get a weekly digest by email (Owners get it unless they opt out).

## What the assistant does not do

- It answers only questions about Guildwise HQ. It does not write code, give general advice or chat about other topics.
- It does not compare Guildwise HQ with other products or make claims about them.
- It gives no legal, compliance or security-certification advice and no legal advice about open source licensing (it can say Apache 2.0 allows any use, commercial included, and point to the license text and the Terms), and no promises about delivery dates, service levels or custom work. For those it points to the Terms and Privacy pages and to Contact us.
- It cannot see anyone's account, data or tickets, and it does not collect personal details. For account problems, sales or support it points to Contact us.
