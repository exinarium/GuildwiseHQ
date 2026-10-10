---
title: Plans and billing
summary: Plans and limits, the 7-day free trial, cards and invoices, changing plan, Business add-ons, cancelling and what happens when a payment fails.
keywords: [billing, plan, pricing, price, starter, team, business, sign up, free trial, card, invoice, paystack, rand, vat, tax invoice, billing profile, company name, upgrade, cancel, subscription, paused, add-ons, unlimited]
order: 24
---

Billing is for the **Owner** of an organization. Open **Organization** (bottom of the sidebar) > **Billing**. Admins and Members do not see it.

## Plans {#plans}

Every plan has every feature and **no limit on agents**. Plans differ only in how many members, workstations and projects you can have.

| Plan | Per month (VAT included) | Members | Workstations | Projects |
|---|---|---|---|---|
| Starter | $19.00 | 2 | 1 | 3 |
| Team | $49.00 | 5 | 3 | 10 |
| Business | $149.00 | 20 | 10 | Unlimited |

Prices are in US dollars and **include VAT** (15%), which is shown on every invoice. The platform administrator can change them; a subscription keeps the price it started at until you change plan. Organizations set up by invitation stay free until the Owner chooses a plan on the **Billing** page. An **Unlimited** plan, with no billing and no limits, is only given out by the platform administrator.

The plan pays for Guildwise HQ itself. The AI work is billed to you by Claude (your subscription or API key; see [Budgets and costs](/help/budgets-and-costs) for the estimates), and a VPS or Codespace by its provider (see [Cloud workstations](/help/cloud-workstations#cost)).

## Signing up and the free trial {#trial}

1. Click **Start free trial** on the website (or a plan's button under **Pricing**), choose a plan and enter your company name (Guildwise HQ is sold to businesses), your name, email and a password.
2. Open the link in the email we send you. Signing in needs the confirmed email.
3. Add a card on the **Billing** page. Your **7-day free trial** starts and nothing is charged.
4. When the trial ends, the first invoice is charged to your card, and then once a month.

Until a card is saved your organization is paused: only you can sign in and the page asks you to add a card. We send a reminder two days before the trial ends. You can cancel during the trial and pay nothing.

## Cards and invoices {#cards}

We never see or keep your card number. You enter your card on Paystack's secure page; a small amount is charged to check the card and refunded straight away. Only a secure token is kept, with the card brand, the last four digits and the expiry date, which the **Billing** page shows (we also email you before the card expires). To use another card, press **Update card**: the new card replaces the old one.

Your card is charged in **South African rand**. The price is a fixed dollar amount that **includes 15% VAT**. Each charge converts it at that day's exchange rate, and every invoice shows the dollar price, the VAT it contains in dollars and in rand, and a line such as *charged as R906.50 at R18.50 / USD on 2026-10-10*. The **Billing** page lists all invoices.

## Billing profile and tax invoices {#invoices}

Guildwise HQ is sold to businesses, so sign-up asks for your **company name**. Under **Billing** > **Billing profile** the Owner can edit the company name, address, country and VAT number (optional). They are printed on your invoices; an invoice that is already paid keeps the details it was issued with.

Next to each invoice, **View / print tax invoice** opens a printable page with the invoice number, date, our details and VAT number, yours, the line items, and the VAT amount in rand. Use your browser's Print command and choose *Save as PDF* to keep a copy.

## Changing plan {#changing-plan}

Pick another plan under **Change plan**. The change takes effect at once. If the new plan costs more you pay the difference for the rest of the month now; if it costs less the difference is kept as a credit on your next invoice. During the trial a change costs nothing. You cannot move to a plan that is too small for what you already use: remove some members, projects or workstations first.

## Business add-ons {#add-ons}

On **Business** you can add **members**, **workstations** and **projects** on top of the plan, each at a small monthly price shown on the page. Changes apply from your **next billing cycle**, and you can never go below the Business base. To go lower, change plan.

## Cancelling {#cancelling}

**Cancel subscription** keeps your organization active until the end of what you have paid for (or the end of the trial), then pauses it. Nothing more is charged. Changed your mind before then? Use **Keep my subscription**.

## When a payment fails {#failed-payments}

If a charge fails we try again after one day and again after three days (three attempts in all) and email you each time. Update your card on the **Billing** page to fix it. If the third attempt fails, the organization is **paused**.

A paused organization keeps all its data. Agents stop picking up work and only the Owner can sign in, to a banner and the **Billing** page. Add a card if needed and press **Resubscribe now**: you are charged for a new month and everything continues where it stopped.

## When payments are not available yet {#not-available}

While a server has no real payment provider set up, the **Billing** page says **Payments are not available yet** and hides choosing a plan, adding or updating a card and changing plan. Nothing is charged, and your organization keeps working. The public sign-up is closed too: the landing page and the sign-up page point to **Contact us** to get started.

## For platform administrators {#platform}

Under **Platform** > **Billing** you see which payment provider is active and whether it is in sandbox (test keys) or live mode, and you edit the plan prices and limits (US dollars, VAT included), the add-on prices, the VAT percentage (15 by default; it is taken out of the price, never added on top), the invoice details printed on every tax invoice (company name, address, VAT number) and an exchange-rate override. On an organization's page the **Billing** panel shows its subscription, card and invoices, and lets you **Pause**, **Unpause** or **Assign Unlimited**. Each of these needs a reason and is written to the audit log.

If no real payment provider is configured on a production address, a banner in the platform area and a note under **Platform** > **Billing** say so: self-service sign-up is hidden until `AOM_PAYMENT_PROVIDER=paystack` and `AOM_PAYSTACK_SECRET_KEY` are set.
