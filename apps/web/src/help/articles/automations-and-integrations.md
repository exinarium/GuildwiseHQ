---
title: Schedules and integrations
summary: Creating schedules, triggers and actions, feeds, how scans work, integrations and webhooks.
keywords: [schedule, trigger, action, cron, webhook, feed, integration]
order: 15
---

A **schedule** is a trigger (when something happens) and one action (what to do). Schedules automate your work: create a card on a cadence, run tests, deploy, or post to Slack.

## Schedules {#schedules}

To create a schedule:

1. Go to **Schedules** and click **New schedule**.
2. Pick a trigger (the **When** step) and click **Next**.
3. Pick an action (the **What** step) and click **Next**.
4. Set details (the **Details** step).
5. Click **Create schedule**.

Schedules run on your workstation or on the server, never in your browser. Each schedule can be run now, paused or resumed, edited and deleted. You see the history of every run, with logs when something fails. Schedules that act for the whole organization (no project) can only be changed by the Owner and Admins.

## Triggers {#triggers}

A trigger is when the schedule fires:

- **On a schedule**: A cron time with presets ("Weekdays at 07:00", "Every hour") or your own five-field cron, in a time zone you pick. Missed fires (server was down) happen once, not many times.
- **When something happens**: A phase is completed, a card is finalized, an interest run finishes or a project is converted. The server watches; no agent polls.
- **When an issue is labelled**: A GitHub or Jira issue gets a label. One of your workstations polls on a cadence you set.
- **Only when I run it**: No automatic trigger: use **Run now** on the Schedules page.

## Actions {#actions}

An action is what happens:

- **Create a card** from a template (title, type, fields). Queued ahead of normal work.
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

Schedules can integrate with GitHub, Jira, Slack, Microsoft Teams, n8n, Zapier and more.

**GitHub and Jira polling**: polls for new issues and brings them into intake.

**Webhooks**: send signed JSON to any URL. Every request includes a signature header (`X-AOM-Signature: sha256=<hmac-sha256 of "timestamp.body">`, with the timestamp in `X-AOM-Timestamp`). Failed deliveries (5xx, 429, 408, network error) are retried after 1 minute, 5 minutes, 30 minutes and 2 hours, five tries in all. Other 4xx errors are final.

When creating a webhook, the schedule shows its secret once: the key for the signature. Click **New secret** to replace it.

Use **Send test** to send a test delivery now (logged but never retried, not counted as a run).

**E-mail digests**: the floor report or a project summary, sent from the site's mail account at the time you set.

## History {#history}

Click **History** on a schedule to see every run: when, what triggered it, what it did, and the reason if it failed. For webhooks and e-mails, see the **Deliveries** log with every try, HTTP status and duration.
