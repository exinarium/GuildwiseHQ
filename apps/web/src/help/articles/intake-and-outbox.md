---
title: Intake and outbox
summary: Intake from Jira and GitHub, unmapped tickets, credentials, the outbox and guardrails.
keywords: [intake, Jira, GitHub, unmapped, outbox, posting, credentials, attachments, screenshots, jira-connect, API token]
order: 10
---

**Intake** brings tickets from Jira and GitHub into Guildwise HQ. Your BA reads the ticket, asks you questions, and drafts a card with full details. **Outbox** is where draft updates go before posting back to tickets.

## Intake {#intake}

To bring a ticket into Guildwise HQ:

1. Click **Intake** in the sidebar (Owner and Admin; also an **Intake** button on the Desk page).
2. Paste a Jira issue key (e.g., `ABC-123`), a GitHub issue (e.g., `acme/web#12`, or its URL) into **Ticket or need**, or just describe what you need. The page shows what it detected.
3. Click **Tell your CEO** to hand the ticket to your CEO (Owner only), or **Work with the BA directly** (Owner) / **Start intake** (Admin) to work it out with the BA yourself in an intake chat.
4. Your BA reads the ticket (via its credentials on your workstation) and asks you about the scope and project.
5. Answer the BA's questions in the intake chat.
6. The BA drafts a card with context, requirements, acceptance criteria, test plan and how to ship it.
7. Review the card and click **Specify** when it is ready.

The card then joins the normal queue and follows your project's workflow.

**Many tickets at once:** on the Intake page switch to **Batch**, paste one ticket per line (up to 50), optionally pick a project and add a note, and click **Start batch**. The BA works through them in the background, two at a time, and creates the cards without a chat. Tickets that already have a card are skipped. When the BA cannot go on with a ticket it asks on the desk, naming the ticket; your answer resumes that ticket and the others carry on. The batch page shows each ticket's status and cards, and offers **Retry** and **Cancel batch**.

You can also ask the BA to create cards in any chat, not just during intake. The BA works with your access: it can only use projects you are a member of.

## Unmapped tickets {#unmapped-tickets}

If a ticket does not match a project (for example it is a support request for a system you do not track):

1. The BA asks on the desk ("Which project does ... belong to?").
2. Pick the project and click **Map to project**, and the BA carries on.
3. If it belongs nowhere, click **Dismiss**.

## Jira attachments {#jira-attachments}

The tool your BA reads Jira with shows the names of a ticket's attachments, but not the screenshots or design files themselves, and agents have no internet. So the BA asks your workstation's runner to download them with your Jira login. Once you have connected Jira on the workstation (see below), the BA lists the ticket's attachments, downloads them (up to 20 MB per file), looks at every screenshot and SVG, writes what they show into the cards and **attaches the relevant files to the cards** it drafts. It tells you which file went on which card. Builders and testers see the same files next to their work (see [Board and cards](/help/board-and-cards#attachments)). The BA can only reach the ticket you gave it.

## Credentials {#credentials}

- **Jira**: on the workstation run `guildwise-runner jira-connect`. It asks for your Jira address, your Atlassian e-mail and an API token (create one at id.atlassian.com, Security, API tokens; for Jira Data Center use a personal access token and no e-mail), checks them and saves the token on that computer only. The **Workstations** page then shows **Jira: Connected as ...**, **Not connected** or **Refused** (Jira rejected the token: connect again). `guildwise-runner jira-connect --status` checks it from a terminal and `--disconnect` removes it. The older `jira` entry in the runner's `config.json` still works.
- **GitHub**: uses your machine's `gh` login (configured with `gh auth login`).

Neither credential leaves the runner or travels to the server, and agents never see them. Intake happens on your workstation, not in the cloud.

## Outbox {#outbox}

When an agent drafts an update to post back to a ticket (a comment, a status change, etc.), it lands on your desk as an **Outbound update**.

The draft shows what would be posted. You can:

- **Approve and post**: post it using your own workstation's credentials.
- **Edit** the text first, then **Approve and post my edit**: the text you leave is the text that is posted.
- **Reject** (then **Reject, never post**, with an optional reason): discard the draft.

Nothing is posted before you approve. The post is made with your GitHub or Jira account, so it appears as if you wrote it.

## Guardrails {#guardrails}

Before posting, your runner checks the text against your organization's agent names and internal terms. A draft that mentions an agent by name, or gives away internal process details (review scores, rework reasons and similar), is refused even if you approved it. The agent can revise and resubmit.

This keeps your internal processes private and your tickets focused on what matters to customers.
