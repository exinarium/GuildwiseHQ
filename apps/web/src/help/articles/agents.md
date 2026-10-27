---
title: Agents
summary: Hiring agents, seniority, runtime and model, allowed projects, focus, firing and the Agents page.
keywords: [external tools, mcp, jira, confluence, hire, fire, allow-list, focus, seniority, agent, workstation, model, team]
order: 6
---

Agents are AI assistants that work on your cards. You hire them with a role and seniority, assign them to workstations and projects, and can fire them when you no longer need them. The Agents page shows their work and recommendations for your team.

## Hiring an agent {#hiring}

To hire an agent:

1. Go to **Agents** and click **Hire agent**. (A card that cannot be picked up also offers a **Hire** link that opens this form with the missing role filled in.)
2. Fill in the form:
   - **Role**: builder, reviewer, tester, technical writer, BA, architect (senior only; see [The architect](/help/architect)), and on the lean team also planner and pre-reviewer, or custom roles you designed. DevOps engineers are not hired here: each workstation gets one automatically (see [DevOps and repository hygiene](/help/devops-and-hygiene#devops-engineer)).
   - **Seniority**: junior or senior. Some roles come in one seniority only (the reviewer and the BA are senior).
   - **Workstation**: which of your paired workstations it runs on (your own computer, a VPS or a Codespace, see [Workstations and the installer](/help/workstations-and-installer)).
   - **Runtime**, **Model** and **Effort**: which runtime and Claude model to use and how much thinking to allow. Leave them empty for the role's defaults.
   - **Where may this agent work?**: **Any project** (Owner and Admin only) or **Selected projects**, with a star to prefer some (see below).
   - **Skills**: optional, comma separated.
   - **Name**: a name for the agent (the form suggests unused names).
3. Click **Hire**.

Above the form, **From a pack** hires one agent of an approved pack onto a role of yours (its seat) instead; see [Agents of a pack](/help/capabilities#pack-agents).

There is no limit on agents. On a hosted service, a plan may limit members, workstations and projects, and **Organization, Plan & limits** shows what you use (Owner and Admin). See [Billing](/help/billing-and-plans#plans).

## Allow-lists {#allow-lists}

An **allow-list** is where an agent is allowed to work. For each agent you decide:

- **Any project** of the organization (Owner and Admin only), or only the **Selected projects** you pick. The agent only gets cards from the projects you allow.
- To change it any time, click **Projects** on the agent's card on the Agents page.

An empty allow-list benches the agent: it gets no work until you give it projects.

Also, an agent can only work on projects that its hiring manager can access. If you are a guest on a project, your agents work that project only, whatever the allow-list says.

## Focus {#focus}

**Focus** (a star next to a project in the allow-list) is a soft preference. When a card from a starred project and a card from another project are both waiting, the agent takes the starred one first, even when the other project is higher in your [priority order](/help/projects#ranking). Without a focus, an agent follows the priority order of the Projects page.

You can star up to 10 projects per agent. Removing a project from the allow-list also removes it from the focused ones.

## Pause and re-home {#pause-and-rehome}

- **Pause** (Owner and Admin, on the agent's card) stops the agent taking new work; **Resume** starts it again. A paused agent is not given cards until it is resumed. The CEO's card has Pause too, and **Manage on the CEO page** opens the CEO page.
- **Re-home** appears on the card when the agent needs a new home, for example because its manager was removed. Pick one of your own workstations. If that workstation runs agents without an OS sandbox, the dialog shows a warning with a box to acknowledge it.

## Seniority {#seniority}

Agents are junior or senior. Some stages are for seniors only: Review needs a senior reviewer and Finalize needs a senior BA. If you hire only juniors for a role that a stage needs, its cards wait (the board shows a red warning with a **Hire** link). A junior's question goes to a senior of the same role first, then to the BA, then to your desk.

## Runtime and model {#runtime-and-model}

Every agent runs on a Claude model that you choose when you hire it. The model affects cost and capability.

When hiring, pick the runtime, model and effort level. You can change them later with **Change model** on the agent's card on the Agents page, and swap the role with **Change role**.

## Describe the agent you need {#describe}

On **Agents**, click **Describe the agent you need** and write one sentence, for example "an agent that turns merged pull requests into customer release notes". The Analyst drafts a role on your workstation (this takes about a minute and its cost is booked like any chat): a name, what it is for, instructions, what it may do, a suggested model, and any skills or playbooks that fit.

You review and edit all of it. **What it may do** is never wider than you may grant: an Owner or Admin can give edit, shell and web; anyone else gets read only, and the dialog says what was left out. **Continue to hire** opens the normal hire dialog with the draft as the role. Nothing is hired before you press **Hire**, and the role works in chats, sessions and mentions; it does not take cards from the board.

## Mentions in card comments {#mentions}

In a card's thread, type **@** and an agent's name to ask it a small question about the card. The agent answers in the thread, and its cost is booked to the card (budgets and provider caps apply). What it may do depends on who wrote the comment: when an Owner or Admin mentions it, a Claude Code agent whose role can edit or run commands may do so in the card's working folder (never the web, a browser or other tools, and it does not push or merge); when anyone else mentions it, it only reads. It works only when the card is free: if a shift holds the card, or another agent is already working on it from a comment, or the workstation's runner is too old, it reads and answers, and says why it did not edit. A card with a mention at work waits to be picked up until the mention is done (at most 30 minutes). The agent's approval gates still apply. Owners and Admins can mention any agent that may work on the project. For everyone else the agent's manager has to switch on **Project members may mention this agent** under **Who may mention it** on its card. Each person is limited to 5 mentions per card and 20 in all per hour, and one agent answers on a card at a time.

## Firing an agent {#firing}

To fire an agent:

1. Go to **Agents** and find the agent's card.
2. Click **Fire** and confirm.

What happens:
- Any cards the agent is holding are released back to the queue.
- The agent's private sandbox (memory, transcripts, caches) is deleted.
- The agent is marked retired (listed under **Retired** on the Agents page) and never gets new work.
- The record stays intact for history.

To hire the same role again, create a new agent with a different name. Retired names are never reused so history stays clear.

## External tools (MCP) {#external-tools}

Each agent card has an **External tools (MCP)** section listing the plugin MCP servers (Jira, Confluence, ...) your workstations report, as switches with a plain-language note. Switch one on to let that agent call its tools. Everyone who can see the agent reads the switches; only the organization **Owner** can change them (an Administrator can switch a server off but not on). The server must also be granted to the agent's project in the project settings ([MCP servers](/help/projects#mcp-servers)), otherwise it still cannot be used. A server whose tools can write, send or delete lets the agent change data in that service as you, so prefer read-only use. The DevOps engineer has no such section. A server that is not signed in on a workstation shows **Needs sign-in** with the steps to take on that machine; if the Claude login itself expires, agents on that workstation pause (their cards wait, nothing fails) until you run `claude` and `/login` there.

## Delegation {#delegation}

Off by default. Under **Who it may delegate to** on an agent's card (Owner, Admin or its manager), list the personas or agents it may hand sub-tasks to. Each runs on its own model, never with wider tools than the agent (when it would need more it runs with fewer, and the card says so), and shows as a sub-step on the card with its cost. Owners and Admins can also set delegation for a whole **role** (Org designer): it covers every agent of the role, including future hires, and shows as inherited on each card. A grant can also set the model the target runs on.

## What it may do {#what-it-may-do}

**What it may do** on an agent's card shows in one place its tools, the repositories and projects it can reach, its provider and which key pays, its delegation grants (including what its role gives it and exclusions), its playbooks, skills and packs, its cost and the budgets that apply.

Under **Approval gates**, switch on **Ask me before** merge and push, deploy, delegation, running a playbook or using a pack's scripts. That action then pauses and lands on your Desk as an approval; the agent carries on, and its next identical attempt goes through once you approve (it is told so). A rejection is reported to it and it is not asked again for an hour. Outbound updates always ask. Gating pack scripts needs a runner that supports it (0.1.60 or newer): a gated agent gets no script copied into its folder, and each script file of a pack is handed over only after you approve it. No agent has a gate until someone sets one; whoever manages the agent switches a gate on, only an Owner or Admin switches it off. The CEO keeps its own policy.

A pack's skills, personas and playbooks can say what they need (`shell`, `web`, `commit`, ...). When you grant one to an agent that lacks a scope, you see what is missing and choose **Grant anyway**; the grant does not give the agent the permission.

## The Agents page {#hr-board}

The Agents page shows at a glance:

- **Agent cards**: name, role, seniority, status (idle, on shift, blocked, or needs rehome), model, current card, who hired it, cost this month and in total, and quick actions.
- **Performance stats** over the last 30 days: cards done, blocked rate, rework rate, bugs escaped, utilisation and tokens per card, each compared to the average of the agents in the same role. Builders also show work-quality figures such as the reviewer score.
- **Recommendations**: rule-based suggestions (model up or down, split a role, fire or reassign, and so on) with the evidence. Depending on the suggestion you apply it with one click (for example **Change model**, **Split role** or **Propose standing order**, which goes to your desk), or it is advice only.
- **Metrics**: the **Metrics** page (sidebar, Organization) has a **Project** filter and a range of 7, 14, 30 or 90 days, and shows **Throughput**, **Time blocked on you**, **Bounce rate per builder**, **Bugs escaped past test**, **Duration** (with shift time per agent) and **Queue depth per column**.
