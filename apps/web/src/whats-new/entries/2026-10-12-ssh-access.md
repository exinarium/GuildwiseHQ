---
title: SSH instead of API tokens
date: 2026-10-12
audience: all
help: /help/workstations-and-installer#git-hosts
---
Prefer SSH keys over API tokens? On the Workstations page, click **SSH** on a git host to create a key (or point to one you already have), add the public key on the host and check that it works. You can make SSH the default for the workstation and override it per repository under **Access**. Pull requests and branch rules still need the token or CLI login; with SSH only, the branch is pushed and the manager opens the pull request.
