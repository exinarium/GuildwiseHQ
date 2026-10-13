---
title: Nothing of ours in your repositories
date: 2026-10-13
audience: all
help: /help/devops-and-hygiene
---
Unsaved edits that hygiene protects now go into a plain **git stash** on your machine, never to a branch or to the git host. Pull requests go out as **`<prefix>/<ticket>`** (for example `pieter/DCPL-4276`; set the prefix under Project settings, default `feature`), and merges the runner makes use your own git name.
