---
title: Your CEO
summary: The built-in agent you talk to first: it runs your desk and the floor, works on your own workstation when you ask, and learns from your corrections.
keywords: [CEO, chief executive, front door, full power, model, correction, authority, policy, undo, memory, standing order, permission]
order: 26
---

The **CEO** is built into every organization: you do not hire or appoint it, and it is free of plan limits. It is your front door: you tell it what you want, it answers agent questions, keeps cards moving, delegates to the team and to DevOps, and writes your daily report. It runs on your own workstation (the first one you pair; change it on **Organization, CEO**). You can **pause** it any time as an emergency stop. There is no training period: it decides what your policy allows from day one, and every decision can be reviewed and corrected.

## Full power in your own chat {#full-power}

When **you** talk to the CEO it is a real Claude Code session on your workstation: your own settings, skills and tools, your home directory and no Guildwise sandbox. This is enabled only after you run `aom-runner ceo full-power on` on that machine (the Overview says "Full power is off on <workstation>" until then). Events, other agents and your team can never start such a turn; the CEO's background work stays restricted. Where the runtime needs a permission it does not have, you or an Admin get a desk question, **Authorize this execution**: authorize once, for this turn, or deny; no answer in 10 minutes is a deny. A phone notification only points to that desk item.

## Pick the model per message {#model}

The chip in the chat composer shows the model ("Default (Sonnet)"). Choose another for **this message** or for **this conversation**. Switching the model inside the same runtime keeps the session; another runtime starts a new session with a short handover. If your workstation is offline, your message is **queued** and sent when it is back (a message older than 3 days asks first).

## Orders it carries out with full power {#orders}

On the **Ledger** you can give the CEO full power on one of your own standing orders. The order is pinned to its exact wording: any edit voids it unless you keep full power while editing. When an event clearly falls under the order, the CEO starts a separate full-power turn that carries out that order and nothing else. Every such turn is listed in the daily report with the commands it ran and an "I'd rather you didn't" button. An Admin's order only qualifies after the Admin escalates it to you and you mark it as yours.

## What it may decide {#authority}

The **Authority** tab sets, for each kind of action, whether the CEO decides, recommends or never does it. Matters like production deploys, manual QA and budgets stay yours unless you delegate one (you confirm each). Billing, members, security and secrets are never delegated. Below a minimum confidence it recommends instead.

## Decisions you review {#decisions}

Every decision the CEO takes on its own that you would otherwise have been asked about (answers to questions routed to it, matters you delegated, such as which **working branch** a repository uses) is listed on the desk under **CEO decisions**. **Acknowledge** it, or **Correct** it by writing the right decision: the CEO stores your correction as a memory and discusses it with the BA: the BA analyses what went wrong and what it caused and proposes fix cards, the CEO replies and records the lesson in its own words, and the BA creates the fix cards in the right projects. The Desk item shows the whole discussion. Your correction always stands, even if the CEO disagrees. **Acknowledge all** marks them all read. The working-branch delegation is on by default and can be switched off on the **Authority** tab.

## Activity log, Undo and Correct {#activity}

Everything it decided, recommended or refused is in the **Activity log**, with its reason, its confidence and the evidence. Most decisions have an **Undo**, also on the desk item and in the daily report. The Owner can export the log.

**Correct** is for "you did X, I'd rather Y": from the chat, the Activity log, the desk or the daily report. Your correction is remembered at once, ranks first in every brief, and (where the action can be reversed) offers to **undo** it or **redo** it as you wanted.

## Memory {#memory}

It remembers rules you give it. Tick **Remember this for the CEO** when you answer, or add a rule on the **Memory** tab. Proposed rules wait for your **Keep** or **Drop**. Only the Owner can read the memory.

## Talking to it {#talking}

Press **Ask** in the top bar for your standing chat, or give it a task on the **Tasks** tab. Its spend shows as **Management** on the Costs page. The DevOps engineer no longer has a chat of its own: ask the CEO, who delegates to DevOps and tells you what happened. If you do the same kind of job with the CEO again and again, the daily report suggests turning it into a feature, a skill or an automation (**Things you keep asking me**).
