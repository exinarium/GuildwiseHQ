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

1. Open the **Roles** tab and click **New custom role**, or use **Design with the BA** to describe what you need and let the BA draft it for you.
2. Fill in:
   - **Key**, **Name**, **Department** and **Purpose**: what they do.
   - **Instructions** and **Core rules**: behaviour and guardrails.
   - **Seniority levels**, **Default runtime**, **Default model** and **Effort**.
   - **Tools** (read, edit, shell, web), **Denied shell patterns** and **Skills**.
   - **May claim**: which workflow stages the role can take (`workflow.stage`, or `*` for any).
3. Click **Save and submit for approval** (or **Save draft** to keep working). The definition is validated and lands on your desk.
4. Approve it on the desk. It then appears in the **Hire agent** form.

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

### A project's own steps in a built-in workflow {#variants}

You cannot edit the built-in Code workflow, but one project can have its own version of it with extra steps: in the project's settings, **Workflows**, click **Customise** and use **Insert step after ...** to add a step after any existing one. The base steps stay as they are. The new version goes to your desk for approval; running cards keep the version they started on, and a newer version of the base workflow can be applied with **Rebase**. In a design chat you can ask the BA to draft it (`aom org workflow variant`).

## Departments {#departments}

A department groups the roles and workflows of one function (the built-in ones are Delivery and Research; you can add your own, such as Support or Marketing), so the Agents and Projects pages can be filtered by department. Departments are optional.

Open the **Departments** tab to create one (**New department**).
