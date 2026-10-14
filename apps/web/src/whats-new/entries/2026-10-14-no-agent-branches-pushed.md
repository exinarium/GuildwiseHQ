---
title: Agent branches stay off your git host
date: 2026-10-14
audience: owner
---
A card's work branch is now pushed to your git host only when the work goes out as a pull request, and then under your branch prefix (for example `pieter/DCPL-4276`). Agents can no longer push a branch themselves, and the "push the card branch only" completion action is gone: open cards that had it now follow the project's setting.
