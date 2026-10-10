---
title: Plans and billing
summary: Plans and limits, the 7-day free trial, cards and invoices, changing plan, Business add-ons, cancelling and what happens when a payment fails.
keywords: [billing, plan, pricing, price, starter, team, business, sign up, free trial, card, invoice, payfast, rand, vat, upgrade, cancel, subscription, paused, add-ons, unlimited]
order: 24
---

Billing is for the **Owner** of an organization. Open **Organization** (bottom of the sidebar) > **Billing**. Admins and Members do not see it.

## Plans {#plans}

Every plan has every feature and **no limit on agents**. Plans differ only in how many members, workstations and projects you can have.

| Plan | Per month | Members | Workstations | Projects |
|---|---|---|---|---|
| Starter | $19 | 2 | 1 | 3 |
| Team | $49 | 5 | 3 | 10 |
| Business | $149 | 20 | 10 | Unlimited |

Prices are in US dollars and do not include VAT. The platform administrator can change them; a subscription keeps the price it started at until you change plan. Organizations set up by invitation stay free until the Owner chooses a plan on the **Billing** page. An **Unlimited** plan, with no billing and no limits, is only given out by the platform administrator.

The plan pays for Guildwise HQ itself. The AI work is billed to you by Claude (your subscription or API key; see [Budgets and costs](/help/budgets-and-costs) for the estimates), and a VPS or Codespace by its provider (see [Cloud workstations](/help/cloud-workstations#cost)).

## Signing up and the free trial {#trial}

1. Click **Start free trial** on the website (or a plan's button under **Pricing**), choose a plan and enter your organization name, your name, email and a password.
2. Open the link in the email we send you. Signing in needs the confirmed email.
3. Add a card on the **Billing** page. Your **7-day free trial** starts and nothing is charged.
4. When the trial ends, the first invoice is charged to your card, and then once a month.

Until a card is saved your organization is paused: only you can sign in and the page asks you to add a card. We send a reminder two days before the trial ends. You can cancel during the trial and pay nothing.

## Cards and invoices {#cards}

We never see or keep your card number. With PayFast you enter your card on PayFast's secure page; a small amount is charged to check the card and refunded straight away. Only a secure token is kept. PayFast does not share the card number with us, so the **Billing** page shows the card simply as *Card*.

Your card is charged in **South African rand**. The dollar price is converted at that day's exchange rate, and every invoice shows both the dollar amount and the rand amount charged, with the rate. The **Billing** page lists all invoices.

## Changing plan {#changing-plan}

Pick another plan under **Change plan**. The change takes effect at once. If the new plan costs more you pay the difference for the rest of the month now; if it costs less the difference is kept as a credit on your next invoice. During the trial a change costs nothing. You cannot move to a plan that is too small for what you already use: remove some members, projects or workstations first.

## Business add-ons {#add-ons}

On **Business** you can add **members**, **workstations** and **projects** on top of the plan, each at a small monthly price shown on the page. Changes apply from your **next billing cycle**, and you can never go below the Business base. To go lower, change plan.

## Cancelling {#cancelling}

**Cancel subscription** keeps your organization active until the end of what you have paid for (or the end of the trial), then pauses it. Nothing more is charged. Changed your mind before then? Use **Keep my subscription**.

## When a payment fails {#failed-payments}

If a charge fails we try again after one day and again after three days (three attempts in all) and email you each time. Update your card on the **Billing** page to fix it. If the third attempt fails, the organization is **paused**.

A paused organization keeps all its data. Agents stop picking up work and only the Owner can sign in, to a banner and the **Billing** page. Add a card if needed and press **Resubscribe now**: you are charged for a new month and everything continues where it stopped.

## For platform administrators {#platform}

Under **Platform** > **Billing** you edit the plan prices and limits, the add-on prices, the VAT percentage (0 until the company is VAT registered) and an exchange-rate override. On an organization's page the **Billing** panel shows its subscription, card and invoices, and lets you **Pause**, **Unpause** or **Assign Unlimited**. Each of these needs a reason and is written to the audit log.
