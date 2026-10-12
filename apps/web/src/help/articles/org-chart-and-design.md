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

Built-in roles (builder, reviewer, tester, technical writer) cover most work, but you can create custom ones.

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
