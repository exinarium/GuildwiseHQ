---
title: Faster builds for agents, and .NET works in the sandbox
date: 2026-10-13
audience: all
help: /help/workstations-and-installer#shared-caches
---
Agents on the same workstation now share one set of package caches (NuGet, npm, pnpm, pip, Gradle, Maven, Go), so a package is downloaded once instead of once per agent and shift, and packages you already restored on that computer are reused straight away. .NET projects can now build and run their tests inside the sandbox; before, `dotnet build` failed there and agents had to ask the DevOps engineer to build for them. Reviewers can also run commands again on a read-only worktree. Projects that need different .NET versions work side by side: the workstation picks the .NET install that has every SDK, and the Workstations page shows it, with the other tools agents can use, under **Agent toolchains**. If a tool is missing, ask the DevOps engineer: it installs the tool and registers it for the agents. This needs the next runner update.
