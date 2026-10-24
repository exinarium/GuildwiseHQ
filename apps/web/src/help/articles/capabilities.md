---
title: Capabilities and packs
summary: The skills, personas and playbooks agents can use, and how to add and approve a pack from git.
keywords: [capabilities, registry, pack, bmad, skill, persona, playbook, trust, approve, scripts, project skills, review, block]
order: 27
---

Owners and Admins use **Capabilities**.

## The registry {#registry}

It lists every skill, persona and playbook and where it comes from: built in, your vault, a project or a pack. Pick a role's skills on Roles and workflows.

## Packs {#packs}

Add a pack by git URL and tag, or click **Add BMAD Method**. It starts untrusted: nothing of it is used. **Review and approve** shows its files, scripts flagged, and approves that exact commit. Scripts stay off unless you enable them, and only run in the sandbox. Pack text reaches agents as outside content. **Check for updates** fetches now and shows a diff to accept. A pack added to one project applies in that project's sessions.

## Project skills {#project-skills}

**Project skills** lists the skills and personas found in project repositories (repository, path, hash). Mark one **reviewed** or **block** it; a blocked one cannot be used, and a changed file needs a new review.
