---
title: Agents
summary: Hiring agents, seniority, runtime and model, allowed projects, focus, firing and the HR board.
keywords: [hire, fire, allow-list, focus, seniority, agent, workstation]
order: 6
---

Agents are AI assistants that work on your cards. You hire them with a role and seniority, assign them to workstations and projects, and can fire them when you no longer need them. The HR board shows their work and recommendations for your team.

## Hiring an agent {#hiring}

To hire an agent:

1. Go to **Agents** or click **Hire** on the board.
2. Fill in the form:
   - **Role**: builder, reviewer, tester, technical writer, or custom roles you designed.
   - **Seniority**: junior or senior. This affects what permissions they have and their priority in the queue.
   - **Workstation**: where they run (must have the project's repositories).
   - **Model and effort**: which Claude model to use and how much thinking to allow.
   - **Name**: a name for the agent (the form suggests unused names).
   - **Skills**: special knowledge (e.g., "Playwright", "database migrations").
   - **Capacity**: how many cards they can work on at once (default 1).
3. Click **Hire**.

The first time you use Guildwise HQ, you can hire up to 2 builders and 1 of each other role (reviewer, tester, writer, DevOps). After you visit the Agents page once, these limits go away.

## Allow-lists {#allow-lists}

An **allow-list** is where an agent is allowed to work. For each agent you decide:

- **Any project** of the organization, or only specific projects you pick. The agent only gets cards from the projects you allow.
- To change it any time, click the agent's row on the Agents page and click **Projects**.

An empty allow-list benches the agent: it gets no work until you give it projects.

Also, an agent can only work on projects that its hiring manager can access. If you are a guest on a project, your agents work that project only, whatever the allow-list says.

## Focus {#focus}

**Focus** (a star next to a project) is a soft preference. When a card from a starred project and a card from another project are both waiting, the agent takes the starred one first.

You can star up to 10 projects per agent. Removing a project from the allow-list also removes it from the focused ones.

## Seniority {#seniority}

Agents are junior or senior. This affects permissions and priority:

- **Junior**: fewer permissions (cannot merge, for example); lower queue priority.
- **Senior**: full permissions; higher queue priority.

Some stages need seniors (e.g., Review needs a senior reviewer). If you hire only juniors, review cards wait.

## Runtime and model {#runtime-and-model}

Every agent uses Claude (Claude Opus 4, Claude Sonnet 4.5, or another version). The model affects cost and capability.

When hiring, pick the model and effort level. You can change both later on the agent's card on the Agents page.

## Firing an agent {#firing}

To fire an agent:

1. Go to **Agents** and click the agent's row.
2. Click **Fire** and confirm.

What happens:
- Any cards the agent is holding are released back to the queue.
- The agent's private sandbox (memory, transcripts, caches) is deleted.
- The agent is marked retired: hidden from hiring, never gets new work.
- The record stays intact for history.

To hire the same role again, create a new agent with a different name. Retired names are never reused so history stays clear.

## HR board {#hr-board}

The HR board (on the Agents page) shows at a glance:

- **Agent cards**: name, status (idle, working), current card, hiring manager, cost this month and in total, and quick actions.
- **Performance stats**: cards done, bounce rate (cards sent back for rework), bugs that escaped, utilisation, and tokens per card compared to similar agents.
- **Recommendations**: rule-based suggestions for model changes, role splits, hiring, or standing orders you can apply with one click.
- **Metrics dashboard**: team throughput, time blocked, queue depth, and average time to finish.

You can apply a recommendation directly or adjust it before posting as a standing order to the desk.
