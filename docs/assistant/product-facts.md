# Guildwise HQ: product facts for the landing-page assistant

This file is the curated source of truth for the public "Ask Guildwise" assistant on the landing page. It is built into the assistant's knowledge pack together with the help articles (`pnpm --filter @aom/server assistant:pack`). Edit it here, rebuild the pack and commit both: a test fails when the committed pack is stale. Write plain, true, checkable statements only. Do not add anything the product does not do today.

## What it is

Guildwise HQ is a management layer for a crew of AI coding agents. You hire agents by role (business analyst, builder, reviewer, tester, architect, DevOps engineer and others), give them work as cards on a board, and answer the questions they cannot decide on one desk. Agents work in parallel, each on its own card. Work passes separate review and test stages before it can finish.

Tagline: "You manage. They work." The landing page also says "Many hands, one master."

## Who it is for

The person who manages the agents: the one who sets the standard, answers the hard questions and signs off the result. It does not replace developers. You need a code repository for the agents to work in, but you do not need to know git: by default cards speak in plain results ("Your change is live on main") and Guildwise HQ takes care of branches. Each person can turn on an expert mode in Settings to see branch names and the git controls. A guided installer sets up a workstation, and a Get started checklist, a guided tour and a three-minute training video walk through the first project.

## How it works

1. Hire your crew: pick roles and seniority, choose which projects each agent may work on.
2. Cards cross the board: work moves through the stages of a workflow (for example spec, build, review, test, done) by itself as agents work.
3. Decide at your desk: questions, approvals and alerts reach one desk with context, options and a recommendation. You answer once and the crew carries on.

## Where the agents run

Guildwise HQ is a hosted service: you sign up on the website and use it in the browser. The agents run on a workstation you choose, one of:

- your own computer (Linux, macOS or Windows; Windows uses WSL2), set up by a guided installer;
- a Linux server you rent (a VPS) that you can log in to over SSH: Guildwise HQ logs in once, installs the runner and pairs it; the password or key is not stored;
- a GitHub Codespace, which pairs itself, stops after 30 minutes without work, wakes when a card is queued and can keep office hours. A Codespace cannot run Docker, so Docker deploys need your own computer or a VPS.

You pay the VPS company or GitHub directly; Guildwise HQ adds no charge for them. Every cloud workstation shows an estimated monthly cost.

Code, secrets and files stay on the workstation and in your own git repositories. The Guildwise HQ server holds the board, the desk, the ledger and the records. A small helper program, the runner, connects each workstation to the server. The agent runtime is Claude Code, using your own Claude subscription or Anthropic API key, so the agents' model usage is billed by Claude to you (for a team, an API key is recommended). You choose the model per agent. Guildwise HQ never receives or stores a Claude key or token.

## Git hosts

Each repository can be on GitHub, GitLab, Bitbucket Cloud, Azure DevOps or a plain git server, and one project can mix them. The login for each host stays on the workstation (a one-line connect command, or the DevOps engineer helps in a chat). Finished work is committed and pushed to the working branch after review and test by default, or arrives as a pull request if the project prefers that or the working branch is protected (a plain git server gets a pushed branch instead of a pull request).

## What you get

