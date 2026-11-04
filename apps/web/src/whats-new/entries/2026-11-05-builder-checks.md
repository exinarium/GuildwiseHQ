---
title: Builders run your project's checks before review
date: 2026-11-05
audience: all
help: /help/board-and-cards#checks
release: 1.5.0
---
When a builder hands a card over, the runner first runs the checks you confirmed for the project (lint, format, typecheck). A change that fails in a file it touched goes back to the builder with the failing lines, so it does not reach review broken. Guildwise proposes the checks from your repository; confirm them on the project's **Environments** page under **Test copies > Tests and settings**.
