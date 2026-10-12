---
title: Organization chart and design
summary: The org chart, custom roles, custom workflows and departments.
keywords: [org chart, organization, role, workflow, design, department, escalation]
order: 17
---

The **org chart** shows your team structure: who works for you, who is a senior versus a junior, and how questions escalate. **Custom roles** and **workflows** let you extend beyond the built-in types. **Departments** group roles by function.

## Org chart {#org-chart}

Go to **Org chart** in the sidebar (Organization section) to see:

- The **manager** (you, the Owner, with Admins) at the top.
- Below, the **business analysts**.
- Below them, **departments** (Delivery, Research, and custom ones) as boxes, with seniors on the upper row and juniors below.

The lines show **escalation**: a junior's question goes to a senior of the same role, then to the BA, then to your desk. A junior with no senior goes straight to the BA.

Each agent's tile shows: face, name, role, seniority, status (working, blocked, idle, offline), and workstation. Click an agent to see its projects, cost, recent work and who it escalates to.

Pick a project in **Allowed on project** to see who may work it (agents allowed on any project always show). Switch **View** to **List** for a grouped list view (the default on phones).

The **DevOps engineer** of each workstation is shown separately below, reporting to your desk (not to the BA).

## Custom roles {#custom-roles}

Built-in roles (builder, reviewer, tester, technical writer, and the architect that investigates and designs before build) cover most work, but you can create custom ones.

Custom roles and workflows are designed on the **Roles & workflows** page (sidebar, Organization section; the page itself is titled Organization). It has the tabs **Roles**, **Workflows**, **Departments** and **Design with the BA**. Only the Owner and Admins can change things here.

To make a custom role:

1. Open the **Roles** tab and click **New custom role**. You can also use **Design with the BA** (or **Ask the BA to help** at the top of the form) to describe what you need and let the BA draft it; the form is the way to check and fine-tune the result.
2. Work through the sections of the form:
   - **Basics**: **Name**, **Short name (key)** (filled in from the name; it cannot change after the first save), **Department** and **Purpose**.
   - **How it works**: the **Instructions** (like a briefing for a new colleague) and the **Rules that always apply** (core rules, one per line; you cannot override them later).
   - **What it may do**: plain-language switches, each with a risk badge and a note: read files (always on), change files, run commands, search the web, save its work (commit), run browsers and read all organization repositories. Below them you can limit the role to some folders and list external (MCP) tools. A summary spells out what the role can and cannot do. Pushing, rebasing and switching branches are blocked for every role.
   - **Model**: the runtime, the model (cheaper and faster, or stronger and costlier) and the effort.
   - **Seniority**: which levels you can hire, and the **skills** it has. Skills other roles already use are offered as quick picks.
   - **Steps it can take**: a checklist of the steps of your custom workflows. Tick the steps (or **Any step of** a workflow). A workflow that is still a draft can be ticked too, so you can make a role and its workflow together.
   - **Preview what the agent is told**: shows the instructions file an agent with this role would get, using a sample card and, if you like, one of the ticked steps. Nothing runs and it costs nothing. Use it to check your instructions read the way you meant.
3. Problems are explained in plain words next to the section they belong to, and the bar at the top says how many things are left to fix. **Advanced: all fields** shows every field, including the denied shell patterns.
4. Click **Save and submit for approval** (or **Save draft** to keep working). The definition lands on your desk.
5. Approve it on the desk. It then appears in the **Hire agent** form. Changing an approved role makes a new version; agents keep the version they were hired on until you move them.

Owners and Admins can design and submit roles. **Read all organization repositories** is the exception: it lets the role read the code of every project on the workstation (read only), so only the **Owner** can switch it on and approve it. For an Admin the switch is greyed out and says why.

Built-in roles cannot be changed or removed. Use **Extend** on a built-in role to add extra instructions, skills and standing orders; its core rules stay. The DevOps engineer cannot be extended.

## Custom workflows {#custom-workflows}

The built-in workflows (Code: Spec, Build, Review, Test, Docs, Finalize; Research: Question, Research, Fact check, Publish) cover standard work. To add a custom workflow, use the **workflow builder**: open the **Workflows** tab and click **New custom workflow** (or use **Design with the BA**). The BA can also draft one, and you open and finish its draft in the same builder.

### The workflow builder {#workflow-builder}

