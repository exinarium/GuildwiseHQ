---
title: Automations and integrations
summary: Creating automations (formerly schedules), triggers and actions, feeds, how scans work, integrations and webhooks.
keywords: [automation, schedule, trigger, action, cron, webhook, feed, integration]
order: 15
---

An **automation** (called a schedule before October 2026) is a trigger (when something happens) and one action (what to do). Automations do your routine work: create a card on a cadence or when a card reaches a stage, run tests, deploy, or post to Slack.

## Automations {#schedules}

To create an automation:

1. Go to **Automations** and click **New automation**.
2. Pick a trigger (the **When** step) and click **Next**.
3. Pick an action (the **What** step) and click **Next**.
4. Set details (the **Details** step).
5. Click **Create automation**.

Automations run on your workstation or on the server, never in your browser. Each automation can be run now, paused or resumed, edited and deleted. You see the history of every run, with logs when something fails. Automations that act for the whole organization (no project) can only be changed by the Owner and Admins. Members can set up automations for their projects that make draft cards; an Owner or Admin can also let an automation queue its cards directly.

The old address `/schedules` still opens this page.

## Triggers {#triggers}

A trigger is when the automation fires:

- **On a schedule**: A cron time with presets ("Weekdays at 07:00", "Every hour") or your own five-field cron, in a time zone you pick. Missed fires (server was down) happen once, not many times.
- **When something happens**: A phase is completed, a card is finalized, an interest run finishes or a project is converted, a card **reaches a stage** of a workflow, a card of a workflow is **done**, or an **investigation is reported**. The card events can be narrowed to one workflow, one stage, a card type or a field value. The server watches; no agent polls, and each event runs an automation once.
- **When an intake ticket arrives**: the BA takes a request into intake, from an issue poll or the intake chat.
- **When an issue is labelled**: A GitHub or Jira issue gets a label. One of your workstations polls on a cadence you set.
- **Only when I run it**: No automatic trigger: use **Run now** on the Automations page.

## Actions {#actions}

An action is what happens:

- **Create a card** from a template (title, type, fields). Queued ahead of normal work, or as a **draft** that waits to be specified. An automation that reacts to an event can **fill the card from the event**: each line sets a field (the title, the context, or any card field) to a text with tokens such as `{card.ref}`, `{card.title}`, `{issue.title}`, `{issue.key}`, `{event}`, `{date}` or `{card.fields.<name>}`. Values are copied as they are and never expanded again. Cards made this way are marked as made by an automation. By default at most 20 cards per hour are made; more are skipped, with one notice on your desk. **Repeats** can stop a second card for the same source card or ticket, or with the same title.
- **Run a regression**: one regression card per platform (web, mobile, or both), queued at Test.
- **Ask DevOps**: a request to a workstation's DevOps engineer, or a repository hygiene run.
- **Ask the BA**: free-text instructions for the BA (read-only; it reads ledger, desk, vault, repositories).
- **Poll GitHub issues** or **Poll Jira issues**: new issues go into intake with the BA, one conversation each.
- **Send a webhook**: POST JSON to a URL. Supports generic JSON, Slack incoming webhooks, Microsoft Teams. Signed and retried on failure.
- **E-mail a digest**: the floor report (whole organization) or a project summary, sent at the time you set.

## How a scan works {#how-a-scan-works}

When an interest runs, a **scout** agent collects candidates, then a **curator** picks the best N overall (any mix of articles, videos and podcasts). The server:

- Keeps only items the scout really opened.
- Drops duplicates (seen URLs, same story from another source).
- Applies the maximum and content kinds the interest wants.

What reaches you follows the delivery schedule.

For videos and podcasts, transcripts are fetched (YouTube, podcast feeds). If **yt-dlp** is missing on the workstation, the scout asks DevOps to install it. Where no transcript exists, the item shows "No transcript available"; text is never made up.

## Integrations and webhooks {#integrations}

Automations can integrate with GitHub, Jira, Slack, Microsoft Teams, n8n, Zapier and more.

**GitHub and Jira polling**: polls for new issues and brings them into intake.

**Webhooks**: send signed JSON to any URL. Every request includes a signature header (`X-AOM-Signature: sha256=<hmac-sha256 of "timestamp.body">`, with the timestamp in `X-AOM-Timestamp`). Failed deliveries (5xx, 429, 408, network error) are retried after 1 minute, 5 minutes, 30 minutes and 2 hours, five tries in all. Other 4xx errors are final.

When creating a webhook, the automation shows its secret once: the key for the signature. Click **New secret** to replace it.

Use **Send test** to send a test delivery now (logged but never retried, not counted as a run).

**E-mail digests**: the floor report or a project summary, sent from the site's mail account at the time you set.

## History {#history}

Click **History** on an automation to see every run: when, what triggered it, what it did, and the reason if it failed. For webhooks and e-mails, see the **Deliveries** log with every try, HTTP status and duration.


## Starting a workflow automatically {#starts-automatically}

In the workflow builder, **Starts automatically when** lists the automations that create cards in that workflow and lets you add one. It opens the same automation form with the workflow already chosen.
