---
title: Organization chart and design
summary: The org chart, custom roles, custom workflows and departments.
keywords: [org chart, organization, role, workflow, design, department, escalation]
order: 17
---

The **org chart** shows your team structure: who works for you, who is a senior versus a junior, and how questions escalate. **Custom roles** and **workflows** let you extend beyond the built-in types. **Departments** group roles by function.

## Org chart {#org-chart}

Go to **Organization > Org chart** to see:

- The **manager** (you, the Owner, with Admins) at the top.
- Below, the **business analysts**.
- Below them, **departments** (Delivery, Research, and custom ones) as boxes, with seniors on the upper row and juniors below.

The lines show **escalation**: a junior's question goes to a senior of the same role, then to the BA, then to your desk. A junior with no senior goes straight to the BA.

Each agent's tile shows: face, name, role, seniority, status (working, blocked, idle, offline), and workstation. Click an agent to see its projects, cost, recent work and who it escalates to.

Pick a project in **Allowed on project** to see who may work it (agents allowed on any project always show). Click **List** for a grouped list view (the default on phones).

The **DevOps engineer** of each workstation is shown separately below, reporting to your desk (not to the BA).

## Custom roles {#custom-roles}

Built-in roles (builder, reviewer, tester, technical writer) cover most work, but you can create custom ones.

To design a custom role:

1. Go to **Organization > Roles**.
2. Click **Design** (or chat with the BA in Intake).
3. Define:
   - **Name and purpose**: what they do.
   - **Instructions**: behavior, guardrails, allowed tools.
   - **Permissions**: which repos, branches, tools (read-only, write, run, etc.).
   - **Skills**: special knowledge.
   - **Model**: default provider and model.
   - **Stages**: which workflow stages they can claim.
4. The BA validates it and submits to the desk.
5. You approve on the desk, then hire the role.

Built-in roles cannot be removed. You can extend them with extra instructions (Owner only).

## Custom workflows {#custom-workflows}

The built-in workflows (Code: Spec, Build, Review, Test, Finalize; Research: Question, Research, Fact check, Publish) cover standard work. To add a custom workflow:

1. Go to **Organization > Workflows**.
2. Click **Design** (or chat with the BA).
3. Define:
   - **Stages**: name, which role claims it, required fields, success criteria, failure routing.
   - **Paths**: where cards go on success versus failure.
4. Validate: no unreachable stages, failure paths terminate, every stage has a claimable role.
5. Submit to the desk for approval.

Once approved, custom workflows appear as project types on the Projects page.

## Departments {#departments}

Group roles by function (Engineering, Support, Research, Marketing) to filter the HR board and board by department. Departments are optional.

Go to **Organization > Departments** to create and manage them.
