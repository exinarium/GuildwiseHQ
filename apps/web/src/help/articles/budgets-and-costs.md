---
title: Budgets and costs
summary: Where spend shows, monthly budgets, budget limit handling, override and currency.
keywords: [budget, cost, spend, monthly, override, currency, tokens]
order: 16
---

Every shift records what it uses: input tokens, output tokens, and which model ran. Guildwise HQ turns this into money at US dollar list prices and shows it in your organization's currency. These are estimates of what the work costs, not an invoice. A hosting service's subscription, if you use one, is separate: see [Billing](/help/billing-and-plans).

## Where spend shows {#where-spend-shows}

You can see costs in several places:

- **Project settings**: the month's spend in the header and a **Monthly budget** panel with a progress bar.
- **Board header**: (e.g., "$9.00 of $10.00 this month") and a banner when near or over budget; each waiting card also says so in a [warning banner](/help/board-and-cards#reading-the-board).
- **HR board**: each agent's cost this month and in total.
- **A phase or a card**: what its shifts and BA work cost.
- **Interests**: the spend and budget of the interest.
- **The CEO's daily report**: a Spend section listing projects, cost and budget.
- **Costs page** (Owner and Admin): breakdown by project, agent, model and day for any date range, with daily bars and an **Export CSV** button.

## Monthly budgets {#monthly-budgets}

The **Costs** page shows each project's budget and how much of it is used; it does not set budgets. An Owner or Admin sets a project's budget in the project's settings under **Budget** (the **Monthly budget** panel: type an amount and click **Save budget**, or **Remove budget**), or an interest's budget on its **Settings** tab.

The month runs from the 1st to the end of the month in your organization's time zone (the Owner's time zone set under **Settings**). The budget resets at local midnight on the 1st.

- **At 80%**: you get a desk notice (Budget warning) and the CEO's daily report mentions it. Work carries on.
- **At 100%**: the project is **paused**. Running shifts finish; nothing new starts. Cards and BA tasks wait. A banner on the board and the project explains it, and a Budget paused item lands on your desk.

## Override {#override}

When a project hits 100% of its budget, a desk item offers:

- **Raise budget**: opens the Monthly budget panel; when the new amount is above the spend, the pause lifts and the item closes.
- **Override for this month**: dispatching resumes although the budget is used up, until the month ends (the **Monthly budget** panel has the same **Override for this month** button).

Setting a budget below what is already spent pauses the project at once.

Members who are not Owner or Admin see the progress but cannot change the budget. Guests of a shared project see only that it is paused, not the amounts.

## Currency {#currency}

To change how costs appear:

1. Go to **Costs** (sidebar: Organization; Owner and Admin).
2. Open the **Currency and prices** panel (the prices used for the estimates are listed under it).
3. Enter the **Currency** code (e.g., `EUR`) and the rate ("units per 1 USD"; e.g., `0.92` for euros), then save.

Budgets and every amount you see use the currency you set. Changing the rate changes how all history is shown, not what was recorded.
