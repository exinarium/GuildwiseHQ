---
title: Support for more Linux package managers
date: 2026-10-12
audience: owner
help: /help/devops-and-hygiene#setup
---
The DevOps engineer can now detect and use apt, dnf, yum, pacman, zypper, and apk on Linux, plus Homebrew on Linux and macOS, to install tools your projects need. The workstation tells you which managers it found, and installation skips systems where no manager is available (installers like `dotnet-install` and `rustup` still work without them).
