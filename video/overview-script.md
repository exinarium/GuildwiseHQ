# Guildwise HQ overview video: script

**Purpose.** A high-level tour of Guildwise HQ for people who have never seen it: what it is, how the work flows, and the main features, at a glance. It is not a how-to. The section videos inside the app (Help) teach each area in depth.

**Target length.** 12 to 13 minutes, and never more than 15.

**Voice.** Kokoro-82M, voice `af_heart`, speed 1 (the same as the section videos; see `docs/guide/VIDEO-PLAN.md`). Narration is written for speech: short sentences, no bullet symbols, no URLs, and numbers in words.

**Pronunciation notes for the voice**

| Written | Say |
| --- | --- |
| Guildwise HQ | "Guildwise H Q" |
| Claude | "Claude" (the AI, as in the name) |
| Postgres | "post-gres" |
| aom-runner | "the runner" |
| 1.0 | "version one" |

**Screen rules**

- Show demo data only: the organization "Acme", the Owner "Alex Morgan", invented names, `example.com` and `demo.local` addresses. No real customer or personal data.
- Use the app's exact labels in `code` style, as in the section videos.
- Each beat must be something the screen really shows. Re-check the labels against `apps/web/src` before recording.
- Pause the narration for on-screen actions; the timings are targets, not a metronome.

---

## Chapter overview

| # | Chapter | Start | Target length |
| --- | --- | --- | --- |
| 1 | Welcome | 00:00 | 0:45 |
| 2 | A team of agents, not a chatbot | 00:45 | 1:15 |
| 3 | Your organization and who does what | 02:00 | 0:50 |
| 4 | The board: how a card travels | 02:50 | 1:40 |
| 5 | The Desk: decisions only you can make | 04:30 | 1:00 |
| 6 | From an idea to a PRD: Discovery and the Boardroom | 05:30 | 1:45 |
| 7 | Your agents, the CEO and the org chart | 07:15 | 1:15 |
| 8 | Workstations: your code stays on your machines | 08:30 | 1:15 |
| 9 | Control: approvals, budgets and the audit log | 09:45 | 1:00 |
| 10 | Releases, environments and integrations | 10:45 | 1:00 |
| 11 | Run it yourself, or let us host it | 11:45 | 0:45 |
| 12 | Closing | 12:30 | 0:20 |

---

## Chapter 1. Welcome

**Start: 00:00. Target: 0:45.**

**Screens**

- Open on the Board of the demo project "Web shop" (about eight cards across the columns, cards moving). Hold for three seconds before the narration starts.
- Show the Guildwise HQ logo on the sidebar, then the title card: "Guildwise HQ: run an organization of AI agents."

**Narration**

> Welcome to Guildwise H Q. This video is a short tour of the whole product, at a high level. It takes about twelve minutes.
>
> Guildwise H Q lets you run an organization of AI agents. You hire agents into roles, give them work on a board, and keep every decision that matters.
>
> It comes set up for software delivery. You describe what you want, in plain words. A team of agents turns it into a clear specification, builds it on a branch of your code, has another agent review it, and tests it. The same organization can also run other work, like research and scheduled digests, and you can shape its roles and workflows to fit.
>
> You stay in charge. The agents ask you when they need a decision, and they wait for your go-ahead before anything risky.
>
> Let's start with the idea.

---

## Chapter 2. A team of agents, not a chatbot

**Start: 00:45. Target: 1:15.**

**Screens**

- Open the Agents page from the sidebar. Show the list of hired agents, each with a role and a seniority.
- Hover over one agent, then open its details.

**Narration**

> Think of it as hiring a small team. In the default software setup, someone writes the specification. Someone builds. Someone reviews the work and tries to break it. Someone tests it. And an assistant keeps notes and reports to you.
>
> Each member has a role, a level of seniority, and a name. They work on the projects you allow them to work on, and they can only take work from those projects.
>
> They are not guessing in the dark. Every decision the team makes is recorded, so the team does not ask you the same thing twice.
>
> The team is made of AI agents, and the AI behind them is Claude, from Anthropic. You sign in to Claude once on the computer where the agents run.

