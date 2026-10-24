---
title: Capabilities and packs
summary: The skills, personas and playbooks agents can use, how to add and approve a pack, write your own, and hire or chat with a persona.
keywords: [capabilities, registry, pack, bmad, skill, persona, playbook, trust, approve, scripts, project skills, review, block, editor, private, deploy key, token, hire, chat]
order: 27
---

Everyone uses **Capabilities** for the registry and **My capabilities**; Owners and Admins also manage packs.

## The registry {#registry}

It lists every skill, persona and playbook and where it comes from: built in, your vault, a project or a pack. Pick a role's skills on Roles and workflows.

## Packs {#packs}

Add a pack by git URL and tag, or click **Add BMAD Method**. It starts untrusted: nothing of it is used. **Review and approve** shows its files, scripts flagged, and approves that exact commit. Scripts stay off unless you enable them, and only run in the sandbox. Pack text reaches agents as outside content. **Check for updates** fetches now and shows a diff to accept. A pack added to one project applies in that project's sessions.

## Project skills {#project-skills}

**Project skills** lists the skills and personas found in project repositories (repository, path, hash). Mark one **reviewed** or **block** it; a blocked one cannot be used, and a changed file needs a new review.

## My capabilities {#mine}

Write skills, personas and playbooks in the editor; the page checks them as you type. Each pack you write is stored on your workstation in the standard pack layout, so **Export as zip** gives a folder you can push to git unchanged. **Private** packs stay on that workstation: only you see them and the server never gets their text. **Organization** packs are reviewed by an Owner or Admin first (an Owner or Admin can approve their own save) and then reach the workstations chosen for the pack.

## Private repositories and workstations {#private}

For a private git repository add a deploy key (ssh) or token (https). Your browser encrypts it for each workstation you choose, which stores it for that pack only. A member's workstation asks its owner first (a request on their desk) and clones only after they accept.

## Hire from a pack {#hire}

On an approved pack, **Hire from this pack** turns a persona into an agent tagged like *BMAD · analyst · v6.12.4*. It gets read access unless the persona asks for more and you may grant it. **Add all agents** hires every persona. If the pack changes a persona you get a new version to review, never applied by itself. An agent whose pack lost its approval keeps working and shows a warning.

## Chat with a persona {#chat-with-a-persona}

**Chat** on a persona opens a one-to-one chat on your own workstation. It only reads, and its cost is tracked. A private persona is only yours.

## Playbooks and the / menu {#playbooks}

Type **/** in any chat or session message box (or click the **/** button) to list the playbooks and skills you may use; typing searches names and descriptions. Private packs show only to you, and a pack that is not approved shows to no one.

A skill adds an instruction to your message. A playbook either runs **in this chat** (the agent follows its steps with you) or **as a new session**, a guided Discovery session with question cards, the panel and drafts.

An agent starts a playbook itself only when allowed: open **Playbooks it may start** on the agent's card (Owners, Admins and the agent's manager). It is empty by default, and the session it opens belongs to the manager, who gets a notice on the Desk.
