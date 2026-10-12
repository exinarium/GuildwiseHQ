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

The built-in workflows (Code: Spec, Build, Review, Test, Docs, Finalize; Research: Question, Research, Fact check, Publish) cover standard work. To add a custom workflow:

1. Open the **Workflows** tab and click **New custom workflow** (or use **Design with the BA**).
2. Define the **stages**: name, which role claims it, required fields, success criteria, and where the card goes on success and on failure.
3. Validation checks that there are no unreachable stages, failure paths end somewhere and every stage has a claimable role.
4. Click **Save and submit for approval**, then approve it on the desk.

Once approved, a custom workflow can be picked as the workflow of a new project on the Projects page, or enabled next to a project's own workflow in the project's settings under **Workflows** (see [Workflows of a project](/help/projects#workflows)).

### A project's own steps in a built-in workflow {#variants}

You cannot edit the built-in Code workflow, but one project can have its own version of it with extra steps: in the project's settings, **Workflows**, click **Customise** and use **Insert step after ...** to add a step after any existing one. The base steps stay as they are. The new version goes to your desk for approval; running cards keep the version they started on, and a newer version of the base workflow can be applied with **Rebase**. In a design chat you can ask the BA to draft it (`aom org workflow variant`).

## Departments {#departments}

A department groups the roles and workflows of one function (the built-in ones are Delivery and Research; you can add your own, such as Support or Marketing), so the Agents and Projects pages can be filtered by department. Departments are optional.

Open the **Departments** tab to create one (**New department**).
