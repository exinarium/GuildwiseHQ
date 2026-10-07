---
title: Converting a project
summary: Converting from research to code or another workflow, what is kept, and the conversion process.
keywords: [convert, project, research, workflow, stage]
order: 20
---

When a research project has answered its questions and is ready to build, you convert it to a Code project or any other workflow. The project's history and research notes stay; agents move to a new workflow with new stages.

## Converting {#converting}

Only the organization's Owner and Admins can convert. To convert a project:

1. Open the project's settings (the gear on its board) and go to **Stage**, or click **Convert to project** on the board of a research project.
2. Click **Convert project** (**Convert to project** on a research project).
3. The dialog has up to four short steps (the repositories step only appears when the target workflow works in repositories).

## What is kept {#what-is-kept}

When you convert:

- **Cards, history and the vault folder**: all untouched. Research cards that are kept finish on their own workflow and show in extra board columns until done.
- **Published research notes**: listed in `PROJECT.md` of the project's vault folder (a managed `research-index` section). Every agent working the project reads them.
- **The record that it started as research**: shown on the Stage panel.

## Research as a stage {#research-as-a-stage}

**Step 1: Workflow.** Pick the target: Code (the usual next step from research), or any custom workflow of your organization. Any workflow can convert to any other, including back to research.

**Step 2: Repositories.** If the target workflow works in repositories (Code does; Research does not), add at least one. You can add an existing repository (name, URL, optionally a branch) or request a new GitHub repository. The request lands on your desk as **Create repository `<owner/repo>`**, exactly like asking the BA or DevOps. Your runner creates it when you approve.

If the new repository is the only one, the project stays as is until it exists, then converts by itself. The Stage panel shows the waiting request and a **Cancel the conversion** button (declining the request cancels it).

**Step 3: Open cards.** Cards that run on another workflow than the target (e.g., open research cards when converting to Code) are listed. For each one, choose **Keep** (finishes on its own workflow in extra columns) or **Cancel** (closed with the reason "Project converted"; a running shift stops). Draft cards stay drafts if kept.

**Step 4: Hand-over.** An optional note is stored with the conversion for your agents to read.

Once you approve, the project converts and takes its new workflow. Each repository you added is added when ready, and converting triggers a `project_converted` schedule if you have one.

Deploy and regression follow-ups of a phase need a repository (and regression needs a test stage). They are greyed out until the project has them.

The DevOps engineer then asks you which branch is the working branch (like for a new intake or phase).
