---
title: Organizations and roles
summary: Four roles, what each can do, members, invitations, guests, temporary passwords, suspension and the platform area.
keywords: [organization, owner, admin, member, guest, roles, invitations, temporary password, reset password, suspended, paused, platform, super admin, support emails, landing assistant, ask guildwise]
order: 2
---

An organization is your workspace: it owns your projects, agents, the board, the desk, the ledger and the vaults. Everyone in Guildwise HQ works inside an organization in one of four roles.

## Roles {#roles}

Each role has different permissions. Here is what each can do:

- **Owner**: Everything an Admin can do, plus invite Admins, change roles, require two-factor login, reset an Admin's password or a member's two-factor login, manage [billing](/help/billing-and-plans), and hand ownership to an Admin. There is exactly one Owner per organization.
- **Admin**: Create projects, invite Members and remove them, manage vaults, design roles and workflows, hire and fire any agent, set budgets, and see the plan and limits. Admins can also give a Member a temporary password (see below). Admins cannot invite Admins, change roles, reset another Admin's password or change the organization's security settings.
- **Member**: Work in the projects they were added to: create cards, hire agents onto their own workstations for those projects, and answer the desk items they are allowed to (by default only on cards they own).
- **Guest**: Not a member. Has access to one or more projects that were shared with them. Guests see nothing at organization level.

Only the Owner and Admins create projects and add people to the organization. Members and guests cannot do either.

## Switching organizations {#switching-organizations}

You can belong to several organizations. Each browser tab can work in a different organization.

At the top of the sidebar, you see the name of the organization the current tab is working in. Click it to see your other organizations and switch. If you are a guest on a project from another organization, that project's name carries a "Guest" label showing which organization it belongs to.

## Members and invitations {#members-and-invitations}

To manage people in your organization, open **Organization** at the bottom of the sidebar, then the **Members** tab (Members see the list but cannot change it; the **Invitations**, **Guests** and **Plan & limits** tabs are for Owner and Admins, and the **Billing** tab is for the Owner).

**Members** lists everyone with their role. The Owner can change roles and remove people. Admins can remove Members. When someone is removed, their agents go back to the Owner and need a new home (**Re-home** on the agent's card), and any cards they held are released back to the queue. Anyone except the Owner can leave the organization on their own (**Leave organization** on the **General** tab); the Owner must hand over ownership first (**Transfer ownership**).

The **Invitations** tab shows pending and past invitations. You can **Resend** or **Revoke** one. To invite someone:

1. On the **Members** tab, click **Invite member**.
2. Enter their **Email** and choose their **Role** (Member or, as Owner, Admin).
3. Pick which **Projects** they start on (Members only; you can change this later with **Change projects** on their row).
4. Click **Send invitation**. They receive an email with a link; people without an account create one.

Everyone can reset their own password with **Forgot your password?** on the sign-in page (see [Getting started](/help/getting-started#forgot-password)). If a member cannot get the reset email, the Owner or an Admin can open the actions menu on their row and choose **Reset password**. You get a temporary password to copy and pass on yourself (it is shown once and no email is sent). The member is signed out everywhere and chooses their own password at the next sign-in. An Admin can do this for Members only; the Owner can do it for Members and Admins. Nobody resets their own password this way (use Account, Security). Their account is one account for every organization, so the new password applies in their other organizations too.

The Owner can change an Admin or Member's role from the role selector on their row. Your plan may limit how many members you can have; the **Plan & limits** tab shows it (see [Plans and billing](/help/billing-and-plans#plans)).

## Guests {#guests}

Guests are people from other organizations who have access to one or more of your projects. You invite a guest by sharing a project with them. To do this:

1. Open the settings of the project you want to share and go to **Team**.
2. Enter their email address under **Invite by email** and click **Send invitation**.
3. They must already have an account.
4. They accept in the **Project invitations** list at the top of their **Projects** page.

A guest hired on a shared project can see and work on that project only, regardless of their allowed projects in their home organization. If you remove them from the project, any cards they held on it are released.

The **Guests** tab under **Organization** shows who from other organizations has access to your projects.

## Suspension {#suspension}

A platform administrator can suspend your organization. Running shifts finish and nothing new starts. Scheduled actions are skipped and recorded. A banner at the top explains the suspension.

Only the Owner can still sign in, with read access plus organization settings and member management. To resume, the administrator reactivates the organization and everything continues where it stopped. An organization that is paused because of billing shows a banner with a link to the Billing page: see [Plans and billing](/help/billing-and-plans#failed-payments).

## Platform area {#platform-area}

Platform administrators sign in at the same address but see only the **Platform** area instead of organizations. The Platform area has 11 entries: **Organizations**, **Invitations**, **Accounts**, **Billing**, **Support**, **Blog**, **API keys** (keys for outside tools that use `/api/v1`), **Runners** (pause the automatic runner updates), **Platform team** (which organization and project receive the platform's own bugs and reports), **Inbound mail** (whether inbound e-mail works and what arrived in the last 24 hours) and **Audit log**. Administrators can view and manage all organizations, accounts, invitations, billing, the blog and support requests. They never see a specific organization's cards, desk or vaults. [Contact us](/help/contact) if you need a platform administrator.

### Support emails {#console-emails}

Everything that reaches the platform area by **Contact us** is also emailed to the support address set on **Platform, Support**: new requests, Contact us messages from visitors, and a person's reply on a request. Two more emails are switches on the same page, off until you turn them on: **new organizations and sign-ups**, and **platform audit events**. The person who wrote in gets an automatic reply with their reference and when to expect an answer (within 24 to 48 hours). See [Writing to us](/help/writing-to-us).

### The landing-page assistant {#landing-assistant}

The public landing page can show a small **Ask Guildwise** chat that answers questions about the product. It is paid by Guildwise (the server needs an Anthropic API key), answers in English only, cannot see any account or data, and keeps no conversations, only counts. It answers only from a reviewed list of product facts (the plans and prices included) and an outline of these help articles, never promises discounts, dates or anything not written there, and sends people to Contact us for sales, support, legal and account questions. On **Platform, Support** a platform administrator sees a panel with a **Turn off** / **Turn on** button, today's message count and the spend against the daily budget (two dollars a day by default; change it with **Daily budget** in the same panel). When the budget is used up the chat says so and the landing page offers Contact us until the next day (UTC).
