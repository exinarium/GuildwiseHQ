---
title: Runner auto-update with rollback
date: 2026-10-12
audience: owner
help: /help/workstations-and-installer#runner-updates
---
The runner now updates itself once a day, downloads and verifies the new version, then waits until agents finish before restarting. If the new version fails to connect, it rolls back automatically within a few minutes. Platform administrators can pause updates; set `AOM_RUNNER_AUTO_UPDATE=0` to opt out on one machine.
