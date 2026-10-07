---
title: Interests
summary: Topics you watch, who can see them, creating and editing, run and delivery schedules, taste rules.
keywords: [interest, topic, watch, run schedule, delivery schedule, taste, quiet cap]
order: 14
---

An **interest** is a topic your agents watch for you automatically. It scans the web for new content, picks the best items, and delivers them to your desk on a schedule you set. Its **Digest** tab holds what it found, and you rate the items so it learns your taste. Each interest has its own research notes, ratings and taste rules.

## Who can see {#who-can-see}

- **Owners and Admins** see every interest.
- **Members and guests** see interests they created and ones shared with them by an Owner or Admin.
- An interest a Member or guest creates is private to them (and to the Owner and Admins) until an Owner or Admin shares it, with **Share with** under **Who can see it** on the interest's **Overview** tab.

## Creating and editing {#creating}

To create an interest:

1. Go to **Interests** (sidebar: Knowledge).
2. Click **+ New interest**.
3. Fill in:
   - **Name** and **Description** (markdown: the angle, what to include, the level).
   - **Vault**: Personal or Work (where files and notes live, fixed once the interest has run).
   - **What to collect**: Articles, Videos and/or Podcasts, and **Max total items per run**.
   - **Run schedule: when it scans**: a preset ("Daily at 07:00") or a custom cron, the time zone and **Look back (hours)**, or tick **Only when I press Run now** for manual scans.
   - **Deliver**: **As one digest at set times** (for example weekdays at 07:00) or **As soon as a run finishes**.
   - **Preferred agents**: a scout, curator, researcher and fact checker (a soft preference: any qualified agent takes the run at once).
4. Click **Create interest**.

To edit an interest, open it and go to the **Settings** tab. The interest page has the tabs **Overview**, **Run log**, **Digest**, **Settings** and **Taste**.

## Run and delivery schedule {#run-and-delivery}

- **Run schedule**: when the agents scan for new content. A scan can happen on a preset or custom cron schedule, or only when you press **Run scan** on the interest page.
- **Delivery**: when you get the results on your desk. Either as one digest at set times (e.g., weekdays at 07:00) or as soon as a scan finishes.

With a delivery time, items wait and arrive together as one digest. Runs can happen as often as they like; you get the digest at the set time.

## Daily quiet cap {#quiet-cap}

On the Interests page, the **Daily quiet cap** panel sets the most digest items that may reach your desk in 24 hours across all interests (by default there is no limit; click **Change** and enter **Items per day**, 1 to 1000). Items over the cap stay held and arrive with the next delivery that has room.

Everyone sees the cap; Owners and Admins change it.

Click **Deliver N now** (it appears when items are waiting) on an interest page to put what waits on your desk ahead of schedule (still within the cap).

## Research this {#research-this}

Research is on demand only. Click **Research this** on an interest or on an item in its digest:

1. Write your **Question** and pick the **Depth** (Quick, Standard or Deep).
2. A researcher and fact checker work on it.
3. The note is published in the interest's vault folder under `notes/`.
4. The run appears in the run log.

## Taste rules {#taste-rules}

Besides ratings that grow from your feedback, write explicit rules under **Explicit rules** on the **Taste** tab:

- "Skip beginner tutorials"
- `skip "Exact title"` (drops items with exactly that title)

The curators follow these rules first and they win when ratings disagree. Rules belong to the interest and reach only its runs.

Rules are written to `interests/<folder>/taste.md` in your vault. Edits you make to the **Explicit rules** block in Obsidian are overwritten; the rating lines below stay yours to edit.

## Archiving {#archiving}

Under **More actions**, **Archive** stops the interest's runs and hides it. **Restore** brings it back with a fresh schedule. **Delete permanently** (archived interests only) removes its cards, items, ratings and run log. The vault folder is never touched.
