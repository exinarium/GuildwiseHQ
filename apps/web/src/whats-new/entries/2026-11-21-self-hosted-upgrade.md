---
title: Upgrading a self-hosted server to 1.10.0
date: 2026-11-21
audience: superadmin
help: /help/open-source-and-self-hosting#upgrade-1-10
release: 1.10.0
---
1.10.0 is a breaking change for self-hosted servers, but with the defaults nobody is locked out: runners keep working and update themselves, and two-factor logins keep working (existing seeds are re-sealed at first boot). Run `guildwise-runner setup` once on each workstation after its runner updated. Removed: `/api/admin/workstations`, your two-factor reset of other users, choosing the platform team in the app (set `AOM_PLATFORM_TEAM_ORG_ID` and `AOM_PLATFORM_TEAM_PROJECT_ID`), and the database-connected remote render worker. To opt in, turn on **Require two-factor login**, or sign your runners with your own key and turn on **Only signed runners**. The full list is in docs/SELF-HOSTING.md, "Upgrading to 1.10.0".
