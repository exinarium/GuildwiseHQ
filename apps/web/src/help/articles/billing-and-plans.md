---
title: Billing
summary: Cards, invoices and failed payments exist only where a hosting service provides billing. Self-hosted servers have none.
keywords: [billing, invoice, card, subscription, paused, payment fails, free trial, hosted service]
order: 24
---

Guildwise HQ is free and open source. Whether there is anything to pay depends on how you run it.

## Self-hosting has no billing {#plans}

If you run Guildwise HQ yourself, there are no plans, prices or billing: every feature is available, with no limit on organizations, members, agents, workstations or projects. A **Billing** tab and a **Plan & limits** tab appear only when the server you use is operated by a hosting service that offers them. In that case the service's own Help (its **Pricing** tab, and the pricing page on its website) lists its plans and prices. A hosting service may also give a particular organization a plan with no billing and no limits.

The AI work is never part of a plan. It is billed to you by your AI provider (see [Budgets and costs](/help/budgets-and-costs) for the estimates), and a VPS or Codespace by its provider (see [Cloud workstations](/help/cloud-workstations#cost)).

## Free trial {#trial}

A hosting service may offer a free trial before its first charge. Its sign-up page and its Pricing help say whether it does and how long it lasts. Self-hosted servers have no trial: there is nothing to start.

## Billing and invoices {#cards}

Where a hosting service bills you, billing is handled by the **Owner** of the organization on the **Billing** tab under **Organization**: the card, the invoices and cancelling. Admins and Members do not see it. Your hosting service explains how it charges and what each invoice shows.

## When a payment fails {#failed-payments}

On a hosted organization, repeated payment failures can pause the organization. A paused organization keeps its data; agents stop picking up work and only the Owner can sign in to fix the payment. Self-hosted servers are never paused for billing.

## For platform administrators {#platform}

On a self-hosted server there is no Billing page under **Platform**. A hosting service adds one, with its own help, for its plan catalogue, tax settings and the **Pause**, **Unpause** and **Assign Unlimited** actions on an organization. These actions need a reason and are written to the audit log.