- A board with every card and its stage, and a desk for decisions.
- A ledger: every decision is recorded once and given to every agent that asks later, so you are not asked the same thing twice.
- Review and test gates. Risk is assessed from the size of a change and large changes need two reviewers. Each agent works on its own copy of your code, and a change reaches your main code only after review and testing, with the checks you set up.
- Phases: group cards into a milestone; when the last card is done, follow-ups such as deploys or regression runs run in order once you approve them.
- Budgets: a monthly budget per project, a warning at 80 percent and dispatching pauses at 100 percent. Running shifts finish.
- A business analyst agent that turns tickets and ideas into cards, and writes a daily floor report: what is stuck, what was solved, what it cost.
- Intake from Jira and GitHub: the BA maps incoming tickets to projects and drafts cards with specs and test plans.
- Outbox: posts to Jira, GitHub or email wait for your approval before they go out.
- Org design: roles, departments and workflows, designed in a chat with the BA and approved by the Owner.
- Standing orders and automations (formerly schedules): recurring instructions and work that starts by itself, on a time or when something happens in a workflow.
- Vaults: knowledge repositories (git) for the organization and per project that sync to your workstations.
- A DevOps engineer agent on every workstation, free: it installs tools and the project's packages, keeps repositories tidy (unsaved edits are kept on a separate saved-work branch, never pushed to main), tries to fix conflicting changes itself, and runs commands, Docker builds and deploys you ask for in a chat. It works as you, outside the sandbox the other agents use; privileged actions on a team member's machine need an Owner or Admin and the machine's user to agree.
- Cards explain themselves on the board: why they are blocked, a repository problem, or a budget that is nearly used up, each with a link to fix it.
- A What's new window after updates, and in-app help with articles, a glossary and a page-by-page help panel.
- Shared projects: invite people as additional managers on a single project.
- Organizations with roles Owner, Admin and Member. Two-factor login with authenticator codes and recovery codes; Owners can require it for everyone.
- An append-only audit trail: state is a log of events that is only appended to, so you can see what happened, in order, and who approved it.

## Security and hosting (say only this)

- Guildwise HQ is a hosted service you sign up for. The agents run on your own workstation, a VPS or a GitHub Codespace, and your code stays in your own repositories.
- Agents talk to the model provider you configure and to your code host. Posts to Jira, GitHub or email leave only after approval in the outbox. Vaults are kept with your own code, on your side; the Guildwise HQ server keeps the board, the desk, the ledger and the audit trail.
- The Privacy policy (`/privacy`) and the Terms and conditions (`/terms`) are on the website.
- There is no SOC 2 or ISO 27001 certification today, and the assistant must not imply one. The product is designed around controls such as approvals, audit logging, role-based access and two-factor login. A customer's own review decides whether it fits.

## Pricing and trial (say only this)

Three plans, per month, in US dollars:

- Starter: $19. Up to 2 members, 1 workstation and 3 projects.
- Team: $49. Up to 5 members, 3 workstations and 10 projects.
- Business: $149. Up to 20 members, 10 workstations and unlimited projects. On Business you can add extra members, workstations and projects as add-ons, priced per unit (the prices are shown on the Billing page); add-on changes start with the next billing cycle, and you cannot go below the Business base.

Every plan has every feature and no limit on agents; plans differ only in members, workstations and projects. Prices include VAT (15%, shown on every invoice). They are shown in US dollars and charged to your card in South African rand at that day's exchange rate, and each invoice shows the dollar price, the VAT and the rand charged. Guildwise HQ is sold to businesses: sign-up asks for a company name, and the Owner keeps a billing profile (company name, address, VAT number) that is printed on a printable tax invoice. Payments go through Paystack; Guildwise HQ never sees or stores the card number.

There is a 7-day free trial: sign up, confirm your email and add a card; nothing is charged until the trial ends, then monthly. You can cancel at any time: the organization stays active until the end of the paid term (or the trial), then it is paused, and nothing more is charged. A plan change takes effect at once and the difference for the rest of the month is charged or credited. The AI usage itself is billed by Claude, and a VPS or Codespace by its provider.

Do not give discounts, custom prices, other currencies' amounts or dates beyond this. For anything else about pricing or a contract, point to the Contact us page (`/contact`).

## How to get access

Click "Start free trial" on the landing page (or a plan's button under Pricing) to sign up at `/signup`. Existing users sign in at `/login`. Questions, a demo or sales go to the Contact us page (`/contact`).

## The blog

The Guildwise HQ blog at `/blog` has practical articles on AI agents and automation, written by an AI agent and reviewed before they go public; the author is always "The Guildwise HQ team". It has an RSS feed at `/blog/rss.xml`, and signed-in users can get a weekly digest by email (Owners get it unless they opt out).

## What the assistant does not do

- It answers only questions about Guildwise HQ. It does not write code, give general advice or chat about other topics.
- It does not compare Guildwise HQ with other products or make claims about them.
- It gives no legal, compliance or security-certification advice and no promises about delivery dates, service levels or custom work. For those it points to the Terms and Privacy pages and to Contact us.
- It cannot see anyone's account, data or tickets, and it does not collect personal details. For account problems, sales or support it points to Contact us.
