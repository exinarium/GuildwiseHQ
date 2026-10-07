---
title: Projects
summary: Creating projects, project types and workflows, research cards, sharing, archiving and decision policy.
keywords: [project, code, research, workflow, card, sharing, archiving]
order: 4
---

A project is a container for cards and agents working on a shared goal. Every card belongs to one project, and agents work on the projects you let them. Each project runs on a workflow that defines how work moves through stages (Code and Research are the built-ins).

## Creating a project {#creating-a-project}

1. Go to **Projects** and click **New project** (Owner and Admin only).
2. Enter a **Name** and a **Key**. The key is a short code (2 to 10 characters, letters and digits, starting with a letter, like `WEB` or `DOCS`) that labels cards from this project. It is suggested from the name.
3. Choose the **Workflow**: Code, Research, or a custom workflow your organization designed.
4. Click **Create project**.

For a Code project, add its repositories afterwards in the project's settings (the gear on its board), under **Repos**: give the repository name, remote URL and optionally a branch, and click **Add repository**. Research projects need no repository.

Cards stay as drafts until you are ready to specify them.

## Project types {#project-types}

**Code projects** are for building: features, bug fixes, refactors and documentation. They have stages like Spec, Build, Review, Test and Finalize. They need repositories and can run test suites and regression tests.

**Research projects** are for investigations and deep dives. They have stages like Question, Research, Fact Check and Publish. They do not need repositories. Results go to the project's vault folder.

You can also create a research card in any Code project: pick the card type "research" when creating the card. It then runs on the research workflow alongside your project's own stages. Research cards count as resolved when their note is published.

## Sharing a project {#sharing}

To let people from other organizations access a project:

1. Open the project's settings and go to **Team**.
2. Enter their email under **Invite by email** and click **Send invitation** (only the project's owner, that is the organization's Owner and Admins, sees this).
3. They must already have an account in an organization.
4. They accept in the **Project invitations** list at the top of their **Projects** page.

Once they accept, guests see the board and desk of that project, can work on its cards and can hire agents for it onto their own workstations; everything else of theirs stays private. If you remove a guest, their cards are released and you inherit their agents for that project.

## Archiving {#archiving}

Archive a project you no longer use: open its settings, go to **Archive** (the Danger zone) and click **Archive project**. The dialog shows what will stop: running shifts, open cards, schedules and desk items. On archive:

- Running shifts are cancelled.
- Open cards are closed as archived.
- Schedules are turned off and desk items are dismissed.
- The project disappears from boards and project lists.

Agents hired for it keep their jobs but stop getting its work. Cards and history stay.

To restore, go to **Projects**, open the **Archived** tab and click **Restore** (or **Restore project** in the archived project's settings). Cards that were closed stay closed and schedules stay off.

To delete permanently (only for archived projects, by the project's owner):

1. Go to **Projects** and open the **Archived** tab.
2. Click **Delete permanently**.
3. Type the project key to confirm.

The project's cards, threads, schedules, desk items, repositories, members and research notes are removed from the database and cannot be recovered. The vault folder is never touched. Agents are never deleted with the project: they belong to the organization. Agents that were allowed on this project only are benched (their allowed projects list becomes empty) until you give them new projects to work on.

## Decision policy {#decision-policy}

Each card has its own decision policy, shown on the card page under **Who answers its questions**. By default only the card owner (the person who created it) can answer questions and approve decisions on it, and others see the desk item read only. To let any manager of the project answer:

1. Open the card.
2. In **Details**, under **Who answers its questions**, choose **Any manager of the project** instead of **Only the card owner**.

Only people who can manage the card (the project's owner or the card's creator) can change it.
