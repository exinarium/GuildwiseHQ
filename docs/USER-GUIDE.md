# Guildwise HQ: User Guide

*Many hands. One master.*

Guildwise HQ is a place where you run a team of AI agents the way you would run a small company. You write down what you want. The agents do the work. They stop and ask you whenever a decision is really yours to make.

This guide is for people who have never worked with AI agents before. You do not need to be a programmer to read it. Where a technical word is unavoidable, it is explained the first time it appears and again in the glossary in chapter 2.

**How to use this guide**

- New here? Read chapters 1 to 3. They take about half an hour, and chapter 3 gets you from an invitation to your first working card in about 15 minutes.
- Then read the chapter for your role: chapter 4 for Owners and Admins, chapter 5 for Members, chapter 6 for Guests, chapter 7 for the platform administrator (the person who runs the Guildwise HQ service itself).
- Chapter 8 shows four everyday workflows from start to finish. Chapter 9 helps when something goes wrong. Chapters 10 and 11 cover Contact us and frequently asked questions.
- Inside the app, the **Help** page has short articles on every topic. This guide points to them like this: *In the app: Help, "Budgets and costs"*. The same articles open from the small **?** hints next to many headings.

<!-- toc -->
**Contents**

- [1. What Guildwise HQ is](#1-what-guildwise-hq-is)
  - [1.1 The idea in one minute](#11-the-idea-in-one-minute)
  - [1.2 What you do and what the agents do](#12-what-you-do-and-what-the-agents-do)
  - [1.3 Where the agents run](#13-where-the-agents-run)
- [2. Key ideas](#2-key-ideas)
  - [2.1 The words you will meet](#21-the-words-you-will-meet)
  - [2.2 How a card travels](#22-how-a-card-travels)
  - [2.3 Who is allowed to do what](#23-who-is-allowed-to-do-what)
- [3. Getting started in 15 minutes](#3-getting-started-in-15-minutes)
  - [3.1 Accept the invitation and sign in (2 minutes)](#31-accept-the-invitation-and-sign-in-2-minutes)
  - [3.2 Turn on two-factor login (3 minutes)](#32-turn-on-two-factor-login-3-minutes)
  - [3.3 Take the tour (1 minute)](#33-take-the-tour-1-minute)
  - [3.4 Add a workstation (5 minutes)](#34-add-a-workstation-5-minutes)
  - [3.5 Hire your first agents (2 minutes)](#35-hire-your-first-agents-2-minutes)
  - [3.6 Create your first project (1 minute)](#36-create-your-first-project-1-minute)
  - [3.7 Create your first card (2 minutes)](#37-create-your-first-card-2-minutes)
  - [3.8 Watch it happen](#38-watch-it-happen)
- [4. For Owners and Admins](#4-for-owners-and-admins)
  - [4.1 Your organization](#41-your-organization)
  - [4.2 Members, invitations and guests](#42-members-invitations-and-guests)
  - [4.3 Projects](#43-projects)
  - [4.4 Agents, hiring and allow-lists](#44-agents-hiring-and-allow-lists)
  - [4.5 The desk, the ledger and standing orders](#45-the-desk-the-ledger-and-standing-orders)
  - [4.6 Budgets and costs](#46-budgets-and-costs)
  - [4.7 The org chart, roles and workflows](#47-the-org-chart-roles-and-workflows)
  - [4.8 Schedules and integrations](#48-schedules-and-integrations)
  - [4.9 Interests](#49-interests)
  - [4.10 Phases and follow-ups](#410-phases-and-follow-ups)
  - [4.11 Your BA reports to you](#411-your-ba-reports-to-you)
  - [4.12 Testing, finalizing and risk](#412-testing-finalizing-and-risk)
  - [4.13 Conversion, the Research tab and research cards](#413-conversion-the-research-tab-and-research-cards)
  - [4.14 Archive and delete](#414-archive-and-delete)
  - [4.15 Security and two-factor login](#415-security-and-two-factor-login)
  - [4.16 Plan and limits](#416-plan-and-limits)
  - [4.17 Chatting with agents](#417-chatting-with-agents)
- [5. For Members](#5-for-members)
  - [5.1 What you can do](#51-what-you-can-do)
  - [5.2 Your first day](#52-your-first-day)
  - [5.3 Good habits](#53-good-habits)
- [6. For Guests](#6-for-guests)
  - [6.1 Accepting the invitation](#61-accepting-the-invitation)
  - [6.2 What you can do as a Guest](#62-what-you-can-do-as-a-guest)
  - [6.3 What you cannot do](#63-what-you-cannot-do)
- [7. For the platform administrator](#7-for-the-platform-administrator)
  - [7.1 First sign-in and two-factor login](#71-first-sign-in-and-two-factor-login)
  - [7.2 Organizations](#72-organizations)
  - [7.3 Invitations: starting a new organization](#73-invitations-starting-a-new-organization)
  - [7.4 Accounts](#74-accounts)
  - [7.5 The Support inbox](#75-the-support-inbox)
  - [7.6 The audit log](#76-the-audit-log)
- [8. Everyday workflows](#8-everyday-workflows)
  - [8.1 A feature, from intake to deploy](#81-a-feature-from-intake-to-deploy)
  - [8.2 From research to a project](#82-from-research-to-a-project)
  - [8.3 Setting up interests without being flooded](#83-setting-up-interests-without-being-flooded)
  - [8.4 Controlling spend](#84-controlling-spend)
- [9. Troubleshooting](#9-troubleshooting)
  - [9.1 The installer](#91-the-installer)
  - [9.2 The runner is offline](#92-the-runner-is-offline)
  - [9.3 A card is backing off](#93-a-card-is-backing-off)
  - [9.4 A budget pause](#94-a-budget-pause)
  - [9.5 A missing working branch](#95-a-missing-working-branch)
  - [9.6 Two-factor recovery](#96-two-factor-recovery)
  - [9.7 Other things you may see](#97-other-things-you-may-see)
- [10. Contact us](#10-contact-us)
- [11. Frequently asked questions](#11-frequently-asked-questions)
- [Appendix A. Where to find things](#appendix-a-where-to-find-things)
- [Appendix B. More documentation](#appendix-b-more-documentation)

<!-- /toc -->









## 1. What Guildwise HQ is

### 1.1 The idea in one minute

Imagine you hire a small team: someone who builds, someone who checks the work, someone who tests it, and an assistant who keeps notes and reports to you. Each of them can work on several things, but they cannot read your mind. When they are unsure, they ask. When something is risky, they wait for your go-ahead.

Guildwise HQ is that team, made of AI agents. It gives you:

- a **board** that shows every piece of work and where it stands, from left to right;
- a **desk**, which is your inbox of decisions: questions, approvals and go-aheads that only you can give;
- **agents** with names, faces and roles, who do the actual work on one of your own computers;
- a **memory** (the ledger) that remembers every decision, so nobody asks you the same thing twice;
- **reports and limits**: a daily summary from your business analyst, monthly spending budgets, and loop protection, so the team cannot run away with your money or your patience.

![The board of a project, with cards moving from left to right](guide/assets/board-hero.jpg)

### 1.2 What you do and what the agents do

| You | The agents |
| --- | --- |
| Say what you want, in plain words, as a card | Turn it into a proper specification, build it, review it, test it |
| Answer questions on the desk | Ask when they cannot decide, and carry on once you answer |
| Approve risky steps (merging big changes, posting to a ticket, spending beyond a budget) | Wait for your approval and never go around it |
| Choose the team, the budgets and the rules | Follow them, and report if something does not fit |

### 1.3 Where the agents run

The agents do their work on a computer of yours, called a **workstation**: your own PC, a Mac, or a Linux machine. Your code, your passwords and your files stay on that computer. The Guildwise HQ website only holds the board, the desk and the records. A small helper program called the **runner** (installed in the next chapters with a guided installer) connects the workstation to the website.

> **Good to know:** the AI itself is Claude. You sign in to Claude once on your workstation, either with your own Claude subscription or with an API key. The agents' work is billed by Claude to you (a subscription uses your plan, an API key is pay-as-you-go). Guildwise HQ estimates and limits that spend for you (see chapter 4.6).

## 2. Key ideas

Read this chapter once. Everything else builds on these words.

### 2.1 The words you will meet

| Word | What it means |
| --- | --- |
| **Organization** | Your company's space in Guildwise HQ. It holds the people, projects, agents, workstations and records. You can belong to more than one. |
| **Owner, Admin, Member, Guest** | The four roles a person can have. The Owner runs the organization, Admins help manage it, Members work in the projects they are added to, Guests are visitors from another organization who can work in one shared project. |
| **Project** | A body of work with its own board, for example "Web shop". A *code* project builds software. A *research* project looks things up and writes notes. |
| **Card** | One piece of work with its requirements and acceptance criteria ("what done looks like"). A card moves across the board until it is done. |
| **Board** | The columns of a project. Each column is a stage of the work. |
| **Agent** | One AI team member: a **role** (such as builder or reviewer), a **seniority** (junior or senior), a face, a name and a track record. |
| **Allow-list** | The projects an agent may work on. An agent only ever gets cards from projects on its list. |
| **Workstation** | A computer of yours where agents run. |
| **Runner** | The small program on a workstation that does the agents' work and talks to the website. |
| **Shift** | One stretch of work by one agent on one card. You will see the word in logs and reports. |
| **Desk** | Your inbox of decisions. |
| **Ledger** | The shared memory: decisions, standing orders and requirements, searchable. |
| **Standing order** | A rule every agent reads at the start of every shift, such as "write a unit test for every change". |
| **BA** | The business analyst agent. It drafts cards from your requests and tickets, answers what it can from the ledger, and writes your daily floor report. |
| **DevOps engineer** | A free agent that looks after one workstation: installs tools, keeps your repositories tidy, starts and stops things. |
| **Vault** | A folder of notes (a git repository) that is synced to your workstations: your organization's knowledge base, or one project's own notes. |
| **Priority order** | The order of your projects on the Projects page, most important first. Agents serve the project higher up first. |
| **Schedule** | A trigger plus one action, for example "every Monday at 07:00, create a card". |
| **Interest** | A topic you follow, such as "AI news". Agents look for new items on a schedule and deliver them to your desk. |
| **Phase** | A named slice of a project ("Phase 2: autosave") that you ship and check together, followed by steps such as deploy and regression run. |
| **Budget** | A monthly spending limit on a project (or an interest). |

The in-app glossary is at **Help, Glossary**.

### 2.2 How a card travels

A card in a code project goes through the same stages every time. You do not have to push it along. The agents do.

1. **Spec**: the card is written down: context, requirements, acceptance criteria. You (or the BA) write it. Until it is specified it is a draft.
2. **To do and Build**: a builder takes the card and works on a branch of your repository.
3. **Review**: a reviewer reads the change and either approves or sends it back (rework).
4. **Test**: a tester runs the tests in the test plan. A failure creates a bug card, and the original waits for the fix.
5. **Finalize**: the BA completes the card in the way you chose: open a pull request, push the branch, or merge.
6. **Done**.

If anyone gets stuck or needs a decision, the card turns to **Blocked** and a question appears on your desk.

![The same card in different columns, from To do to Done](guide/assets/board-left.jpg)

> **In the app:** Help, "Board and cards" (`/help/board-and-cards`) and "Testing and finalization" (`/help/testing-and-finalization`).

### 2.3 Who is allowed to do what

In short: **Owners and Admins manage**, **Members work** in the projects they were added to, **Guests work** in the one project that was shared with them, and the **platform administrator** only runs the service and never sees your work. Chapter 4 to 7 have the details for each role.

> **In the app:** Help, "Organizations and roles" (`/help/organizations-and-roles`).

## 3. Getting started in 15 minutes

By the end of this chapter you have: a working login with two-factor protection, a workstation connected, a small team hired, a project and your first card moving across the board.

> **Before you start:** you need an invitation email, a computer to use as a workstation (it can be the one you are on now), and a Claude account. A Claude subscription (Pro, Max, Team or Enterprise) is the easiest. An API key works too.

### 3.1 Accept the invitation and sign in (2 minutes)

1. Open the invitation email. It comes from either the **platform administrator** ("start your organization": you become its Owner) or from the **Owner or an Admin** of an existing organization ("join Acme": you become a Member or Admin). Invitations work for 7 days.
2. Click the link. Type your name and choose a password of at least 12 characters, then confirm it.
3. You land inside the app. If you already had an account, sign in instead and confirm.

![Accepting an invitation](guide/assets/invite-accept.jpg)

If the link says the invitation is no longer valid, it has expired, was used already, or was withdrawn. Ask the person who invited you to send a new one.

![An invitation link that no longer works](guide/assets/invite-invalid.jpg)

Visitors who are not signed in see the landing page, with a **Sign in** button.

![The landing page](guide/assets/landing.jpg)

To sign in later, go to the sign-in page, type your email and password, and press **Sign in**.

![The sign-in page](guide/assets/login.jpg)

A wrong email or password always gives the same message, so nobody can use the page to find out who has an account.

![A wrong password](guide/assets/login-error.jpg)

### 3.2 Turn on two-factor login (3 minutes)

Two-factor login means that after your password you also type a six-digit code from an app on your phone. Even if somebody learns your password, they cannot get in. It is strongly recommended for everybody, and your Owner may require it.

1. Open your avatar menu at the bottom of the sidebar and choose **Your settings**.
2. On that page, in the **Two-factor login** panel, choose **Turn on two-factor login**. Type your password, scan the QR code with an authenticator app (any one will do, for example Google Authenticator, Microsoft Authenticator or 1Password) and type the first six-digit code.
3. You are shown **ten recovery codes, once**. Save them in a password manager or print them. Each code works one time, if you lose your phone.

![Setting up two-factor login](guide/assets/security-2fa.jpg)

> **Watch out:** the recovery codes are the only way back in if you lose your phone, apart from asking your Owner to reset your two-factor login. Save them now.

> **In the app:** Help, "Two-factor login" (`/help/two-factor`).

### 3.3 Take the tour (1 minute)

The first time you sign in, a short guided tour highlights the main areas and tells you what each is for. The tour is different for each role. You can skip it and replay it any time from **Help**.

![The first step of the tour](guide/assets/tour-1.jpg)

Three things worth knowing from the start:

- **Search and jump anywhere:** press **Ctrl+K** (on a Mac **Cmd+K**) to open the command palette. Type a project, card, page or action ("contact", "new card") and press Enter.
- **The ? hints:** small question-mark buttons next to headings open the matching help article in a side panel, without leaving your page.
- **On a phone:** the whole app works on a phone. Open the menu with the button at the top left.

![The command palette](guide/assets/palette.jpg)

### 3.4 Add a workstation (5 minutes)

A workstation is the computer where your agents will work. The guided installer sets everything up for you.

1. Open **Workstations** in the sidebar and click **Add a workstation**.
2. **Pick the computer.** The page guesses from your browser (Windows, Linux or macOS). Change it if the machine that will run the agents is a different one. Windows runs the agents inside WSL2, Microsoft's built-in Linux, and the installer turns it on for you. You may also type a name for it ("Office PC").
3. **Copy the command** with the copy button, or choose **Download the script** if you would like to read it first. The command contains a link that is valid for 30 minutes and a one-time pairing code. It never contains a password.
4. **Run it on that computer.** Open a terminal (on Windows, PowerShell), paste the command and press Enter. Say yes when it asks for permission. Windows may ask to restart once. The installer carries on by itself when you sign in again.
5. **Watch the page.** It shows the installer starting, the computer pairing, and then health checks one by one (Node, git, Claude, the sandbox, Docker, yt-dlp, your repositories, the server), ending with **Ready**.

![The installer wizard, step 1: choose the computer](guide/assets/installer-choose.jpg)

![The installer wizard, step 3: the command to run](guide/assets/installer-command.jpg)

![The installer wizard while it works: pairing and health checks](guide/assets/installer-progress.jpg)

The installer asks only what it must: your password once to install system tools, whether you want the optional extras (yt-dlp for transcripts of videos and podcasts; Docker only if your tests run containers), the folder that holds your code (it suggests `~/src`), and how Claude should sign in. It explains the two ways in plain words. Choose **Claude subscription** if you have one: you sign in with your Claude account in a browser. Choose **API key** if you would rather pay for exactly what the agents use.

> **Good to know:** you can run the same command again at any time. It upgrades the runner, repairs a broken installation and keeps your existing pairing.

If something goes wrong, the installer says what happened and links to the install help and to **Contact us**. Chapter 9.1 covers the usual problems.

> **In the app:** Help, "Workstations and the installer" (`/help/workstations-and-installer`) and "Installing a workstation: if something goes wrong" (`/help/install-troubleshooting`).

### 3.5 Hire your first agents (2 minutes)

You need at least a builder, a reviewer and a tester to get a card from idea to done. The BA is also strongly recommended.

1. Open **Agents** and click **Hire agent**.
2. Choose a **Role**: *Builder* writes the change, *Reviewer* checks it, *Tester* runs the tests, *BA* writes cards and reports, *Writer* documents. Choose **Seniority**: seniors take larger and riskier work and may review large changes. Pick the **Workstation** where the agent runs.
3. Choose where the agent may work: **Any project**, or **Selected projects** (the allow-list). For now keep the project you will create next, or any project.
4. Choose the **Model** (a bigger model is smarter and costs more; a smaller one is fast and cheap). A good start is a stronger model for builders and BAs and a lighter one for reviewers and testers. Give the agent a **Name**. The name generator suggests unused names; pick a theme or type your own.
5. Click **Hire**. Repeat for each role.

![Hiring an agent](guide/assets/dlg-hire.jpg)

> **Tip:** two builders and one each of reviewer, tester and BA is a comfortable first team. Large changes need two different senior reviewers, so hire a second senior reviewer when you get to bigger work. Review and Finalize need seniors.

Each workstation also gets a free **DevOps engineer** automatically. You never hire or fire it.

> **In the app:** Help, "Agents" (`/help/agents`).

### 3.6 Create your first project (1 minute)

1. Open **Projects** and click **New project** (Owners and Admins only).
2. Give it a **Name** and a short **Key** (for example `WEB`; card references look like `WEB-1`). Choose the **Workflow**: **Code** for software, **Research** for investigations, or a custom workflow your organization designed. Click **Create project**.
3. For a code project, open the project's **Settings** (the gear on the Projects page) and, under **Repositories**, add your repository: a name, the git address of your code and the **working branch**, the branch that finished work goes into (usually `main`). A research project needs no repository.

![The new project dialog](guide/assets/dlg-new-project.jpg)

> **In the app:** Help, "Projects" (`/help/projects`).

### 3.7 Create your first card (2 minutes)

1. Open the project's board and click **New card**.
2. Fill in the form. Be concrete, as if you were briefing a new colleague:
   - **Title:** what it is ("Show the last login time on the profile page").
   - **Context:** why it matters.
   - **Requirements:** what must be done.
   - **Acceptance criteria:** how you will know it is done, one line each.
   - **Affected areas, Constraints, Test plan:** what to touch and not to touch, and how to check it.
   - **Completion action:** what happens at the end: open a pull request, push the branch, or merge.
3. Click **Specify**. The card moves to **To do** and the agents pick it up. If a required field is missing, the form tells you which. Use **Save draft** if you want to finish later.

![The New card form](guide/assets/card-new.jpg)

![The form tells you which fields are still missing](guide/assets/card-new-missing.jpg)

> **Tip:** you do not have to write it all yourself. Open a chat with the BA ("Chat" button on the desk), say what you want in your own words, and the BA drafts and specifies the cards for you.

### 3.8 Watch it happen

Within a minute the card moves to **Build**. A builder works on it, then a reviewer, then a tester. Open the card to follow along: the **Live shift** panel shows what the agent is doing right now, **Handoffs** shows the notes agents leave for each other, and **Timeline** records every step.

![A card in the middle of a shift](guide/assets/card-live.jpg)

When an agent needs a decision, the card turns **Blocked** and the question appears on your **Desk**. Answer it and work continues. When the card is done, you will find the change on the branch (or pull request) you chose.

![A question waiting on the desk](guide/assets/desk-question.jpg)

You now have a working team. The rest of this guide is for when you want more: more control, more automation, or more safety.

## 4. For Owners and Admins

The **Owner** runs the organization: there is exactly one, and the Owner can hand the role to someone else. **Admins** are appointed by the Owner and help manage. This chapter covers everything the two roles do. Where something is only for the Owner, it says so.

| | Owner | Admin |
| --- | --- | --- |
| Create projects, add people to projects, change project settings | yes | yes |
| See every project of the organization | yes | yes |
| Invite Members | yes | yes |
| Invite, promote or demote Admins; change roles | yes | no |
| Remove Members | yes | yes |
| Remove Admins | yes | no |
| Hire, change and fire any agent, widen an agent's permissions | yes | yes |
| Set budgets, see Costs | yes | yes |
| Design roles, workflows and departments | yes | yes |
| Org-wide schedules, interests quiet cap, BA settings | yes | yes |
| See plan and limits | yes | yes |
| Require two-factor login for everybody | yes | no |
| Hand over ownership | yes | no |

### 4.1 Your organization

Open **Organization** at the bottom of the sidebar. The **General** tab shows the organization's name (rename it here) and the security switch for two-factor login (4.15).

![Organization settings: General](guide/assets/org-general.jpg)

If you belong to several organizations, the **organization switcher** at the top of the sidebar shows which one this browser tab works in. A different tab can work in a different organization. Projects of an organization where you are only a guest carry a "Guest" label.

### 4.2 Members, invitations and guests

On **Organization, Members** you see everybody with their role.

![The Members tab](guide/assets/org-members.jpg)

**To invite someone:** click **Invite member**, type their email, choose the role (**Member**, or **Admin** if you are the Owner) and, if you like, the projects they should start on, then **Send invitation**. They receive an email with a link that works for 7 days. On the **Invitations** tab you can see pending and past invitations, resend one or revoke one.

![Inviting a member](guide/assets/dlg-invite.jpg)

![The Invitations tab](guide/assets/org-invitations.jpg)

**To change a role or remove a person:** use the role selector and the remove button in the Members list. When somebody is removed, their agents are handed to you and any cards those agents held go back into the queue. Anyone except the Owner can leave an organization. The Owner must hand over ownership first (**General, Transfer ownership**, which asks for your password).

**Guests** are people from other organizations who work in a project you shared. The **Guests** tab lists them and the projects they can reach (see 4.3, sharing a project).

![The Guests tab](guide/assets/org-guests.jpg)

> **In the app:** Help, "Organizations and roles" (`/help/organizations-and-roles`).

### 4.3 Projects

**Create a project** as in chapter 3.6. A new project goes to the bottom of your priority order (see below). Everything about a project lives in its **Settings** (the gear on the Projects page).

**Put your projects in order.** The **Projects** page lists your organization's projects, most important first. When an agent looks for its next card, it takes work in this order: scheduled work first (schedules, interest scans and an on-demand **Research this**), then cards that came back to it for rework, then the **project order** (the card of the project higher up first), and then the card's own priority, how long it has waited and its dependencies. An agent's **focus** projects (4.4) are a gentle preference ahead of the order. A shift that has started is never interrupted: a more important card waits for it to end.

Owners and Admins change the order by **dragging** a project by its grip (the dotted handle on the left), or with the **Move up** and **Move down** buttons on each row. With the grip selected, the up and down arrow keys move it as well, and Home and End send it to the top or the bottom. The order saves by itself. Members and Guests see the order but cannot change it. Archived projects are not ranked, and the hidden projects behind interests never appear: interests run on their own schedule and are not ranked.

![The Projects page in priority order](guide/assets/projects-ranked.jpg)

> **Good to know:** There is no work/personal split any more. "Personal" simply means your own organization: keep personal projects in it, or in an organization of your own that you switch to. If your organization had a personal vault and personal projects from before, they were merged for you: the projects sit below your work projects in the order they had, and the personal vault's files are under `personal/` in the organization vault. The desk note you received says what happened.

![Project settings](guide/assets/project-settings.jpg)

What you will find there:

- **Repos:** the code the agents work on, and its **working branch**, the branch finished work lands on. Research projects need none.
- **Team:** who works in the project (see below).
- **Merging:** the setting **Merge large changes without my approval** (off by default). Read chapter 4.12 before turning it on.
- **Simultaneous shifts:** an optional cap on how many shifts may run at once in this project.
- **Budget** (4.6), **Phases and deploys** (4.10), **Stage** (4.13) and **Archive** (4.14).

**Who answers a card's questions.** By default only the card's creator answers them. On the card page you can let any project member answer (**Who answers its questions**).

**Project types.** A **code** project follows Spec, Build, Review, Test and Finalize. A **research** project follows Question, Research, Fact check and Publish and writes its results as notes into the project's vault folder. Your organization can also design its own workflows (4.7).

**Adding people to a project.** Only Owners and Admins add people. Add an organization member under **Team** in the project settings. They get access at once. To share with somebody from another organization (a guest), type the email of an existing account and click **Invite**. They accept in the **Project invitations** inbox on their Projects page, and they only ever see this project. There are no guests without an organization. Someone with no account must be invited as a Member of your organization instead.

> **Watch out:** removing a person from their last project hands their agents back to you (they need a new home on one of your workstations). Cards those agents held go back into the queue.

**Vaults.** A vault is a git repository of notes that syncs to your workstations. There are two kinds: the **organization vault** (your organization's knowledge, including your interests under `interests/`, shared among Owners and Admins) and a **project vault** (shared with the project's members; a project without one reads the organization vault). Register them under **Vaults** in the sidebar. The address must not contain a password or token. Use an SSH key or a credential helper on the workstation instead.

![Vaults](guide/assets/vaults.jpg)

> **In the app:** Help, "Projects" (`/help/projects`) and "Ledger and vaults" (`/help/ledger-and-vaults`).

### 4.4 Agents, hiring and allow-lists

Agents belong to the organization, not to a single project. For each agent you decide where it may work: its **allow-list**. The agent is only offered cards from those projects.

![The Agents page](guide/assets/hr.jpg)

**Hiring** works as described in 3.5. Hiring has a few more options:

- **Where may this agent work?** **Any project** (Owners and Admins only) or **Selected projects**, ticked one by one. An empty list **benches** the agent: it takes no work until you give it projects again. A star next to a project means *preferred*: when two cards are waiting, the agent takes the starred project's card first.
- **Seniority** decides who may review large changes and who handles harder work.
- **Effort and Model:** how hard the agent thinks. Higher costs more.
- **Skills:** extra know-how, such as "Playwright" or "database migrations".

**Changing an agent.** On the agent's card use **Projects** (the allow-list), **Change model**, **Change role**, and **Fire**. Firing releases the cards the agent holds back to the queue with the last handoff, deletes the agent's private sandbox, and retires the name. The agent's history stays in the records. A fired name is never reused.

![Changing an agent's allowed projects](guide/assets/dlg-allowlist.jpg)

**Each agent card also shows** what the agent costs this month and in total, how many cards it finished, its bounce rate (how often review sent its work back) and its current work.

**Recommendations.** The Agents page suggests changes based on how the team performs: a different model, hiring another reviewer, or a standing order. You can apply them in one click, or ignore them.

![Recommendations on the Agents page](guide/assets/hr-recs.jpg)

**Safety.** Agents run inside a sandbox on the workstation, so they cannot read your whole disk. Some computers cannot offer a sandbox (for example plain Windows). The app then shows an amber warning on the workstation, on each affected agent and in the Hire form, and hiring onto that machine needs an explicit confirmation. Prefer a workstation with a sandbox (Linux, macOS, or Windows with WSL2).

![The unsandboxed warning when hiring](guide/assets/dlg-hire-unsandboxed.jpg)

**The DevOps engineer.** Each workstation has one, free of charge. It installs tools, starts containers, pulls and pushes vault changes and keeps repositories tidy (next section). You can only reset it, never fire it, and only change its model and effort.

> **In the app:** Help, "Agents" (`/help/agents`).

#### Repository hygiene and the working branch

Once a day per workstation the DevOps engineer tidies the project repositories on that machine: it fetches and pulls, **commits any uncommitted changes to the working branch** and pushes them, and removes branches and worktrees of cards that are finished and merged. Change the time or switch it off in the workstation's **Repository hygiene** panel on the Workstations page, or start it with **Run hygiene now**.

![Repository hygiene on the Workstations page](guide/assets/ws-hygiene.jpg)

**The working branch is something you confirm. It is never guessed.** While a repository has no confirmed working branch, the DevOps engineer does not commit, pull or push in it. It only reports the changes and asks you on the desk: *Which branch is the working branch of this repository?* Your answer is stored on the repository and in the ledger, and the DevOps engineer carries on at once. You can also set it any time in the project settings, in the repository row (**Change**). You are asked again when a new intake or phase starts ("keep `main` as the working branch?").

![The desk asks which branch is the working branch](guide/assets/desk-branch.jpg)

What hygiene cannot resolve, it does not force: a conflict while pulling, changes on the wrong branch, a failed login, a missing clone, or a leftover worktree with uncommitted work. These appear under Failures in your BA's daily report until a later run finds the repository in order.

> **In the app:** Help, "DevOps and repository hygiene" (`/help/devops-and-hygiene`).

### 4.5 The desk, the ledger and standing orders

The **Desk** is where every question and approval reaches you. Cards do not move past a question until you answer.

![The Desk](guide/assets/desk.jpg)

Each desk item says **what kind it is** (Question, DevOps approval, Merge approval, Outbound update, Digest to rate, Alert, Floor report, and so on), **who asked and what they were doing**, the **question** with options and a **recommendation**, and **how many cards are waiting**. To answer, click an option or type your own answer, optionally add it to the ledger, and click **Answer**.

![A question with options and a recommendation](guide/assets/desk-question.jpg)

When you answer you can also record it in the **ledger** as a **requirement** (a permanent rule), a **standing order** (an instruction every agent reads at the start of every shift) or a **decision** (a one-time choice kept for history). That is how the team learns: the next agent who is about to ask the same thing finds your answer first, and the desk shows "similar decision in the ledger".

The **Ledger** page lists everything and is searchable. Organization-wide standing orders can only come from the Owner and Admins. A project owner adds project-wide ones.

![The ledger](guide/assets/ledger.jpg)

> **In the app:** Help, "The Decision desk" (`/help/desk`) and "Ledger and vaults" (`/help/ledger-and-vaults`).

### 4.6 Budgets and costs

Every shift records what it used (input, output and cache tokens and the model). The server turns that into money at the **list prices** of the models, in US dollars, and shows it in your organization's currency. These are estimates of what the work costs, not an invoice. Chats count too: to the project when the chat is about a card or project, otherwise to **Org overhead**.

**Where spend shows:**

- the **Costs** page (Owners and Admins): spend by project, agent, model and day for any date range, with an **Export CSV** button;
- the **project settings** and the **board header** ("$9.00 of $10.00 this month");
- each **agent card**, each **card** and each **phase**;
- the **BA's floor report**.

![The Costs page](guide/assets/costs.jpg)

**Monthly budgets.** In the project settings, **Monthly budget** sets a limit for the project. (An interest has its own budget on its Settings tab, 4.9.) The month runs from the 1st to the end of the month in your time zone.

![The Monthly budget panel](guide/assets/budget-panel.jpg)

- **At 80%** you get one notice on the desk and a line in the daily report. Work carries on.
- **At 100%** the project is **paused**. Running shifts finish, but nothing new starts. Cards wait in the queue. A banner on the board says so, and a desk item offers **Raise budget** (the pause lifts as soon as the new amount is above the spend) or **Override for this month** (work resumes until the 1st).
- **On the 1st** the month starts again from zero.

![The board banner when a project is over budget](guide/assets/budget-banner.jpg)

Setting a budget below what was already spent pauses the project at once. Members can see the progress but not change it. Guests see only that a project is paused.

**Currency.** Under **Costs, Currency and prices** type a three-letter currency code and how many units make one US dollar (for example `EUR` and `0.92`). Changing the rate changes how history is shown, not what was recorded.

> **In the app:** Help, "Budgets and costs" (`/help/budgets-and-costs`).

### 4.7 The org chart, roles and workflows

**Org chart** (sidebar, Organization) shows who works for you and who answers whom, as a tree: you at the top, then the BAs, then each department with its seniors above its juniors. The lines are the **escalation path**: a question goes to a senior of the same role, then to the BA, then to your desk. Each tile shows the agent's face, name, role, what it is doing and its workstation. Click an agent for its card. **List** shows the same as grouped lists (the default on a phone).

![The org chart](guide/assets/org-chart.jpg)

**Roles & workflows** (sidebar, Organization) lets you extend the team beyond the built-in roles.

- **Roles.** Built-in roles (builder, reviewer, tester, writer and others) cannot be removed, but you can extend them with extra instructions, skills and standing orders (**Extend**). You can also design **custom roles**: a name and purpose, instructions, permissions, skills, a default model and which workflow stages the role may claim.
- **Workflows.** A workflow is a set of stages with a role for each and a route for success and failure. Design your own, for example a support-triage flow. The BA checks that every stage can be reached and every failure ends somewhere.
- **Departments** group roles by function so you can filter the board and the Agents page.
- **Design chat.** Click **Start a design chat** and the BA interviews you and drafts the role or workflow.

Everything you design is **submitted to the desk for your approval** before it can be used.

![The design chat: the BA asks what it needs to know](guide/assets/org-design-chat.jpg)

![Roles in the organization designer](guide/assets/org-roles.jpg)

![Designing a workflow](guide/assets/org-workflows.jpg)

> **In the app:** Help, "Organization chart and design" (`/help/org-chart-and-design`).

### 4.8 Schedules and integrations

A **schedule** is *a trigger and one action*. Open **Schedules** in the sidebar and click **New schedule**. A three-step wizard asks **When**, **What** and **Details**.

![The schedules page](guide/assets/schedules.jpg)

**When (the trigger):**

| Trigger | What it does |
| --- | --- |
| **On a schedule** | A time such as "Weekdays at 07:00" or your own cron expression, in a time zone you choose. If the server was down, a missed run happens once, not many times. |
| **When something happens** | A phase is completed, a card is finalized, an interest run is done, or a project is converted. |
| **When an issue is labelled** | A GitHub or Jira issue gets a label you choose. One of your workstations checks, using its own login. |
| **Only when I run it** | No automatic trigger. Use **Run now**. |

**What (the action):**

- **Create a card** from a template, with the date or the issue title in the name if you like.
- **Run a regression** (a full test run).
- **Ask DevOps** to do something on a workstation, or run repository hygiene.
- **Ask the BA** to look at something and write a report on your desk.
- **Poll GitHub or Jira issues** and send each new one into **intake**.
- **Send a webhook** to Slack, Microsoft Teams, n8n, Zapier or your own code. Every request is signed so the receiver can check it came from you. Failed deliveries are retried a few times.
- **E-mail a digest**: the floor report, a project summary or an interests digest, at a time you choose.

![The schedule wizard](guide/assets/schedule-wizard.jpg)

**History** on each schedule lists every run, what triggered it, what it did and why it failed if it did. **Send test** sends one test delivery for webhooks and e-mails.

**Who may do what.** A schedule inside a project can be made and run by any member of that project. A schedule that acts for the whole organization (BA tasks without a project, hygiene, the floor report digest) is for Owners and Admins. A suspended organization skips its schedules.

**Intake and the outbox.** The **Intake** page (sidebar, Owners and Admins) is where you hand the BA a ticket: paste a Jira key or a GitHub issue address and the BA reads it, asks you about anything unclear, maps it to a project and drafts the cards. Updates the agents want to post back to the ticket (a comment, a resolution) wait on your desk as **Outbound update** items. You can edit them, approve or reject. Nothing is posted without your approval, and agent names and internal details are scrubbed from the text. Jira and GitHub logins stay on your workstation.

![Intake](guide/assets/intake-view.jpg)

![An outbound update waiting for approval](guide/assets/desk-outbound.jpg)

> **In the app:** Help, "Schedules and integrations" (`/help/schedules-and-integrations`) and "Intake and outbox" (`/help/intake-and-outbox`).

### 4.9 Interests

An **interest** is a topic you follow. Agents look for new items on a **run schedule**, and deliver what they found to your desk on a **delivery schedule**. Keeping those two apart is how you avoid being flooded.

![The Interests page](guide/assets/interests.jpg)

**Create one:** **Interests** in the sidebar, then **New interest**. Fill in:

- **Name and description:** the angle, what to include and what to leave out.
- **What to collect:** articles, videos, podcasts, and the most items per run.
- **Run schedule:** for example "Daily at 07:00", or only when you press **Run now**.
- **Delivery schedule:** **As one digest at set times** (for example weekdays at 07:00) or **As soon as a run finishes**.
- **Preferred agents:** a scout, a curator, a researcher and a fact checker. This is a soft preference. Any available qualified agent takes the run, so nobody waits.

On the interest's page, **Overview** shows both schedules and what is waiting for delivery. **Run log** lists every run with its items, cost and agents. **Digest** is the running list of everything delivered, with rating buttons. **Settings** and **Taste** are where you tune it.

![An interest's Digest tab](guide/assets/feed.jpg)

**Teach it your taste.** Rate digest items **useful**, **irrelevant** or **boring**. The curators learn from the ratings and write rules into the interest's `taste.md`. You can also type your own rules on the **Taste** tab ("Skip beginner tutorials"). Your written rules win over the learned ones.

![Taste rules](guide/assets/interest-taste.jpg)

**Research this.** On an interest or on one digest item, **Research this** starts a researcher and a fact checker, with the depth you choose (**Quick**, **Standard** or **Deep**), and publishes a note into the interest's folder. Research happens only on demand.

**The daily quiet cap** (bottom of the Interests page) limits how many digest items reach your desk in a day across all interests. Items over the cap wait for the next delivery.

**Transcripts.** Videos and podcasts come with a transcript so you can read instead of watch. Transcripts of video sites need **yt-dlp** on the workstation (the installer offers it).

**Who sees an interest.** Owners and Admins see all interests. An interest made by a Member or Guest is private to them until an Owner or Admin shares it. Whoever made an interest, or someone with an equal or higher role, may change it.

> **In the app:** Help, "Interests" (`/help/interests`).

### 4.10 Phases and follow-ups

A **phase** is a named slice of a project's work, the cards you want to ship and check together. When all its cards are finished and merged into the working branch, your BA tells you and proposes what happens next: deploy, run the regression suite, something custom. **Nothing runs until you approve.**

![A phase](guide/assets/phase.jpg)

**Set up (project settings):** add **Deploy targets** (a local Docker stack on every project member's workstation, or a remote host that a workstation deploys to over SSH) and the **Default follow-ups** every new phase starts with, for example "Deploy to local, then Regression run against local". No passwords or keys are stored in the site.

**Create a phase** under **Project settings, Phases and deploys, New phase**, or let the BA propose one while you talk about the work ("this is phase 2"). Add cards from the phase page or from the card's **Phase** selector. A card belongs to at most one phase.

**When is a phase done?** When every card is finalized and its work is in the working branch (or closed or cancelled). If the app cannot see a squash-merged branch, click **Mark merged** on the phase page.

**The "Phase done" item** on your desk carries a report of what was delivered and what is outstanding. You can **Edit follow-ups**, **Approve all**, **Reject** (nothing runs), or **Reopen the phase**.

![The phase-done approval](guide/assets/desk-phase-done.jpg)

**What runs after you approve:** the follow-ups run **in order, one at a time**. If one fails, the ones after it are skipped. At the end a **Phase results** notice lists each result with its evidence.

> **In the app:** Help, "Phases and follow-ups" (`/help/phases`).

### 4.11 Your BA reports to you

The BA is your eyes and ears on the floor. It reports in three ways, and it never slows an agent down.

**What goes through the BA.** With **routing** on (the default), urgent items such as blocking questions and approvals reach your desk **at once**, unchanged, and the BA adds a note a little later (how often this was asked, what the ledger says). Less urgent items wait up to **10 minutes** for the BA, which passes them on, folds duplicates together, or dismisses noise it can show is covered. If the BA is slow or offline, items reach you unchanged. Switch routing off in **Settings, Your BA reports to you** to see everything as it is raised.

**Signals the server watches** (every minute, without spending tokens):

| Signal | Threshold | You hear |
| --- | --- | --- |
| A card keeps failing | 3 failed shifts on one card in 10 minutes | At once |
| The same approval asked again and again | 3 times in 24 hours | In the daily report |
| Blocked too long | A blocked card waits more than 4 hours | In the daily report |
| Nobody can take it | A queued card nobody can take for 30 minutes | In the daily report |
| Repeated failures | A card in rework round 3, or finalize failed twice | In the daily report |
| Repository hygiene problem | A conflict, wrong branch, login failure or missing clone | In the daily report |
| Budget | 80% of a monthly budget, or 100% (paused) | 80% in the report, 100% at once |

**The daily floor report.** At **08:00 your time** (change it under Settings) the BA posts one **Floor report** on your desk, on days with something to say. It lists phases waiting, stuck and backing-off cards, repeated approvals, failures, open DevOps requests, what the BA resolved itself, **spend** and highlights from your interests. Open **The facts behind this report** for the same lists straight from the server, and use the **BA reports** chat to ask "why?".

![The floor report](guide/assets/desk-floor-report.jpg)

![Settings: time zone and how your BA reports to you](guide/assets/settings.jpg)

> **In the app:** Help, "Your BA reporter" (`/help/ba-reporter`).

### 4.12 Testing, finalizing and risk

Once a reviewer approves, the card moves to **Test**. A tester runs the tests of the test plan. If they fail, a bug card is created on the same branch, and the original card waits ("waiting on bug") until the bug is fixed and the tests pass.

**Risk tier.** The app computes it from the size of the change: **Small**: one reviewer and one tester. **Large** (200 or more changed lines, or changes in the architectural areas you configured, or a refactor): two different senior reviewers. You can override it on the card (**Change** next to the risk tier) with a reason. A 50-line change to a critical system may deserve large-tier review.

![Setting the risk tier](guide/assets/dlg-risk.jpg)

**Finalize.** The BA completes the card in the way you chose: **PR** (push the branch and open a pull request), **Push branch**, or **Merge** to the working branch (small cards). **A large merge waits for your approval** on the desk, and the card stays in the Finalize column with an "Awaiting your approval" badge.

![A large merge waiting for approval](guide/assets/desk-large-merge.jpg)

> **Watch out:** in project settings, **Merge large changes without my approval** lets large changes merge as soon as they are finalized. Only the two reviews, the tests and the post-merge full suite then stand in between. It is off by default, only the project owner can change it, it asks you to confirm, and every change is recorded.

After a merge, a **full suite** card runs the entire end-to-end suite once. If it fails, a bug card and a desk notice follow. **Run regression** on the board runs the whole suite on demand.

> **In the app:** Help, "Testing and finalization" (`/help/testing-and-finalization`).

### 4.13 Conversion, the Research tab and research cards

**Research cards in any project.** Pick the card type **research** on the New card form to ask a question in any project. It runs on the research workflow (question, research, fact check, publish) and gets a **Research** chip on the board.

**Converting a project.** A project that started as research converts to a delivery project when the questions are answered. Owners and Admins do it in **Project settings, Stage, Convert project** (or the **Convert to project** button on a research project's board). A short dialog asks:

1. **Workflow:** the target, usually Code.
2. **Repositories:** a workflow that works in code needs at least one. Add one, or **request a new GitHub repository**. The request lands on your desk and your own workstation creates it with your GitHub login when you approve.
3. **Open cards:** for cards that run on another workflow, choose **Keep** (they finish on their own workflow) or **Cancel**.
4. **Hand-over:** the published notes are listed in the project's `PROJECT.md` so every agent that works there reads them.

![The Convert project dialog](guide/assets/dlg-convert.jpg)

Cards, notes and history stay as they are. For each repository added, the DevOps engineer asks which branch is the working branch.

**The Research tab.** A project with published research notes (or one that started as research) has a **Research** entry in the sidebar. It lists the research cards in progress and every published note with its path in the vault, a preview and its sources.

![The Research tab](guide/assets/research-tab.jpg)

> **In the app:** Help, "Converting a project" (`/help/project-conversion`).

### 4.14 Archive and delete

**Archive** a project you no longer use: **Project settings, Archive, Archive project**. The dialog lists what will stop (running shifts, open cards, schedules and open desk items) before you confirm. Branches and history are kept. Agents are not fired. They simply stop getting the project's work. **Restore** it from **Projects, Archived**. Cards the archive closed stay closed.

![Archiving a project shows what will stop](guide/assets/dlg-archive.jpg)

**Delete permanently** is possible only for an archived project, only for the project owner, and asks you to type the project key. The project's cards, threads, schedules and notes are removed from the database and cannot be recovered. The audit log keeps a record and the vault folder is never touched. An agent that was allowed on that project only is **benched**, and the desk names the benched agents so you can reassign them.

### 4.15 Security and two-factor login

Everyone can turn on two-factor login under **Your settings** (3.2). As Owner you can **require it for the organization** on **Organization, General** (see the General tab in 4.1). Members who have not set it up are then held at the setup screen until they do. You need it on your own account first.

If a member loses their phone and their recovery codes, you reset their two-factor login on the **Members** tab (**Reset two-factor login**, Owner only). They set it up again at the next sign-in.

> **Tip:** a suspended organization (unpaid, trial over) keeps its data. Running shifts finish, nothing new starts, and only the Owner can still sign in to see settings and members. Everything resumes where it stopped when the platform administrator reactivates the organization.

### 4.16 Plan and limits

**Organization, Plan & limits** shows your plan, status, licence date, how much you use, and which features are switched on. Today there is one plan, **Founding**, with every feature and **no limits** (the limit fields are empty, meaning unlimited). The platform administrator changes the plan. If a feature is switched off, its page leaves the sidebar, but its data is kept.

![Plan and limits](guide/assets/org-plan.jpg)

### 4.17 Chatting with agents

Click **Chat** in the top bar (or on the Desk), pick an agent and choose **Start chat**. Ask about a card, discuss a blocker, or ask the BA to draft cards. The BA works with your rights, so it can only use projects you are a member of. Conversations are saved, and a chat tied to a project is marked as visible to that project's managers.

![A chat with the BA](guide/assets/chat-ba.jpg)

![The chat start screen lists earlier conversations](guide/assets/chat-start.jpg)

> **In the app:** Help, "Chat with agents" (`/help/chat-with-agents`).

## 5. For Members

A **Member** works inside the projects an Owner or Admin has added them to. You do the day-to-day work: write cards, answer questions, hire your own agents and follow the board. You do not manage the organization.

![What a Member sees: the projects they were added to](guide/assets/member-projects.jpg)

### 5.1 What you can do

| You can | You cannot |
| --- | --- |
| See the board, desk items and cards of **your** projects | See other projects, create a project or change the priority order |
| Create and edit cards, and comment | Add or remove people, or change project settings |
| Move, release or cancel **your own** cards | Manage cards of other people (ask an Owner or Admin) |
| Answer questions on your own cards | Answer project-level decisions (Owners and Admins do) |
| Pair **your own** workstation and hire agents on it, for projects you are on | Hire agents on someone else's workstation, or widen an agent's permissions |
| Change or fire the agents **you** hired | Change other people's agents |
| Chat with the agents allowed on your projects | See Costs, Intake, Plan and limits or the Invitations tab |
| Create interests, and schedules inside your projects | Create schedules that act for the whole organization |
| Turn on two-factor login, and leave the organization | Change roles or remove people |

The **Members** list under **Organization** is visible to you, read-only.

![The read-only Members list for a Member](guide/assets/member-org.jpg)

### 5.2 Your first day

1. **Sign in** and take the tour (3.1 to 3.3). Turn on two-factor login (3.2).
2. **Open the board** of a project you were added to. The sidebar's **Board** entry opens the project you used last. The project switcher at the top of the page changes project.
3. **Create a card** (3.7), or ask the BA in a chat to draft one for you. Only cards you created, or that were assigned to you, show actions such as **Move** and **Cancel**.
4. **Answer questions.** The desk shows questions about your cards. Questions about other people's cards are read-only for you, unless the project's decision policy allows any member to answer.
5. **Use your own computer if you like.** Under **Workstations** you can add a workstation (3.4) and hire agents onto it. Those agents work for the projects you are on, and for no one else. Hire them with the allow-list limited to the projects you are on.

### 5.3 Good habits

- Write cards like a briefing to a new colleague. A clear card is the cheapest way to get good work.
- Use the **Chat** button to ask the BA when you are unsure how to phrase something.
- Check the desk once or twice a day. Blocked cards wait for answers, and waiting costs time, not money.
- Keep an eye on the budget bar in the board header. If the project nears its budget, tell an Owner or Admin before the pause starts.

> **In the app:** Help, "Board and cards" (`/help/board-and-cards`) and "The Decision desk" (`/help/desk`).

## 6. For Guests

A **Guest** is someone from another organization who was invited to work in one project of this one. You keep your own organization and your own account. The invitation adds one project, and nothing else.

### 6.1 Accepting the invitation

1. Sign in with the account the invitation was sent to. (There are no guests without an account in some organization. If you have none, ask for a Member invitation instead.)
2. Open **Projects**. At the top, the **Project invitations** inbox names the organization that invited you. Click **Accept invitation**.
3. The project now appears in your project list with a "Guest" label and the other organization's name. The organization switcher in the sidebar lists it under "Guest in".

![The Project invitations inbox on the Projects page](guide/assets/guest-invitation.jpg)

### 6.2 What you can do as a Guest

- See the project's **board** and its cards, create cards, comment and answer questions on your own cards.
- **Chat** with the agents that work on this project.
- **Hire agents onto your own workstations**, for this project only. An agent of yours never works on the host organization's other projects, whatever its allow-list says.
- Leave the project when you are done.

### 6.3 What you cannot do

- You see **nothing at organization level**: no org settings, members, costs, org chart or agents of other people.
- You cannot change project settings, add people or archive the project.
- You cannot see the host organization's vaults, ledger entries that belong to other projects, or other projects at all.
- You never see the money: a paused project shows only that it is paused, not the amounts.

![A project seen by a guest](guide/assets/guest-project.jpg)

If you are removed from the project, the agents you hired for it move back to the owner of the project, and cards they held go back into the queue.

## 7. For the platform administrator

The **platform administrator** (also called the **super admin**) runs the Guildwise HQ service itself, not any one organization's work. You sign in at the same address as everyone else, but you see only the **Platform** area. You can never see an organization's cards, desk, vaults, ledger, chats or agents. That is by design.

### 7.1 First sign-in and two-factor login

A platform account is created on the server with a command (see `docs/DEPLOY.md`). At your first sign-in the app holds you at the two-factor setup: type your password, scan the QR code, type the first code and **save the ten recovery codes**. Two-factor login is mandatory for platform accounts. If you lose your password, an operator resets it on the server (`superadmin-reset-password`, with `--reset-two-factor` if the second factor is lost too).

![The platform area, Organizations](guide/assets/platform-orgs.jpg)

### 7.2 Organizations

**Organizations** lists every organization with its status (trial, active, suspended, cancelled), its Owner, its plan and its usage (members, workstations, agents, projects). Click one for its detail page.

![An organization's detail page](guide/assets/platform-org-detail.jpg)

On the detail page you can:

- **Suspend** an organization (unpaid, trial over, licence date passed). Running shifts finish and nothing new starts. Scheduled runs are skipped and recorded. A banner explains it. Only the Owner can still sign in, with read access plus organization settings and members. **Reactivate** it and everything resumes where it stopped.
- **Cancel** an organization.
- Change the **plan, limits, licence date, grace period and feature switches** (Interests, Integrations and intake, Outbound updates, Research, Phases, Browser tools, Custom roles and workflows). Every change needs a **reason**, and it goes into the audit log. Today there is one plan, **Founding**, with no limits.
- **Transfer ownership** to one of the organization's Admins, for example when the Owner left the company. This needs a written reason and is audited.

### 7.3 Invitations: starting a new organization

**Invitations** is where a new customer begins. Type the **Owner's email** and the **organization name** and click **Send invitation**. The invitee receives a link, chooses a name and password, and becomes the Owner of the new organization (they may rename it). Invitations can be resent or revoked from the **All invitations** list.

![Inviting a new organization](guide/assets/platform-invitations.jpg)

### 7.4 Accounts

**Accounts** lists every login. You can **deactivate** and reactivate an account. Deactivating someone unlinks their workstations, parks their agents and releases cards they held. You can also **reset a person's two-factor login** if they lost their phone and their recovery codes. The last active Owner of an active organization cannot be deactivated. Transfer ownership first.

![Accounts](guide/assets/platform-users.jpg)

### 7.5 The Support inbox

**Support** collects every **Contact us** request from every organization and from visitors who are not signed in (chapter 10). Filter by status (open, answered, closed), type or organization, and search by reference, name, email or subject. Open a request to see who wrote, from which organization, the page they were on, the app version, browser and recent errors, and any screenshot. Then **reply** (the reply is emailed to the person and shows under **Help, My requests** in the app) or **reply and close**. A reply to an answered or closed request from the person reopens it.

At the top, set the **support address**. Every new request and follow-up is also emailed there (with the writer's address as Reply-To), so your team can work from its own mailbox as well.

![The Support inbox](guide/assets/platform-support.jpg)

![One support request](guide/assets/platform-ticket.jpg)

### 7.6 The audit log

Every platform action (suspending, plan changes, invitations, ownership transfers, resets) is recorded in the **Audit log** with who did it, when, and the reason given. It is kept forever and cannot be edited. Filter it by action.

![The audit log](guide/assets/platform-audit.jpg)

> **In the app:** the platform area has its own Help, with "Organizations and roles" (`/platform/help`). Platform accounts get their own short tour.

## 8. Everyday workflows

Four situations you will meet again and again, start to finish.

### 8.1 A feature, from intake to deploy

**You want:** the order history page gets a CSV export, and it should be live for customers.

1. **Say what you want.** Open a chat with the BA (**Chat** on the desk): "Customers keep asking for a spreadsheet of their orders. Add a CSV export to the order history page." Or paste the Jira or GitHub issue into **Intake**. The BA reads it, asks you what it cannot decide (which columns, which delimiter) and drafts the card with requirements and acceptance criteria.
2. **Check the card.** Open it. If the draft is not quite right, **Edit** it (possible while it is a draft or queued and not yet claimed). Click **Specify** when it reads well.
3. **Let the team work.** The builder builds, the reviewer reviews (sending the work back with comments if needed, which shows as *rework*), the tester tests. Open **Timeline** and **Handoffs** any time to see why.
4. **Answer questions.** If the builder asks "should the CSV include cancelled orders?", the question reaches your desk with options and a recommendation. Pick one and add it to the ledger as a **decision**, and nobody will ask again.
5. **Finalize.** For a small card the BA pushes the branch or opens a pull request as you chose. A large change waits on your desk for **Approve merge**.
6. **Group it into a phase** if several cards ship together. When they are all merged, the **Phase done** item arrives with a report. Approve the **Deploy** and **Regression run** follow-ups and watch **Phase results**.
7. **Done.** The card is in the Done column and the change is in your working branch (and, after the phase, deployed and tested).

![A finished card with its timeline](guide/assets/card-detail.jpg)

### 8.2 From research to a project

**You want:** to find out whether a new payment provider is worth using, and build the integration if it is.

1. **Create a research project.** **New project**, workflow **Research**. No repository is needed.
2. **Ask the question as a card:** a title, the question, the scope and the depth (**Quick**, **Standard** or **Deep**). A researcher finds sources, a fact checker verifies every claim against them, and the result is **published as a note** in the project's vault folder, with sources.
3. **Read the notes** on the **Research** tab. If a claim is not supported, the fact checker sends the note back for rework and says why.
4. **Decide.** When the answers are good enough, **convert** the project (**Project settings, Stage, Convert project**): choose Code as the target, add the repository (or request a new GitHub repository, which waits for your approval on the desk), decide what happens to open research cards, and write a hand-over note.
5. **Build.** The published notes are listed in the project's `PROJECT.md`, so every builder reads them. Create the first cards and carry on as in 8.1. The project remembers that it **started as research**, and the Research tab stays.

![A published research note](guide/assets/card-published.jpg)

### 8.3 Setting up interests without being flooded

**You want:** to follow AI news, but not get a hundred links a day.

1. **Create the interest** (**Interests, New interest**). Write the description like a briefing: "Practical agent engineering and coding assistants. No hype, no press releases." Choose the vault where its files live, and the kinds you want (articles, videos, podcasts).
2. **Keep the volume low.** Set **max total items** to something small, such as 5 or 10 per run. Choose a **run schedule** that matches how fast the topic moves (daily is plenty for most), and a **delivery schedule** of **one digest at set times** (for example weekdays at 07:00) instead of "as soon as a run finishes". Runs can happen as often as they like, but you only hear from them at the times you chose.
3. **Set the quiet cap.** At the bottom of the Interests page, **Daily quiet cap** limits how many items reach your desk per day across all interests.
4. **Teach it.** For the first two weeks, rate what arrives: **useful**, **irrelevant** or **boring**, with a short reason. Add taste rules ("Prefer primary sources over summaries", "Skip beginner tutorials").
5. **Go deeper only when it is worth it.** **Research this** on one item produces a fact-checked note. Research never starts by itself.
6. **Watch the cost.** The interest's **Settings** tab has a monthly budget. A paused interest does not run.

![An interest's schedules and settings](guide/assets/interest-settings.jpg)

If an interest cannot run (for example its workstation is offline), it shows a red **Cannot run** badge with the reason and raises a notice on your desk after the third attempt.

### 8.4 Controlling spend

**You want:** the agents to be useful without surprises on the bill.

1. **Look at what things cost.** Open **Costs** for the breakdown by project, agent, model and day, and the **Agents** page for each agent's monthly and total cost.
2. **Set budgets.** For every project, set a **Monthly budget** in its settings. Start with a number you would be comfortable losing and raise it when you trust it.
3. **Use the right model for the job.** A smaller model for reviewers and testers, a stronger one for builders and the BA. Change an agent's model any time (**Change model**).
4. **Let the 80% notice work for you.** When it arrives, check the **Floor report's Spend section** for which projects and agents cost the most.
5. **At 100%** the project pauses by itself. Decide on the desk: **Raise budget** or **Override for this month**. Declining to act is also a decision: the project stays paused until the 1st.
6. **Stop loops early.** If a card keeps failing, the loop breaker already backs it off (see 9.3) and your BA warns you. Do not keep feeding a card that cannot succeed. Cancel it or fix what it cannot do.
7. **Review monthly.** Export the Costs CSV and look for agents that cost more than they deliver.

![The budget panel and the month's progress](guide/assets/budget-panel.jpg)

## 9. Troubleshooting

### 9.1 The installer

| What you see | What to try |
| --- | --- |
| The wizard stays on "waiting for the installer" | The command was not run, or was run on a different computer than you chose. Run it on the computer that will host the agents. Check you pasted all of it. |
| The command link says it expired | The link works for 30 minutes. Choose your system again on the page to get a new command. |
| "Paired" never appears | The computer cannot reach this website. Check its internet connection, proxy and clock. Run the command again, it is safe to repeat. |
| A health check shows a warning (Claude, sandbox, Docker, yt-dlp, a repository) | Each row says what is wrong and how to fix it. Claude not signed in: run `claude` on the workstation and sign in. Sandbox missing on Linux: install `bubblewrap` and `socat`. Docker and yt-dlp are optional. |
| Windows asked to restart | Restart. The installer continues by itself when you sign in again. |
| Anything else | Open **Contact us** from the installer's failure screen. It already knows what went wrong. |

![The installer help in the Help centre](guide/assets/help-install.jpg)

> **In the app:** Help, "Installing a workstation: if something goes wrong" (`/help/install-troubleshooting`).

### 9.2 The runner is offline

A workstation that shows **Offline** or **Disconnected** cannot take work. Its agents show "offline" and cards that only they could take show an amber warning ("Reviewer Linus is offline").

1. Is the computer on and awake? Laptops that sleep disconnect.
2. On the workstation open a terminal and run `aom-runner status`. It shows whether the runner is running and connected.
3. If it is not running, `aom-runner start` (or restart the service the installer set up). Run `aom-runner doctor` for a health check of Node, git, Claude and the connection to the server.
4. Still stuck? Running the installer command again repairs the installation and keeps the pairing.

The warning icons clear by themselves when the machine returns (within about 30 seconds). Logs are in `~/.aom-runner/logs/`.

![A workstation that is offline](guide/assets/ws-offline.jpg)

### 9.3 A card is backing off

An amber badge "Backing off until 14:32 (3 failures)" on a card means the **loop breaker** stepped in. When three shifts on the same card end without a report within 10 minutes (the agent crashed, timed out or was stopped by a denied tool), the dispatcher stops handing the card out. The wait starts at 1 minute and doubles with each failure, up to 1 hour. You also get one alert on the desk.

1. Open the card and read the **Timeline** and the last **Handoff** for the reason. The usual cause is something the agent cannot do: a tool that is denied, a missing capability, a repository that is not on its workstation.
2. Fix the cause (adjust the card, the agent or the workstation).
3. Click **Release back-off** on the card to try again at once. Moving the card to another stage also clears it.
4. If it keeps failing, cancel the card and write a better one.

![The back-off badge on a card](guide/assets/card-backoff.jpg)

### 9.4 A budget pause

A banner "This project has used its monthly budget" and a desk item mean the project is paused. Running shifts finish, nothing new starts. See 4.6. On the desk choose **Raise budget** (the pause lifts as soon as the new amount is above the spend) or **Override for this month**. If you are a Member, tell an Owner or Admin.

### 9.5 A missing working branch

Symptom: the DevOps engineer does not commit or pull in a repository, and the desk asks "Which branch is the working branch?" (or the project settings show *not confirmed*). Answer the question on the desk, or set the branch in **Project settings, Repositories, Change**. The DevOps engineer commits and pushes right away. If the branch you named does not exist yet, create it in git first. See 4.4.

### 9.6 Two-factor recovery

- **You lost your phone, but have your recovery codes:** at the sign-in code step, type one of the ten recovery codes instead of the six digits. Each works once. Then set up two-factor login again on a new phone (**Your settings**), which gives you new codes.
- **You lost both:** ask your Owner to **reset your two-factor login** (**Organization, Members**; only the Owner can). If you are the Owner, ask the platform administrator (**Accounts**). If you are the platform administrator, an operator resets it on the server with `superadmin-reset-password --reset-two-factor`.
- **Too many wrong codes:** after five wrong codes the sign-in attempt is cancelled. Sign in again with your password and type the right code.

![The sign-in code step](guide/assets/login-2fa.jpg)

> **In the app:** Help, "Two-factor login" (`/help/two-factor`) and "Troubleshooting" (`/help/troubleshooting`).

### 9.7 Other things you may see

| What you see | What it means |
| --- | --- |
| A red warning icon on a card, "Not workable" | Nobody hired could ever take this stage. Hire the missing role (the tooltip has a **Hire** link). |
| An amber icon, "Waiting" | Agents exist but are offline or busy. It clears by itself. |
| The card says "waiting on bug" | The tester found a bug and a bug card is being fixed. |
| A desk item "Could not post the update" | The ticket system refused the post. Fix the login on the workstation and use **Retry**. |
| Vault sync paused with a conflict | A local and a remote change collided. Resolve it in the vault, then restart the sync. |
| "Out of scope" in a handoff | The agent found work outside its role. Adjust the card or the agent's skills. |

## 10. Contact us

If something is broken, confusing or missing, tell us. **Contact us** is in your avatar menu, in the command palette (Ctrl+K, type "contact"), on the **Help** page, on the installer's failure screens and, for people who are not signed in, in the footer of the sign-in page.

1. Choose what it is about: **bug report**, **question**, **feature request** or **billing**.
2. Write a subject and a message.
3. When you open it from the menu or the palette, a screenshot of the page you were looking at is attached automatically. You can remove it or upload a different image (PNG, JPEG or WebP up to 2.5 MB).
4. Open **What we send with your request** to see exactly what goes along: the page you were on, the app version, your browser and screen, and the last few errors from your browser (untick the box to leave the errors out). Your name, email and organization are added so that support can answer.

![Contact us](guide/assets/contact-us.jpg)

We answer by email, and the answer also appears under **Help, My requests**, where you can reply. A request is **Open** until we answer, **Answered** until you write again, and **Closed** when we are done. A request with a new answer shows a "New reply" badge.

![My requests](guide/assets/my-requests.jpg)

> **In the app:** Help, "Writing to us" (`/help/writing-to-us`).

## 11. Frequently asked questions

**Do the agents see my whole computer?**
No. They run inside a sandbox on the workstation, with access to the repositories and folders they need. Warnings appear if a workstation cannot provide a sandbox.

**Where is my code stored?**
On your workstations and in your git remotes, exactly as before. The Guildwise HQ website holds the board, cards, desk, ledger, and records of what the agents did. Passwords and tokens for Jira, GitHub and Claude stay on your workstation.

**Can an agent change my main branch by itself?**
Only for small cards you chose to **merge**, and only into the working branch you confirmed. Large merges wait for your approval, unless you turned that off in the project settings.

**What does it cost?**
Guildwise HQ itself is on the Founding plan with no limits. The AI work is billed by Claude: through your subscription or your API key. The app estimates the spend (4.6) and you set budgets.

**How many agents do I need?**
Start with a builder, a reviewer, a tester and a BA (3.5). Add more when cards queue up.

**Can I stop an agent?**
Yes. **Cancel** a card, or **Fire** an agent. A running shift is stopped, and its card goes back to the queue.

**An agent asked something I already decided.**
Add the decision to the ledger when you answer (4.5). Agents search the ledger before they ask.

**What if two of my projects have a card with the same number?**
Card numbers are unique only within one organization. If you are in two organizations with a `WEB-1` each, the app asks which one you mean.

**Can I use it on my phone?**
Yes: the board, the desk, cards, chat and most pages work on a phone. The installer needs a computer.

![The board on a phone](guide/assets/m-board.jpg)

![The desk on a phone](guide/assets/m-desk.jpg)

![A card on a phone](guide/assets/m-card.jpg)

**Where do I find help?**
**Help** in the sidebar: articles, the glossary, Contact us and My requests. The **?** hints open the matching article. Press **Ctrl+K** to search the app.

![The Help centre](guide/assets/help-centre.jpg)

**Which keys can I press?**
Press **?** (when not typing in a field) for the list of shortcuts. **Ctrl+K** opens the command palette.

## Appendix A. Where to find things

| I want to | Go to |
| --- | --- |
| See my work | **Board** (sidebar, Work) |
| Answer questions and approve things | **Desk** |
| Hand the BA a ticket | **Intake** (Owners and Admins) |
| Set up recurring jobs and integrations | **Schedules** |
| Create or change a project, or put the projects in priority order | **Projects** |
| Follow a topic | **Interests** (Knowledge) |
| Look up a past decision | **Ledger** (Knowledge) |
| Register a notes vault | **Vaults** (Owners and Admins) |
| Hire or change agents | **Agents** (Organization) |
| See who answers whom | **Org chart** |
| Design roles and workflows | **Roles & workflows** |
| Add a computer | **Workstations** |
| See how the team performs | **Metrics** |
| See and control spend | **Costs** (Owners and Admins) |
| Time zone, picture, two-factor, BA reporting | **Settings** (your avatar menu, Your settings) |
| Members, invitations, plan | **Organization** (bottom of the sidebar) |
| Help, glossary, contact us | **Help** |

## Appendix B. More documentation

- `docs/RUNNER.md`: the runner in depth (data folder, command-line, configuration, Windows and WSL2).
- `docs/DEPLOY.md`: installing and running the Guildwise HQ server (for whoever hosts it).
- `docs/SPEC.md`: the full product specification.
- `docs/ARCHITECTURE.md`: technical design.
- `docs/guide/Guildwise-HQ-User-Guide.pdf`: this guide with screenshots, as a PDF.
