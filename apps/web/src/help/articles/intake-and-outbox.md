---
title: Intake and outbox
summary: Intake from Jira and GitHub, unmapped tickets, credentials, the outbox and guardrails.
keywords: [intake, Jira, GitHub, unmapped, outbox, posting, credentials]
order: 10
---

**Intake** brings tickets from Jira and GitHub into Guildwise HQ. Your BA reads the ticket, asks you questions, and drafts a card with full details. **Outbox** is where draft updates go before posting back to tickets.

## Intake {#intake}

To bring a ticket into Guildwise HQ:

1. Click **Intake** on the desk (or go to **Projects > Intake**).
2. Paste a Jira issue key (e.g., `ACME-123`) or a GitHub issue URL.
3. Your BA reads the ticket (via its credentials on your workstation) and asks you about the scope and project.
4. Answer the BA's questions in the chat.
5. The BA drafts a card with context, requirements, acceptance criteria, test plan and how to ship it.
6. Review the card and click **Specify** when it is ready.

The card then joins the normal queue and follows your project's workflow.

You can also ask the BA to create cards in any chat, not just during intake. The BA works with your access: it can only use projects you are a member of.

## Unmapped tickets {#unmapped-tickets}

If a ticket does not match a project (for example it is a support request for a system you do not track):

1. The BA asks on the desk.
2. You can map it to an existing project or mark it out of scope.
3. If out of scope, it lands as a desk notice for your records.

## Credentials {#credentials}

- **Jira**: set up via your runner's config file (stays on your machine).
- **GitHub**: uses your machine's `gh` login (configured with `gh auth login`).

Neither credential leaves the runner or travels to the server. Intake happens on your workstation, not in the cloud.

## Outbox {#outbox}

When an agent drafts an update to post back to a ticket (a comment, a status change, etc.), it lands on your desk as an **Outbox approval**.

The draft shows what would be posted. You can:

- **Approve**: post it immediately using your account and credentials.
- **Edit**: make changes and then approve (only your edits appear in the post).
- **Reject**: discard the draft.

The post is made with your GitHub or Jira account, so it appears as if you wrote it.

## Guardrails {#guardrails}

Before posting, the outbox scrubs updates to remove:

- **Agent names**: replaced with role descriptions (e.g., "the tester" instead of "Agent Alice").
- **Internal process details**: review scores, rework reasons, step counts and other team details.

If a draft breaks these rules, it is rejected by your runner. The agent can revise and resubmit.

This keeps your internal processes private and your tickets focused on what matters to customers.
