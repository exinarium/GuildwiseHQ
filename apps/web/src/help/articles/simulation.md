---
title: Simulation organizations
summary: A safe sandbox for tests and demos: agents run on a simulated workstation, nothing real is built or billed, and the whole organization can be deleted.
keywords: [simulation, demo, test, mock, sandbox, wipe, delete, simulated workstation, banner]
order: 25
---

A **simulation organization** looks and works like a normal one, but nothing real happens in it. It is for testing (for example a family member trying the product) and for demos. Only a platform administrator can create one, and once an organization is a simulation it stays one until it is deleted.

## What is different {#different}

- **A Simulation banner** is shown to everyone in the organization on every page, and the organization has a Simulation badge in the platform list.
- **Agents run on a simulated workstation.** Guildwise hosts it for you. It uses scripted "mock" agents, so no model is called, no tokens are used and nothing costs money. Cards still go through build, review, test and finish, and desk questions still appear.
- **Repositories are throwaway copies.** Whatever address you type when you add a repository, Guildwise creates a small local repository on its own server. When the BA or a DevOps engineer asks for a new repository, you still approve it on the desk, and approving creates a simulated repository the same way. Nothing ever contacts GitHub or any other website.
- **Chats are scripted.** Agents answer with prepared, realistic replies to typical questions such as status, scope, acceptance criteria, estimates, risks, test results and deployments.
- **It is never billed.** The Billing tab says so. There is no plan to buy and no card to add.
- **Emails are sent as normal**, with **[Simulation]** at the start of the subject whenever the email is about the simulation organization (an invitation, a support request, a notice), even if the person also belongs to a real organization. Emails that are not about an organization, such as a password reset, are not marked.
- **Your own workstations do nothing here.** A real workstation paired to a simulation organization receives no work. Hire your agents onto the **Simulated workstation**.

## Making an organization a simulation {#switch}

A platform administrator can invite a new organization as a simulation, or switch an existing one over, but only while it is **empty**: no projects (archived ones count) and no active billing subscription. Otherwise Guildwise explains why and nothing changes. A simulation organization **cannot be switched back**; it stays a simulation until it is deleted, so test data never turns into a real organization. Only the pace can still change.

## Pace {#pace}

The platform administrator sets how fast the simulated workstation works: **Fast** (good for tests), **Normal** or **Slow** (good for demos, so people can watch a card move).

## Starting a demo {#demo}

On a simulation organization, the platform administrator can choose **Load demo scenario**. It adds two projects with repositories, a hired team for each, cards in several stages, a few desk questions and a schedule, so a demo starts from a busy board. It only adds to an empty organization.

## Deleting a simulation organization {#delete}

The platform administrator can choose **Delete simulation organization** on the organization's page and type its name to confirm. This removes the organization and **everything** in it for good, including its history. Accounts that belong only to this organization are deleted too, so their email addresses can sign up or be invited again. Accounts that also belong to another organization only lose their place in this one. A short record of the deletion (names, email addresses and counts) stays in the platform audit log.

The server does not back up the database for you. Before deleting on a live system, take a backup.
