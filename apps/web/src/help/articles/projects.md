---
title: Projects
summary: Creating projects, project types and workflows, research cards, sharing, archiving and decision policy.
keywords: [project, code, research, workflow, card, sharing, archiving]
order: 4
---

A project is a container for cards and agents working on a shared goal. Every card belongs to one project, and agents work on the projects you let them. Projects have types (Code and Research are the built-ins) and workflows that define how work moves through stages.

## Creating a project {#creating-a-project}

1. Go to **Projects** and click **Create project** (Owner and Admin only).
2. Enter a name and key. The key is a short code (like `WEB` or `DOCS`) that labels cards from this project.
3. Choose a type (Code, Research, or a custom workflow your organization designed).
4. Pick the domain: Work or Personal.
5. For a Code project, add repositories by URL or by linking to ones already scanned on a workstation.
6. For Code projects, set up vaults if you want shared knowledge (optional: your personal vault and your organization's shared vault).
7. Click **Create**.

Cards stay as drafts until you are ready to move them to the queue.

## Project types {#project-types}

**Code projects** are for building: features, bug fixes, refactors and documentation. They have stages like Spec, Build, Review, Test and Finalize. They need repositories and can run test suites and regression tests.

**Research projects** are for investigations and deep dives. They have stages like Question, Research, Fact Check and Publish. They do not need repositories. Results go to the project's vault folder.

You can also create a research card in any Code project: pick the card type "research" when creating the card. It then runs on the research workflow alongside your project's own stages. Research cards count as resolved when their note is published.

## Sharing a project {#sharing}

To let people from other organizations access a project:

1. Go to **Projects > Settings > Members**.
2. Enter their email and click **Invite**.
3. They must already have an account in an organization.
4. They accept in their **Project invitations** inbox.

Guests can see the board, work on the project and answer questions, but only you and other managers from your organization can change agent assignments. If you remove a guest, their cards are released.

## Archiving {#archiving}

Archive a project you no longer use: **Projects > Settings > Danger zone > Archive project**. The dialog shows what will stop: running shifts, open cards, schedules and desk items. On archive:

- Running shifts are cancelled.
- Open cards are closed as archived.
- Schedules are turned off and desk items are dismissed.
- The project disappears from boards and project lists.

Agents hired for it keep their jobs but stop getting its work. Cards and history stay.

To restore, go to **Projects > Archived > Restore**.

To delete permanently (only for archived projects and the project owner):

1. Go to **Projects > Archived**.
2. Click **Delete permanently**.
3. Type the project key to confirm.

The project's cards, history, schedules, desk items, members, and research notes are deleted and cannot be recovered. Agents are never deleted with the project: they belong to the organization. Agents that were allowed on this project only are benched (their allowed projects list becomes empty) until you give them new projects to work on.

## Decision policy {#decision-policy}

By default, only the person who created a card can answer questions and approve decisions on it. To let any manager answer:

1. Go to **Projects > Settings > Decision policy**.
2. Toggle **Allow any manager to answer decisions**.

Guests cannot change the policy, only see it.
