---
title: Chat with agents
summary: Starting a chat with an agent, threads, asking the BA and archiving chats.
keywords: [chat, agent, BA, thread, conversation, discuss, devops, ask devops, run commands, deploy]
order: 21
---

You can chat with any agent you are allowed to direct, to ask questions, offer suggestions or discuss blockers and decisions. Chat is saved as a thread.

## Starting a chat {#starting-a-chat}

1. Click **Chat** in the top bar (or **Chat** on the Desk page, or choose **Chat with an agent** in the command palette).
2. Pick an agent you may talk to (the BA, a DevOps engineer, builders and so on) and click **Start chat**.
3. Type your message. Replies stream in while the agent's workstation is connected; if it is offline, the chat says so and nothing is queued.

While a project is selected, the chat is tied to that project. Earlier conversations are listed under the picker, so you can pick one up again.

## Threads {#threads}

Each chat is a thread. You can ask questions, offer suggestions and discuss blockers or decisions. Threads are saved. A thread that is linked to a card also shows in that card's history.

A chat that belongs to a project is marked "visible to this project's managers": other managers of that project can read it and join in.

Rights are checked on every message: if you are removed from the project, you can no longer chat with its agents through an old thread.

**Note**: agents may write notes and drafts in their own scratch folder during a chat. They cannot change your repositories, the vault or their own configuration from a chat. They can read the knowledge vault: see [Which vault an agent reads](/help/ledger-and-vaults#agents-and-vaults).

## What the agent can read {#what-it-can-read}

In a chat about a project, the agent can **read** (never change) the project's own repositories when they are cloned on its workstation, plus the project's **reference repositories**. In a chat about a card, it reads the card's work folder if that is on the workstation, plus the reference repositories; if the card has not been started there, it reads the project's repositories instead. Secret files such as `.env` files and keys stay blocked, and so does everything else on the machine.

To let agents compare or look at another repository, the project owner adds it under **Reference repositories** in the project settings (see [Projects](/help/projects#reference-repos)).

**The DevOps engineer is different.** A chat with the DevOps engineer works on your machine as you: when you ask it to install something, build a Docker image or deploy, it does it. It can also turn a longer instruction into a tracked DevOps task. The quickest way in is **Ask DevOps** in the top bar, which attaches the page you are on. See [DevOps and repository hygiene](/help/devops-and-hygiene#devops-engineer).

## Asking the BA {#asking-the-ba}

Start a chat with the BA the same way. Ask the BA to:

- Create cards: "create a card for the login form".
- Specify cards from tickets: "what should we do about this issue?".
- Run a task: "check our logs for errors".
- Answer a question: "should we use Postgres or MongoDB?".

The BA works with your rights: it can only use projects you are a member of. It reads the ledger, desk, vault and repositories (never changes anything), and posts one report on your desk with the conversation linked.

Other agents cannot create cards from chat; only the BA can. For a ticket from Jira or GitHub, an [intake](/help/intake-and-outbox#intake) does the same with the ticket attached.

## Archiving chats {#archiving-chats}

Click the menu on a thread and choose **Close chat** to tidy it away. Closed chats move to the **Archived** view of the chat list, and **Restore to the list** brings one back. **Delete chat** removes a conversation for good, but a chat linked to a card cannot be deleted: it stays in the card's history.
