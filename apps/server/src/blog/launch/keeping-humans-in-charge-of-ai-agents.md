---
title: "Keeping humans in charge of AI agents: a practical guide for small teams"
slug: keeping-humans-in-charge-of-ai-agents
summary: "Least access, approvals, one place for decisions, budgets and an audit trail are the five habits that keep AI agents under control. A practical governance guide for teams without a compliance department."
tags: [ai-agents, llm-ops]
cover:
  defaultKey: llm-ops
  alt: Abstract grid of connected nodes on a dark blue gradient
seo:
  metaTitle: "Keeping humans in charge of AI agents"
  metaDescription: "Approvals, your desk, budgets and audit trails: practical governance for small teams running AI agents."
social:
  facebookText: "New on the blog: how a small team keeps people in charge of AI agents with approvals, one place for decisions, budgets and an audit trail."
  linkedinText: "You do not need a compliance department to govern AI agents. Five habits go a long way: least privilege, approvals for high-impact actions, one place for decisions, budgets, and a record of what happened. A practical guide for small teams."
  xText: "You do not need a compliance department to govern AI agents. Practical ways to keep people in charge."
  blueskyText: "You do not need a compliance department to govern AI agents. Practical ways to keep people in charge of what they do."
sources:
  - title: "OWASP GenAI Security Project: LLM06:2025 Excessive Agency"
    url: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
  - title: "NIST: AI Risk Management Framework"
    url: https://www.nist.gov/itl/ai-risk-management-framework
  - title: "Anthropic: Building effective agents"
    url: https://www.anthropic.com/engineering/building-effective-agents
  - title: "Claude Code documentation: Best practices (permissions and sandboxing)"
    url: https://code.claude.com/docs/en/best-practices
  - title: "POPIA section 71: Automated decision making"
    url: https://popia.co.za/section-71-automated-decision-making/
---

## Autonomy is a dial, not a switch

The appeal of AI agents is that they act: they read files, run commands, send messages and change systems. The risk is the same thing seen from the other side. An agent that can act can also act wrongly, because of a misread instruction, a hallucinated detail, or text planted in a web page it was asked to read.

Governance is how you decide, in advance, how much an agent may do on its own. For a small team the good news is that this does not need a committee. It needs a few habits applied consistently: limit what agents can reach, require approval for what matters, keep decisions in one place, cap what they can spend, and keep a record of what they did.

## Habit 1: Give agents the least access that works

The OWASP project lists "Excessive Agency" among the main risks for applications built on language models. It describes three root causes: excessive functionality (tools the agent does not need), excessive permissions (access broader than the job requires) and excessive autonomy (high-impact actions with no verification). Its mitigations are what you would expect from any security discipline: minimise the tools, avoid open-ended ones such as unrestricted shell access where a narrower tool will do, and grant the minimum permissions.

In practice, ask three questions for each agent role:

- Which projects and repositories does it need? Only those.
- Which secrets does it need? Ideally none that it can read; keep credentials on the machine and out of prompts.
- Which actions are reversible? Let agents do those freely, and treat the rest differently.

Tooling helps. The Claude Code documentation describes permission allowlists for tools you trust and OS-level sandboxing that restricts file and network access, so an agent can work freely inside defined boundaries.

## Habit 2: Approvals for high-impact actions

The OWASP guidance names one control as critical: use human-in-the-loop approval so that a person approves high-impact actions before they are taken. Anthropic's guide to building agents says something similar from the design side: agents can pause for human feedback at checkpoints or when they hit blockers, and should be tested extensively in sandboxed environments with appropriate guardrails.

The art is choosing what needs approval. Too many approvals and people click through without reading, which is worse than none. Too few and the agent is making decisions you never saw. A workable split for a small team:

- **No approval needed:** reading, drafting, working in an isolated copy of the code, running tests.
- **Approval needed:** anything that leaves your control, such as sending an email, posting to an issue tracker, deploying, deleting data, spending money, or changing who has access.
- **Always a person:** decisions with legal or financial consequences for a customer or employee.

That last line has a legal angle in some places. South Africa's Protection of Personal Information Act (POPIA), in section 71, restricts decisions that have legal consequences for, or substantially affect, a person when they are based solely on automated processing, with exceptions such as decisions taken in connection with a contract. If agents touch decisions about real people, take proper advice on what applies to you.

## Habit 3: One place for decisions

Approvals fail in practice when they arrive as scattered chat messages and emails. The agent waits, the person misses the message, and work stalls or someone approves from a phone without the context.

Your desk is the fix: every question, approval and alert lands in one queue, with the context, the options and a recommendation, so an answer takes a minute rather than an investigation. Two further details matter.

First, the answer should be recorded once and available to every agent that asks later. Being asked the same question five times is how people start approving without reading.

Second, the desk should show what is blocked and why. A queue that only you can see is a bottleneck; a queue that tells you which cards are waiting on you turns it into a daily five-minute routine.

## Habit 4: Budgets

Agents consume paid model usage, and an agent in a loop can consume a lot of it. A budget is both a cost control and a safety control, because a runaway agent is usually a spending agent.

Set a monthly budget per project. Alert at a threshold, such as 80 percent, so you have time to react, and pause new work at 100 percent. Let work that is already running finish rather than killing it halfway. Review the numbers after the first few weeks and adjust, since early budgets are guesses.

## Habit 5: A record you can trust

When something goes wrong, the first question is "what happened, in what order, and who approved it?". An audit trail answers it, provided it is trustworthy. The strongest design is an append-only log: events are added and never edited, so the history cannot be quietly rewritten, and the current state is derived from it.

Keep the log useful by recording the human side as well as the machine side: who approved, when, and on what information. Decide how long you keep it, and remember that logs can contain personal information, so they fall under your privacy obligations too.

## Framing it with a standard

If you want a vocabulary for this, the US National Institute of Standards and Technology publishes the AI Risk Management Framework (version 1.0, January 2023), organised around four functions: govern, map, measure and manage. You do not need to adopt it formally. It is a handy checklist: who is accountable (govern), where do the agents operate and what could go wrong (map), how will you tell whether they behave (measure), and what do you do when they do not (manage). NIST notes the framework is voluntary and is being revised, so check the current version.

## A one-page starting policy

Write this down and put it where the team can see it:

1. Each agent has a named role, a list of projects it may work on, and no access beyond them.
2. Agents work in isolated copies and never change production directly.
3. Outbound actions, deployments, deletions and spending changes need a named person's approval.
4. Every project has a monthly budget with an 80 percent alert.
5. Decisions are answered in one place and recorded.
6. Once a month, someone reads the audit trail for surprises and adjusts the rules.

## How Guildwise HQ fits

Guildwise HQ is built around these habits. Agents are hired per project, each works on its own copy of your code, and a change reaches your main code only after review and testing. Posts to Jira, GitHub or email wait in an outbox for your approval. Questions and approvals reach one desk with context and a recommendation, and each answer is recorded once. Projects have monthly budgets with an alert at 80 percent and a pause at 100 percent, and the whole history is an append-only record of events.

## Key takeaways

- Treat autonomy as a dial: widen it only as trust is earned.
- Give each agent the least access that lets it do its job.
- Require a person to approve high-impact and outbound actions, and keep the list short enough to be read.
- Put every question in one place, with context, and record the answer once.
- Set budgets with an early alert, and keep an append-only record you review regularly.

*This article was written with AI assistance and reviewed and approved by the Guildwise HQ team. It is general information, not legal advice.*
