---
title: Journeys
summary: One whole process from trigger to outcome: steps made of your workflows, handoffs, waits, approval gates, webhooks and the shared record.
keywords: [journey, step, handoff, record, instance, wait, gate, approval, webhook, timeout, template, rentals, stuck]
order: 35
---

A **journey** is one complete process, such as a rental from first enquiry to move-in. It is made of workflows you already have (the **steps**), linked by **handoffs**, and every step works on one shared **record** (a client, a matter or a deal). The record holds only status, the current step, times and references, never answers or document content.

## Design a journey {#design}

Sidebar, **Journeys**, **New journey** (Owners and Admins). Start from nothing or from the rentals template. Add steps, order them with **Move up** and **Move down**, and for each step set its handoffs: when it is done, cancelled or either, go to another step or to the end, optionally only when a field matches. A handoff may go back to an earlier step. Every **Save** is a new version; running instances finish on the version they began on.

## Waits and gates {#waits-gates}

A **wait** pauses the journey for a length of time, a date on the record, a form from the client or a webhook event. Every wait has a deadline and one timeout action: remind and keep waiting, go to a named step, ask on the desk (**Extend**, **Continue now**, **Go to step**, **Cancel the journey**) or cancel. A **gate** asks a person, a role, the project owner or the organization Owner: **Approve**, or **Reject** with a note. Only the approver decides.

## Webhooks {#webhooks}

The **Webhooks** panel creates addresses that start a journey or end a wait. The signing secret is shown once. Requests are checked on their signature before anything is read. A **webhook call** step calls a URL from your own workstation, which keeps the credentials.

## Run and follow an instance {#instances}

Start an instance on a record, or by a signed webhook. The Journeys page lists instances with filters for journey, step and status. The instance page shows the current step, the history, the references and each wait or call with its deadline. A journey that cannot go on says **This journey is stuck** and puts a notice on the desk.
