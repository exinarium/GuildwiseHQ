---
title: Intake and outbox
summary: Intake from Jira and GitHub, unmapped tickets, credentials, the outbox and guardrails.
keywords: [intake, Jira, GitHub, unmapped, outbox, posting, credentials]
order: 10
---

**Intake** brings tickets from Jira and GitHub into Guildwise HQ. Your BA reads the ticket, asks you questions, and drafts a card with full details. **Outbox** is where draft updates go before posting back to tickets.

## Intake {#intake}

To bring a ticket into Guildwise HQ:

1. Click **Intake** in the sidebar (Owner and Admin; also an **Intake** button on the Desk page).
2. Paste a Jira issue key (e.g., `ABC-123`), a GitHub issue (e.g., `acme/web#12`, or its URL) into **Ticket or need**, or just describe what you need. The page shows what it detected.
3. Click **Start intake**.
4. Your BA reads the ticket (via its credentials on your workstation) and asks you about the scope and project.
5. Answer the BA's questions in the intake chat.
6. The BA drafts a card with context, requirements, acceptance criteria, test plan and how to ship it.
7. Review the card and click **Specify** when it is ready.

The card then joins the normal queue and follows your project's workflow.

You can also ask the BA to create cards in any chat, not just during intake. The BA works with your access: it can only use projects you are a member of.

## Unmapped tickets {#unmapped-tickets}

If a ticket does not match a project (for example it is a support request for a system you do not track):

1. The BA asks on the desk ("Which project does ... belong to?").
2. Pick the project and click **Map to project**, and the BA carries on.
3. If it belongs nowhere, click **Dismiss**.

## Credentials {#credentials}

- **Jira**: set up via your runner's config file (stays on your machine).
- **GitHub**: uses your machine's `gh` login (configured with `gh auth login`).

Neither credential leaves the runner or travels to the server. Intake happens on your workstation, not in the cloud.

## Outbox {#outbox}

When an agent drafts an update to post back to a ticket (a comment, a status change, etc.), it lands on your desk as an **Outbox approval**.

The draft shows what would be posted. You can:

- **Approve and post**: post it using your own workstation's credentials.
- **Edit** the text first, then **Approve and post my edit**: the text you leave is the text that is posted.
- **Reject** (then **Reject, never post**, with an optional reason): discard the draft.

Nothing is posted before you approve. The post is made with your GitHub or Jira account, so it appears as if you wrote it.

## Guardrails {#guardrails}

Before posting, your runner checks the text against your organization's agent names and internal terms. A draft that mentions an agent by name, or gives away internal process details (review scores, rework reasons and similar), is refused even if you approved it. The agent can revise and resubmit.

This keeps your internal processes private and your tickets focused on what matters to customers.