1. **Pick a starting point.** The gallery offers a few templates (Blank, Simple review, Request, do, check, Content, Support reply). You can also **copy a built-in workflow** (Code or Research). A copy is an ordinary custom workflow: the special behaviour of the built-in one, such as tests that open bug cards or research that gets published, does not carry over, and the builder lists what was left out. To extend Code and keep its behaviour, add steps to it in a project's settings instead.
2. **Fill in the steps.** A workflow is a list of steps a card goes through. For each step you set:
   - **Step name**, and **What to do, and what "done" looks like**.
   - **Who does it**: pick a role. The role must list the step among the steps it may take (see [Custom roles](#custom-roles)); the builder tells you when it does not, and when no agent with that role is hired yet.
   - **Must be filled in before this step**: pieces of card information the step needs.
   - **When finished, go to** the next step; **If it is not good enough, send back to** an earlier step (optional); **Only when** a yes-or-no piece of card information says so (otherwise the step is skipped for that card).
   - Use **Add a step after**, **Move up**, **Move down** and **Remove** to shape the list.
3. **Say what the card carries** under **Information the card carries**: name, kind (short text, long text, list, number, yes or no, links) and whether it must be filled in.
4. **Watch the diagram and the problems.** The diagram on the right redraws as you type; red dashed arrows send a card back. The **things to fix** box lists every problem in plain words and jumps to the step; each step shows its own problems. Problems stop you sending the workflow for approval; tips do not.
5. **Try a card.** The preview walks a card through the steps with the answers you tick, shows who works each step, and lets you choose "sent back" where a step can send work back. The path is also marked on the diagram.
6. **Ask the BA.** The chat beside the builder sends the BA an outline of your current draft so you can talk it through. It never changes the draft for you.
7. **Save draft** keeps your work; **Save and send for approval** puts it on your desk. Owners and Admins approve it there.

**Versions.** Every save creates a draft of the next version. **Versions** at the bottom of the builder lists them, and **Compare with previous** shows what changed step by step. Once a version is approved, the steps in it keep their internal names for good: renaming a step never breaks the roles and running cards that refer to it. Running cards finish on the version they started on. To change an approved workflow, choose **Edit as new version**.

The page also keeps the original table editor, under **Advanced: table editor**. It shows the internal ids, events and every route; it opens by itself when a workflow has parts the step list shows only in part. It works for anyone comfortable with that level of detail.

The builder works with the keyboard alone (every action is a button or a field, steps are reordered with buttons) and on a phone.

Once approved, a custom workflow can be picked as the workflow of a new project on the Projects page, or enabled next to a project's own workflow in the project's settings under **Workflows** (see [Workflows of a project](/help/projects#workflows)).

### A step that starts another workflow {#sub-workflows}

A step of a custom workflow does not have to be worked by an agent: it can **start a card in another workflow** (a sub-workflow). Use it when part of the job is a flow of its own, for example "Translate" or "Legal review", that other cards use too. In the workflow builder choose **Start another workflow** as the kind of a step (or ask the BA in a design chat to draft it). The step says:

- **Which workflow** to start, in the **same project** or in **another project of your organization**. The other workflow must be approved and enabled in that project, and the owner of the card must be a member of both projects.
- **What to pass on**: which fields of this card fill which fields of the new card (a field, a fixed value, or a text with placeholders such as `{card.title}`), and whether the new card starts **queued** or as a **draft**. Without a choice it starts queued when everything it needs is filled in, otherwise as a draft.
- **Wait or carry on.** *Wait*: this card is **waiting** until the new card finishes, then takes the step's **done** route (and the fields you chose are copied back), or its **failed** route when the new card is cancelled (or carries on as done, if you chose that). *Carry on*: this card moves on at once and the new card runs alongside.

In the builder you pick the workflow and the project from lists (only approved workflows, and only your own projects where the workflow is switched on), optionally the kind of card, how the new card starts (the hint says what *automatically* will do), and add rows under **Information to pass to the new card**. A row fills one field of the new card from a field of this card, a fixed value, or text with placeholders. **Information to bring back** only appears while the step waits. Under **If the new card is cancelled** you choose whether the step fails, and where the card goes then, or carries on as if it finished. Where the card goes when the new card finishes is the step's usual **When finished, go to**. Problems appear in plain words on the step, and **Try a card** shows the step as "Starts Translate and waits for it". A project's own steps added to a built-in workflow cannot start workflows.

The server runs these steps itself; no agent ever picks one up. While a card waits, its tile on the board says what it waits for and where that card is now, and the card's page has a **Sub-workflows** panel. The new card says "Started by" the card that made it.

**Cancelling a waiting card.** By default only that card is cancelled and the new card keeps running. When the card waits for a new card you may cancel too, the cancel window has a box **Also cancel the card it is waiting for**; ticking it cancels the new card as well, with the reason "Cancelled together with" the first card. The box does not appear when you are not allowed to cancel the new card (for example it sits in a project you are not a member of).

**Moving a card back by hand.** If a manager moves a card back into a step whose earlier new card is still running, the card waits for that same card again instead of starting a second one, and a note on the card says so.

Limits and checks: sub-workflows can be nested **three levels** deep, a workflow can never (directly or through others) start itself, and both are checked when you save the workflow. If a step cannot start its card (nested too deep, the workflow is not enabled in that project, you are not a member of it, a field no longer exists), the card turns **Blocked** and a notice lands on your desk saying why; fix it, then acknowledge the notice and the step is tried again.

### A project's own steps in a built-in workflow {#variants}

You cannot edit the built-in Code workflow, but one project can have its own version of it with extra steps: in the project's settings, **Workflows**, click **Customise** and use **Insert step after ...** to add a step after any existing one. The base steps stay as they are. The new version goes to your desk for approval; running cards keep the version they started on, and a newer version of the base workflow can be applied with **Rebase**. In a design chat you can ask the BA to draft it (`aom org workflow variant`).

## Departments {#departments}

A department groups the roles and workflows of one function (the built-in ones are Delivery and Research; you can add your own, such as Support or Marketing), so the Agents and Projects pages can be filtered by department. Departments are optional.

Open the **Departments** tab to create one (**New department**).
