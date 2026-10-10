# Guildwise HQ: product facts for the landing-page assistant

This file is the curated source of truth for the public "Ask Guildwise" assistant on the landing page. It is built into the assistant's knowledge pack together with the help articles (`pnpm --filter @aom/server assistant:pack`). Edit it here, rebuild the pack and commit both: a test fails when the committed pack is stale. Write plain, true, checkable statements only. Do not add anything the product does not do today.

## What it is

Guildwise HQ is a management layer for a crew of AI coding agents. You hire agents by role (business analyst, builder, reviewer, tester, DevOps engineer and others), give them work as cards on a board, and answer the questions they cannot decide on one desk. Agents work in parallel, each on its own card. Work passes separate review and test stages before it can finish.

Tagline: "You manage. They work." The landing page also says "Many hands, one master."

## Who it is for

The person who manages the agents: the one who sets the standard, answers the hard questions and signs off the result. It does not replace developers. You need to be comfortable with code repositories and with the idea of agents working in them. A guided installer sets up a workstation and the user guide walks through the first project.

## How it works

1. Hire your crew: pick roles and seniority, choose which projects each agent may work on.
2. Cards cross the board: work moves through the stages of a workflow (for example spec, build, review, test, done) by itself as agents work.
3. Decide at your desk: questions, approvals and alerts reach one desk with context, options and a recommendation. You answer once and the crew carries on.

## Where the agents run

Agents run on your own computers, called workstations (Linux, macOS or Windows). Code, secrets and files stay on the workstation. The Guildwise HQ server holds the board, the desk and the records. A small helper program, the runner, connects each workstation to the server. A guided installer sets it up. The agent runtime is Claude Code, using your own Claude subscription or API key, so the agents' model usage is billed by Claude to you. You choose the model per agent. A mock runtime exists for testing without spending tokens.

## What you get

- A board with every card and its stage, and a desk for decisions.
- A ledger: every decision is recorded once and given to every agent that asks later, so you are not asked the same thing twice.
- Review and test gates. Risk is assessed from the size of a change and large changes need two reviewers. Nothing merges without the gates you configure.
- Phases: group cards into a milestone; when the last card is done, follow-ups such as deploys or regression runs can start by themselves.
- Budgets: a monthly budget per project, a warning at 80 percent and dispatching pauses at 100 percent. Running shifts finish.
- A business analyst agent that turns tickets and ideas into cards, and writes a daily floor report: what is stuck, what was solved, what it cost.
- Intake from Jira and GitHub: the BA maps incoming tickets to projects and drafts cards with specs and test plans.
- Outbox: posts to Jira, GitHub or email wait for your approval before they go out.
- Org design: roles, departments and workflows, designed in a chat with the BA and approved by the Owner.
- Standing orders and schedules: recurring instructions and work that starts by itself.
- Vaults: private knowledge repositories per person and per project that sync to your workstations and do not leave your machines.
- Shared projects: invite people as additional managers on a single project.
- Organizations with roles Owner, Admin and Member. Two-factor login with authenticator codes and recovery codes; Owners can require it for everyone.
- An append-only audit trail: state is a log of events that is only appended to, so you can see what happened, in order, and who approved it.

## Security and hosting (say only this)

- Self-hosted: you run Guildwise HQ on your own server. There is no hosted version today.
- Agents talk to the model provider you configure. Posts to Jira, GitHub or email leave only after approval in the outbox. Vaults and the ledger stay on your side.
- There is no SOC 2 or ISO 27001 certification today, and the assistant must not imply one. The product is designed around controls such as approvals, audit logging, role-based access and two-factor login. A customer's own review decides whether it fits.

## Pricing and trial

Pricing is not published yet. The assistant must not state, estimate or promise any price, discount, trial length or date. For pricing, a trial, a demo or access, point to the Contact us page (`/contact`) or the "Put your agents to work" button, which asks for access.

## How to get access

The landing page buttons lead to a request-access form (Contact us). The team replies by email. Existing users sign in at `/login`.

## What the assistant does not do

- It answers only questions about Guildwise HQ. It does not write code, give general advice or chat about other topics.
- It does not compare Guildwise HQ with other products or make claims about them.
- It gives no legal, compliance or security-certification advice and no promises about delivery dates, service levels or custom work. For those it points to the Terms and Privacy pages and to Contact us.
- It cannot see anyone's account, data or tickets, and it does not collect personal details. For account problems, sales or support it points to Contact us.
