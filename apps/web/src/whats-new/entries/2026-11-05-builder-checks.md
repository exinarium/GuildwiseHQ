---
title: Builders run your project's checks before review
date: 2026-11-05
audience: all
help: /help/board-and-cards
release: 1.5.0
---
When a builder hands a card over, the runner now runs the repository's lint, format and typecheck checks first. A change that fails goes back to the builder with the failing lines, so it does not reach review broken. Set the checks under Project settings > Run and test.
