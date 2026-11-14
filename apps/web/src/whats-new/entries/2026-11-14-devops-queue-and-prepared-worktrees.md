---
title: Faster DevOps queue, prepared worktrees
date: 2026-11-14
audience: admin
help: /help/devops-and-hygiene#devops-queue
release: 1.7.0
---
DevOps requests that a parked card or a working agent is waiting on go first, and a second DevOps shift opens behind a long run, so a short setup request no longer waits behind a 10-minute shift. A parked card says where its request stands in the queue. The runner also installs a project's dependencies in a new card worktree before the agent starts. Submodules are not prepared; the agent asks DevOps for them.
