---
title: Your workstation asks before privileged steps
date: 2026-11-21
audience: all
help: /help/workstations-and-installer#approvals
release: 1.10.0
---
New deploy scripts, recipe changes, sudo, DevOps tasks and other privileged steps now wait for a yes on the workstation itself (`guildwise-runner approve`), so nobody can run commands on your machine from the server. The installer sets up what the runner may do when you install it. A redeploy at a new commit and a recipe change can also be approved in the browser with a passkey the workstation trusts, on the workstation's **Approvals** page.