---

## Chapter 3. Your organization and who does what

**Start: 02:00. Target: 0:50.**

**Screens**

- Open Organization from the sidebar, on the `General` tab, then the `Members` tab. Show the roles in the list.
- Do not show billing.

**Narration**

> Everything lives inside an organization. It holds the people, the projects, the agents, the workstations and the records.
>
> There are four roles. Owners and Admins manage the organization. Members do the work in the projects they were added to. Guests are visitors from another organization, who can work in one shared project.
>
> The platform administrator runs the service. That person can see organizations, but never anyone's work.

---

## Chapter 4. The board: how a card travels

**Start: 02:50. Target: 1:40.**

**Screens**

- Open the Board of the demo project from the sidebar. Show the columns that follow the workflow.
- Click the filter chip `Blocked`, then the chip `Waiting for my approval`.
- Open one card. Show the brief, the thread and the cost.
- Close it, and show `New card` with the fields, then cancel.

**Narration**

> A piece of work is a card. You create one with New card, and you write what you want, in your own words. The default software workflow is what you see here. Research and feed projects use their own, simpler workflows, and you can design your own.
>
> The card then moves across the board by itself. First it is specified: the context, the requirements, and what done looks like. Then a builder works on a branch of your repository. A reviewer reads the change, and sends it back when it is not right.
>
> A tester runs the tests. If a test fails, the problem becomes a bug card, and the original waits for the fix. At the end, the work is finalized the way your project says: committed to a branch, or proposed as a pull request for you to approve. Where the project asks for it, you do a quick check yourself before the card is done.
>
> The filters help you see what needs you. Blocked shows the cards that are stuck. Waiting for my approval shows the cards that need your go-ahead.
>
> Open a card, and you see its brief, the conversation, each run of an agent, and what it cost.

---

## Chapter 5. The Desk: decisions only you can make

**Start: 04:30. Target: 1:00.**

**Screens**

- Open Desk from the sidebar. Show the number next to it.
- Open a question. Type a short answer. Show `Add to ledger as`.
- Show an item with a recommendation and the button `Accept recommendation`.

**Narration**

> The Desk is your inbox of decisions. It holds the questions, the approvals and the go-aheads that only you can give.
>
> When an agent is unsure, it asks you here, and it carries on once you answer. When something is risky, such as merging a large change, it waits for your approval.
>
> Some answers are worth keeping. You can add an answer to the ledger, which is the team's shared memory, as a decision or a standing order. Every agent reads the standing orders at the start of its work.
>
> Many routine items never reach you at all. Your CEO agent handles them first. You will meet the CEO in a moment.

---

## Chapter 6. From an idea to a PRD: Discovery and the Boardroom

**Start: 05:30. Target: 1:45.**

**Screens**

- Open Discovery from the sidebar. Click `New discovery`. Show the title, the starting idea and the choice `How should the analyst work?`. Cancel, or start a session with the mock analyst.
- Show the question card with its quick answers, then the `Draft` panel with the PRD, and the button `Validate against the checklist`.
- Open Boardroom from the sidebar. Show `New boardroom`, the cast of personas, then a debate in progress with the Chair's decision point.
- Show `End session`, then the minutes.

**Narration**

> Sometimes you start with a rough idea, not a card. That is what Discovery is for.
>
> You give the idea a title, and choose how the analyst should work. It can act as a facilitator, as a partner who challenges you, or as someone who ideates for you. The analyst asks questions, and you answer them. The requirements document, the PRD, takes shape in the draft panel as you go.
>
> When you are happy, the checklist checks the document, and you approve it. A business analyst then turns the approved PRD into cards.
>
> For a bigger question, use the Boardroom. Several personas, each with its own point of view, discuss the topic, and a chair keeps the discussion moving. The chair can pause the debate and ask you to decide.
>
> When the debate ends, you get the minutes. You can pull them straight into a PRD.

