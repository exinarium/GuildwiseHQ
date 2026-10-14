---
title: Agents
summary: Hiring agents, seniority, runtime and model, allowed projects, focus, firing and the HR board.
keywords: [external tools, mcp, jira, confluence, hire, fire, allow-list, focus, seniority, agent, workstation, model, team]
order: 6
---

Agents are AI assistants that work on your cards. You hire them with a role and seniority, assign them to workstations and projects, and can fire them when you no longer need them. The HR board shows their work and recommendations for your team.

## Hiring an agent {#hiring}

To hire an agent:

1. Go to **Agents** and click **Hire agent**. (A card that cannot be picked up also offers a **Hire** link that opens this form with the missing role filled in.)
2. Fill in the form:
   - **Role**: builder, reviewer, tester, technical writer, BA, architect (senior only; see [The architect](/help/architect)), or custom roles you designed. DevOps engineers are not hired here: each workstation gets one automatically (see [DevOps and repository hygiene](/help/devops-and-hygiene#devops-engineer)).
   - **Seniority**: junior or senior. Some roles come in one seniority only (the reviewer and the BA are senior).
   - **Workstation**: which of your paired workstations it runs on (your own computer, a VPS or a Codespace, see [Workstations and the installer](/help/workstations-and-installer)).
   - **Runtime**, **Model** and **Effort**: which runtime and Claude model to use and how much thinking to allow. Leave them empty for the role's defaults.
   - **Where may this agent work?**: **Any project** (Owner and Admin only) or **Selected projects**, with a star to prefer some (see below).
   - **Skills**: optional, comma separated.
   - **Name**: a name for the agent (the form suggests unused names).
3. Click **Hire**.

There is no limit on agents. Your plan limits only members, workstations and projects; **Organization, Plan & limits** shows what you use (Owner and Admin). See [Plans and billing](/help/billing-and-plans#plans).

## Allow-lists {#allow-lists}

An **allow-list** is where an agent is allowed to work. For each agent you decide:

- **Any project** of the organization (Owner and Admin only), or only the **Selected projects** you pick. The agent only gets cards from the projects you allow.
- To change it any time, click **Projects** on the agent's card on the Agents page.

An empty allow-list benches the agent: it gets no work until you give it projects.

Also, an agent can only work on projects that its hiring manager can access. If you are a guest on a project, your agents work that project only, whatever the allow-list says.

## Focus {#focus}

**Focus** (a star next to a project in the allow-list) is a soft preference. When a card from a starred project and a card from another project are both waiting, the agent takes the starred one first, even when the other project is higher in your [priority order](/help/projects#ranking). Without a focus, an agent follows the priority order of the Projects page.

You can star up to 10 projects per agent. Removing a project from the allow-list also removes it from the focused ones.

## Seniority {#seniority}

Agents are junior or senior. Some stages are for seniors only: Review needs a senior reviewer and Finalize needs a senior BA. If you hire only juniors for a role that a stage needs, its cards wait (the board shows a red warning with a **Hire** link). A junior's question goes to a senior of the same role first, then to the BA, then to your desk.

## Runtime and model {#runtime-and-model}

Every agent runs on a Claude model that you choose when you hire it. The model affects cost and capability.

When hiring, pick the runtime, model and effort level. You can change them later with **Change model** on the agent's card on the Agents page, and swap the role with **Change role**.

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

## HR board {#hr-board}

The HR board is the Agents page. It shows at a glance:

- **Agent cards**: name, role, seniority, status (idle, on shift, blocked, or needs rehome), model, current card, who hired it, cost this month and in total, and quick actions.
- **Performance stats** over the last 30 days: cards done, blocked rate, rework rate, bugs escaped, utilisation and tokens per card, each compared to the average of the agents in the same role. Builders also show work-quality figures such as the reviewer score.
- **Recommendations**: rule-based suggestions (model up or down, split a role, fire or reassign, and so on) with the evidence. Depending on the suggestion you apply it with one click (for example **Change model**, **Split role** or **Propose standing order**, which goes to your desk), or it is advice only.
- **Metrics**: the **Metrics** button opens team throughput, time blocked on you, queue depth, bounce rate per builder and average time to finish.
