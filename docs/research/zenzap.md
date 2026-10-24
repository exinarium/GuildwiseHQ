# Zenzap: what we could pull into Guildwise (research, 2026-10-24)

Zenzap (Loop Connect LTD; backed by Bessemer and Lightspeed) is a work-chat app for frontline and deskless teams, such as restaurants, shift workers, construction and clinics. On 14 Oct 2026 it launched AI agents that sit inside group chats. Almost all of this comes from Zenzap's own marketing pages, so treat claims as unverified.

**Sources:**
- https://www.zenzap.co/built-in-agents
- https://www.zenzap.co/pricing
- https://www.bvp.com/news/zenzap-the-agent-has-joined-the-work-conversation
- https://www.reworked.co/collaboration-productivity/zenzap-brings-ai-agents-to-frontline-work-chat/
- https://www.calcalistech.com/ctechnews/article/b1zgob6jfe

## What they do

- **Chat-first work surface.** Tasks come from messages, and agents join group chats as participants that anyone in the thread can assign work to.
- **Plain-language agent builder.** They claim an agent takes under 90 s to build, from a phone. A gallery of example agents covers shift handover, maintenance follow-up, onboarding, invoice chasing, lead routing and attendance checks.
- **Governance as separate toggles:** who can add agents, what data each agent can reach, what it may do, and which actions need a one-tap **Approve** in the chat. Everything is logged.
- **Enterprise claims:** SOC 2 Type II, ISO 27001, HIPAA (BAA), EU/US residency, key management, audit export, offboarding cut-off. They advertise 400+ connectors.
- **Pricing:** credit-metered team tiers. Free has 100 credits; Business+ is $50/mo for 5 users.

## How this maps to Guildwise (our side checked from memory of the codebase; verify before building)

| Zenzap pattern | Guildwise today | Gap |
|---|---|---|
| Approve in the flow, from the phone | Decision Desk items; web push exists (Q54/Q67 pushes use it); there are mobile web pages | No one-tap approve or answer from the notification itself. You open the desk |
| Agents as participants in a thread | Boardroom and Discovery sessions have agent participants; chats are 1:1 with an agent | No "@agent, do this" inside a card's comment thread |
| Per-agent governance matrix | Role `AgentPermissions` (tools, shell denies, writable globs, mayCommit), CEO policy, delegation grants, spend caps | No single per-agent screen for "what it may do and what needs approval". Approval gates for side-effecting actions (deploy, merge, send mail) are spread out |
| Plain-language agent builder | Role builder, BA-drafted custom roles, hire-from-pack, capability editor | No one-sentence "describe the agent you need" path that drafts the role for review |
| Shift-handover digest | Daily floor digest (reporter) and schedules | Mostly covered; could add the "chase open items" follow-up |
| Template gallery | Built-in personas and playbooks, packs | No browsable "starter agents and playbooks" gallery with outcomes |
| Audit export and offboarding | Platform audit log, member removal | Audit export for org admins, and an explicit offboarding checklist (revoke sessions, tokens, pack credentials, workstation keys) |

## Ranked ideas to pull in

1. **Answer and approve from the notification (M).** Desk pushes carry actions (Approve, Reject, the quick options), with a signed one-tap link that opens a minimal confirm page on mobile. This is the owners' core loop.
2. **Per-agent "what it may do" screen with approval gates (M).** One view per agent covering tools, repos, data, provider/key, delegation grants and spend. Side-effecting actions (merge, deploy, outbound mail, pack scripts) can be set to "needs approval", which routes to the desk. Packs declare the scopes they need.
3. **@agent in card comments (M–L).** Mention a hired agent in a card thread to hand it a small task. It runs as a delegated child run, with cost booked to the card. This reuses R3b delegation.
4. **Describe-an-agent quick hire (S–M).** One sentence produces a drafted role (instructions, permissions, model), shown for review before hiring. It reuses the BA role drafting and the capability editor.
5. **Starter gallery (S).** Curated built-in personas and playbooks with a one-line outcome each, such as "Release notes", "PR triage", "Weekly status" or "Incident follow-up". Shown on first run and under Capabilities.
6. **Follow-up and chase (S).** Daily digest items that are still open after N days get a nudge to the owner, or are re-queued to the agent.
7. **Audit export and offboarding checklist (S–M).** CSV/JSON export of org audit events. When a member is removed, a checklist revokes sessions, API tokens, pack credentials, workstation pairings and provider keys.

## Don't copy

- **Replacing the card board with chat.** It loses the traceable spec → build → review → test state.
- **Credit metering.** Our agents run on the owner's own keys and subscriptions, so credits would double-charge.
- **Connector-count marketing.** For software teams, depth in GitHub/GitLab/Jira/MCP and git packs matters more.
- **No-review agent creation for agents with repository access.** Keep the review gate.
- **Unverified compliance badges.** Claim only certifications we actually hold.