---

## Chapter 7. Your agents, the CEO and the org chart

**Start: 07:15. Target: 1:15.**

**Screens**

- Open Agents. Click `Hire agent`: show the role, the seniority, the `Runtime` and the project allow-list. Cancel.
- Open CEO from the sidebar, show `Overview` and the daily report setting under `Reporting & alerts`.
- Open Org chart. Show who reports to whom, the teams by department.

**Narration**

> Hiring an agent takes a few choices: its role, its seniority, the runtime it uses, and the projects it may work on. You can pause an agent, resume it, or change its model.
>
> Every organization has one CEO agent, built in. The CEO watches the floor, handles routine items before they reach your Desk, and writes you a daily report. You can talk to the CEO in a chat, and the CEO's activity log lets you undo some of the actions it took.
>
> The org chart shows the whole team. You, your CEO, the business analysts, and the teams by department. Roles and workflows can be customized, too.

---

## Chapter 8. Workstations: your code stays on your machines

**Start: 08:30. Target: 1:15.**

**Screens**

- Open Workstations from the sidebar. Show two workstation cards, one online and one offline.
- Click `Add a workstation`. Show the wizard steps, then cancel.
- Show `Shifts at once` on a workstation card.
- Open Integrations and show the Claude Code tile and a git host tile.

**Narration**

> The agents do their work on a workstation: a computer that you choose. It can be your own PC or Mac, a Linux machine, a Windows machine that runs WSL2, a server you rent, or a GitHub Codespace.
>
> A small program called the runner runs there. It connects out to Guildwise H Q, so no inbound port needs to be open on the workstation. Installing it is a single command that the app gives you.
>
> Your code, your passwords and your files stay on that machine. The Guildwise H Q server only keeps the board, the Desk and the records. It never holds your repository credentials, or your provider keys.
>
> Each agent works in its own sandbox, in its own copy of the repository. On Linux, WSL2 and macOS, the operating system keeps an agent from reading anything outside its work.
>
> The workstation page shows you how many shifts run at once, and whether the machine is healthy.

---

## Chapter 9. Control: approvals, budgets and the audit log

**Start: 09:45. Target: 1:00.**

**Screens**

- Open Costs from the sidebar, with `Last 30 days` selected. Show `Total spend`, then the budget meter.
- Open Organization, then the tab `Audit log`. Show the list.
- Show the approval button in a Desk notification.

**Narration**

> You decide how much the team may spend. Set a monthly budget for a project, or for the whole organization. The costs page shows where the money goes, by day, by project, by agent and by model.
>
> You also decide which steps need your approval. Merging and pushing can always wait for you.
>
> Every change in the organization is written to an audit log, which you can download as a spreadsheet.
>
> And the team has loop protection, so it cannot run away with your money or your patience.

---

## Chapter 10. Releases, environments and integrations

**Start: 10:45. Target: 1:00.**

**Screens**

- Open Environments from the sidebar. Show `Your app` and `Add an environment`.
- Open Releases. Show the queue with `Release` and `Not now`, then `Freeze all releases`.
- Open Integrations. Show the git host tile and the Jira tile.

**Narration**

> When work is ready, it goes out through a release. Releases are queued, so you choose what goes live, and when. You can freeze all releases at once, and lift the freeze when you are ready.
>
> Environments describe where your app runs. Guildwise H Q can deploy your app to your own servers with Docker Compose. Before a deploy, it backs up the database, and if the new version is not healthy, it puts the previous one back.
>
> Your repositories can be on GitHub, GitLab, Azure DevOps or Bitbucket Cloud. Jira is available for tickets. You connect each one once, from the Integrations page.

---

## Chapter 11. Run it yourself, or let us host it

**Start: 11:45. Target: 0:45.**

