---
title: Capabilities and packs
summary: The skills, personas and playbooks agents can use, how to add and approve a pack, write your own, and hire or chat with a persona.
keywords: [capabilities, registry, pack, git, skill, persona, playbook, trust, approve, scripts, project skills, review, block, editor, private, deploy key, token, hire, chat]
order: 27
---

Everyone uses **Capabilities** for the registry and **My capabilities**; Owners and Admins also manage packs.

## The registry {#registry}

It lists every skill, persona and playbook and where it comes from: built in, your vault, a project or a pack. Pick a role's skills on Roles and workflows.

## Packs {#packs}

Add a pack by git URL and tag (any repository of skills in the Agent Skills format, folders with a SKILL.md, works). It starts untrusted: nothing of it is used. **Review and approve** shows its files, scripts flagged, and approves that exact commit. Scripts stay off unless you enable them, and only run in the sandbox. Pack text reaches agents as outside content. **Check for updates** fetches now and shows a diff to accept. A pack added to one project applies in that project's sessions.

## Scopes a pack needs {#scopes}

A pack can say what it needs: `scopes:` in its `pack.yaml` (for the whole pack or one skill, persona or playbook), `metadata.scopes` in a `SKILL.md`, or `scopes:` in a persona's or playbook's frontmatter. Known scopes are `read`, `edit`, `shell`, `web`, `mcp`, `commit`, `browser`, `org-repos`, `scripts` and `delegate`. Reviewers see them on the pack, and granting a playbook, a delegate persona or a private pack to an agent that lacks one shows what is missing and asks you to confirm (**Grant anyway**). A scope the manifest adds changes the pack, so it is reviewed again.

## Project skills {#project-skills}

**Project skills** lists the skills and personas found in project repositories (repository, path, hash). Nothing found there is used until an Owner or Admin has read it and marked it **reviewed**; a file that changes needs a new review. You also get a notice on your desk when something waits. **Block** one to keep it out for good.

## My capabilities {#mine}

Write skills, personas and playbooks in the editor; the page checks them as you type. Each pack you write is stored on your workstation in the standard pack layout, so **Export as zip** gives a folder you can push to git unchanged. **Private** packs stay on that workstation: only you see them and the server never gets their text. **Organization** packs are reviewed by an Owner or Admin first (an Owner or Admin can approve their own save) and then reach the workstations chosen for the pack.

## Private repositories and workstations {#private}

For a private git repository add a deploy key (ssh) or token (https). Your browser encrypts it for each workstation you choose, which stores it for that pack only. A member's workstation asks its owner first (a request on their desk) and clones only after they accept.

## Hire from a pack {#hire}

Members can hire too, for projects they are on and on their own workstation. Owners and Admins can also **read the text** of an organization pack before approving it, with a diff against the version approved before (the text is encrypted for your browser only).

On an approved pack, **Hire from this pack** turns a persona into an agent tagged like *ACME · analyst · v1.2.0*. It gets read access unless the persona asks for more and you may grant it. **Add all agents** hires every persona. If the pack changes a persona you get a new version to review, never applied by itself. An agent whose pack lost its approval keeps working and shows a warning.

## Chat with a persona {#chat-with-a-persona}

**Chat** on a persona opens a one-to-one chat on your own workstation. It only reads, and its cost is tracked. You can set a cost limit and a time limit for the chat; chats are deleted after 90 days. A private persona is only yours.

## Playbooks and the / menu {#playbooks}

Type **/** in a chat or session box to list the playbooks and skills you may use (private packs only to you). Text after the command (`/brainstorm pricing for teams`) is the input of the playbook. A skill adds an instruction; a playbook runs in the chat, step by step, or as a new guided session. An agent starts one only if allowed under **Playbooks it may start** on its card (empty by default).
