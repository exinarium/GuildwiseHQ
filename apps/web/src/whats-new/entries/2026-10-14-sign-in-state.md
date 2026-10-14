---
title: Sign-in problems on a workstation are shown, and work waits
date: 2026-10-14
audience: owner
help: /help/agents#external-tools
---
When the Claude login on a workstation expires, its agents now pause instead of failing card after card: the card goes back to the queue without penalty, you get a notice and an e-mail saying to run `claude` and `/login` on that machine, and work resumes by itself once it works. Plugin tools (such as Atlassian) that are not signed in are shown as **Needs sign-in** on the Workstations page and in the project's MCP servers, with the exact steps.
