---
title: Projects
summary: Creating projects, the priority order, project types and workflows, research cards, sharing, archiving and decision policy.
keywords: [project, priority, ranking, order, code, research, workflow, card, sharing, archiving, repository, git host, github, gitlab, bitbucket, azure devops, pull request, how finished work lands, reference repositories, mcp servers, mcp, jira, confluence, plugin, external tools, read other repositories, compare repositories, several workflows, enable workflow, default workflow, project variant, customise workflow, insert step]
order: 4
---

A project is a container for cards and agents working on a shared goal. Every card belongs to one project, and agents work on the projects you let them. Each project runs on a workflow that defines how work moves through stages (Code and Research are the built-ins).

## Creating a project {#creating-a-project}

1. Go to **Projects** and click **New project** (Owner and Admin only).
2. Enter a **Name** and a **Key**. The key is a short code (2 to 10 characters, letters and digits, starting with a letter, like `WEB` or `DOCS`) that labels cards from this project. It is suggested from the name.
3. Choose the **Workflow**: Code, Research, or a custom workflow your organization designed.
4. Click **Create project**.

For a Code project, add its repositories afterwards in the project's settings (the gear on its board), under **Repos**: give the repository name and its address (or create a new one), and click **Add repository**. Each repository shows two branches: the **main branch** (where pull requests go; default: the repository's default branch) and the **working branch** (where finished card work is combined; it is created from the main branch when it does not exist). Finished work is committed and pushed to the working branch after review and test; change **How finished work lands** in the same settings to receive pull requests instead (see [Testing and finalization](/help/testing-and-finalization#finalization)). When the two branches differ, **Open pull request** in the repository row opens a pull request from the working branch to the main branch. Research projects need no repository.

The **git host** (GitHub, GitLab, Bitbucket, Azure DevOps or a plain git server) is detected from the address; choose another one in the **Git host** list if the address is a server we cannot recognise. One project can use repositories from different hosts. If the app lives in a folder of the repository (a monorepo, for example `src/app`), fill in **Project path** when you add it, or later with **Change** under the repository; leave it empty when the app is at the top. The development environment check, the package installs and the agents' build and test commands all run from that folder. Under **Access** you can choose how the workstation reaches the repository: its default, an API token / CLI login, or an SSH key (see [SSH instead of an API token](/help/workstations-and-installer#git-hosts)). See [Git hosts](/help/workstations-and-installer#git-hosts) for connecting them. When you add a repository, the DevOps engineer clones it onto the project's workstations and installs what it needs (see [New repositories and the toolchain](/help/devops-and-hygiene#setup)).

You can also click **Pick from my repositories** to list the repositories of a connected host and use one, or choose **Create a new repository**: the form then asks for what that host needs (owner for GitHub, group for GitLab, workspace for Bitbucket, organization and project for Azure DevOps).

Cards stay as drafts until you are ready to specify them. A new project goes to the bottom of your priority order.

## Architect settings {#architect-settings}

Under **Architect** in the project settings the owner decides whether new cards are investigated and designed by an architect before the builder starts (off by default), whether the latest main branch is merged first (on by default), and where the architect's reports go (a folder in the repository, or the knowledge vault). See [The architect](/help/architect).

## Reference repositories {#reference-repos}

By default an agent only sees the folder of the card it is working on (and, in a chat about a project, the project's own repositories). To let a project's agents **read** other code, for example to compare two repositories or look up how a library is used, the project owner adds **Reference repositories** in the project settings:

1. Open the project's settings (the gear on its board) and go to **Reference repos**.
2. Under **Add a reference repository** pick a repository and click **Add**. The list has a **Projects** section (the repositories of the organization's other projects: organization Owners and Admins see all of them, everyone else the projects they belong to) and an **On <workstation>** section for each of your workstations, which lists any repository cloned there, even one that belongs to no project. Use **Remove** to take one away again.

The agents then get those repositories **read-only**, in card work and in chats, on every workstation that has them cloned. They cannot change them, and secret files inside (`.env` files, keys, certificates) stay blocked. Every repository you do not pick stays blocked, as does everything else on the workstation (other projects, this platform's own code). A repository you pick from a workstation is opened on that workstation; if it has a remote, also on your other workstations that have a clone of the same remote. Nothing is added on its own. Only the project owner can change the list; other managers can see it. The agents are told which folders they can read, so they ask you to add a repository instead of searching for a setting.

## MCP servers {#mcp-servers}

External tools such as Jira or Confluence reach your agents through **MCP servers** from the Claude Code plugins installed and enabled on your workstation. Agents do not see your own Claude Code setup, so each server must be handed over deliberately, and two things are needed:

1. In the project's settings, **MCP servers**, the organization **Owner** picks the server under **Grant an MCP server** and clicks **Grant** (**Remove** takes it away). Administrators and project owners who are not the Owner can read the list but not change it. If the list of servers is empty, install and enable a plugin on a connected workstation; the runner reports it within a few minutes.
2. The agent's **role** must also have the server in its tool permissions ([Custom roles](/help/org-chart-and-design#custom-roles), **What it may do**, **External tools**). Without it the agent cannot call the server's tools even when the project granted it.

The agent then works with the access of your signed-in plugin, so it can reach what you can reach. A server whose tools can **write, send or delete** lets an agent change data in that service as you: each server shows a warning, so prefer read-only use and grant such servers only to roles you trust with it. The tools an agent called are listed on the card under **External tools used**. If the plugin needs a sign-in, do it once in Claude Code on the workstation. The DevOps engineer is not affected by this setting.

## Workflows of a project {#workflows}

A project has one **primary** workflow (its type) and can enable more. Open the project's settings, **Workflows** (organization Owners and Admins can change it; everyone on the project can see it).

- **Enable** another workflow from the list, and tick **Default for** under the card types it should handle. A card type can be the default of one workflow only; with no default the primary workflow runs it. When a type has more than one workflow, **New card** shows a **Workflow** list.
- **Customise** (Code and approved custom workflows) opens the workflow builder in project scope: the base steps are locked and **Insert step after ...** adds your own, either a custom step or the **Investigate & design** template (done by the architect). You can rename, move and remove the steps you added, see the flow in the diagram, walk a sample card through it with **Try a card**, and **Compare with previous** shows what your draft changes. Problems are listed at the top and on the step they are about. **Save draft** keeps your work; **Send for approval** puts the result, a **project variant**, on the owner's desk: it needs approval before any card uses it, running cards keep the version they started on, and a new version affects new cards only. When the base workflow has a newer version the row says so and **Rebase** applies your steps to it as a new draft.
- **Disable** removes a workflow from the project's choices; its open cards finish as planned. The primary workflow always stays.

The board shows the columns of every enabled workflow, a step you inserted appears where you put it, and a card on a workflow other than the primary shows the workflow's name on its tile.

## The priority order {#ranking}

Your organization's projects are ranked: the project at the top of the **Projects** page is the most important. When an agent looks for its next card, it takes work in this order:

1. **Scheduled work** first: the cards of schedules, the scans of interests and an on-demand **Research this** (interests are not ranked; they run on their own schedule, and their budgets and the daily quiet cap limit how much they take).
2. The agent's **own rework**: cards that came back to it from review.
3. Its **focus** projects, if you set any (a gentle preference, see Agents).
4. The **project order**: cards of the project higher on the page come before cards of the one below.
5. Then the card's own priority, how long it has waited, and its dependencies.

A shift that has started is never interrupted: a more important card waits for the current shift to end.

To change the order (Owner and Admins):

1. Go to **Projects**.
2. Drag a project by its grip (the dotted handle on the left) to a new place. Or press **Move up** or **Move down** on a row. With the grip focused, the up and down arrow keys move it too, and Home and End send it to the top or bottom.
3. The order saves by itself. If the projects changed since you loaded the page (someone added or archived one), the page reloads and you drag again.

Members and Guests see the order but cannot change it. Archived projects are not ranked; a restored project returns to its old place. Projects you are a guest of in other organizations are listed under **Shared with you** and are not part of your order. The hidden projects behind interests never appear here.

When you filter by department the order cannot be changed (it only makes sense for all projects): clear the filter first.

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
