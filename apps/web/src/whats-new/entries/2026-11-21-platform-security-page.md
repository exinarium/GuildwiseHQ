---
title: Platform security page and settings
date: 2026-11-21
audience: superadmin
help: /help/account-security#security-page
release: 1.10.0
---
**Platform > Security** shows failed sign-ins and the locks in force, every sign-in, a block list for domains, addresses and IPs, and two **Security settings**: **Only signed runners** and **Require two-factor login**. Both are off by default on a self-hosted server; Guildwise Cloud locks both on. Every platform change now asks you to confirm it's you, platform sessions end after 8 hours (30 minutes idle), and the platform account no longer reaches into organizations' projects, workstations or secrets, nor resets other users' two-factor login. On Guildwise Cloud, **Platform > Sign-ups** shows the sign-ups of the last 24 hours and an optional daily cap.
