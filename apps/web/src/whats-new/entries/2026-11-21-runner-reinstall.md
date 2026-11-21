---
title: Reinstall your runner when Guildwise asks
date: 2026-11-21
audience: all
help: /help/workstations-and-installer#reinstall
release: 1.10.0
---
Where **Only signed runners** is on (always on Guildwise Cloud), runners from before 1.10.0 are refused and a workstation shows **Reinstall required**. Open **Workstations > Add a workstation** and run the installer on that machine: it stops the old runner and quarantines its files, so remove nothing by hand and never reuse those files. If you gave the old runner sudo, change your computer password. On a server with the setting off, nothing is needed: your runner updates itself.