**Screens**

- Show the project's GitHub repository README, scrolled to the self-host section, for about 10 seconds.
- Show the platform area, `Invitations`, to illustrate inviting the first organization.
- Show the Guildwise Cloud pricing page only if it is live when the video is recorded.

**Narration**

> Guildwise H Q is free and open source, under the Apache 2.0 license. You can run it yourself. You need a server, a domain name and an email relay. The guide walks you through the rest, with the commands.
>
> If you would rather not run a server, Guildwise Cloud hosts it for you. The price is on the pricing page, and support for setup and custom work is quoted separately.

(Checked against `docs/SELF-HOSTING.md`: a server, a domain name and an SMTP relay are what the guide asks for.)

---

## Chapter 12. Closing

**Start: 12:30. Target: 0:20.**

**Screens**

- Return to the Board. Let one card move one column to the right.
- End on the title card: "Guildwise HQ. Free and open source." with the repository address.

**Narration**

> That is Guildwise H Q. An organization of AI agents that you run on your own machines, with you in charge of every decision. It builds, reviews and tests your software out of the box, and it is ready for other work too.
>
> Thank you for watching.

---

## Teaser (45 to 60 seconds)

Used for the README clip, `docs/media/overview-teaser.mp4`. It shows the same product at a faster pace. Target 55 seconds, about 125 words of narration.

| Time | Screen | Narration |
| --- | --- | --- |
| 0:00 to 0:06 | Board, cards moving left to right | "What if your team of AI agents never did anything important without asking you first?" |
| 0:06 to 0:16 | Board, title card "Guildwise HQ" | "This is Guildwise H Q. You describe the work as a card. Out of the box, agents specify it, build it, review it and test it, on your own machines." |
| 0:16 to 0:28 | Desk, a question open, the answer typed | "When an agent needs a decision, it asks you on the Desk. You answer once, and the team carries on." |
| 0:28 to 0:40 | Discovery, the draft panel with a PRD | "Start with a rough idea, and an analyst turns it into a requirements document you approve." |
| 0:40 to 0:50 | Workstations, one card online | "Your code stays on your workstations. The server never holds your keys." |
| 0:50 to 0:55 | Title card with the license and the repository | "Free and open source. Run it yourself, or let us host it." |

**Full teaser narration, read straight through**

> What if your team of AI agents never did anything important without asking you first?
>
> This is Guildwise H Q. You describe the work as a card. Out of the box, agents specify it, build it, review it and test it, on your own machines.
>
> When an agent needs a decision, it asks you on the Desk. You answer once, and the team carries on.
>
> Start with a rough idea, and an analyst turns it into a requirements document you approve.
>
> Your code stays on your workstations. The server never holds your keys.
>
> Free and open source. Run it yourself, or let us host it.

---

## Production notes

- **Length check.** Chapter targets add up to 12 minutes 50 seconds. At about 2.4 words a second (`docs/guide/VIDEO-PLAN.md`), the narration is about 1,450 words, so check the rendered length and trim a chapter rather than speed up the voice.
- **Pipeline.** The existing pipeline in `e2e/video/` records one spec per section video. The overview needs its own spec and narration module, for example `e2e/video/overview.spec.ts` and `e2e/video/narration/overview.ts`, The overview is registered in `apps/web/src/lib/videos.ts` as the overview video, recorded with the Kokoro `af_heart` voice like the others.
- **Pacing.** Pause the narration for on-screen actions. Do not cut a sentence to fit a chapter target.
- **Labels.** Every label in `code` style must match `apps/web/src` on the day of recording.
- **Discovery and the Boardroom.** Discovery and the Boardroom are released features (live in production), so chapter 6 shows them as normal pages.
- **Documents.** Chapter 6 mentions documents only in passing. Add a screen if the PRD approval is shown.
- **Chapter 11 and the claim of time.** Do not promise a specific self-host time in the video until it is measured.
