---
title: Cards are tested again
date: 2026-10-15
audience: all
help: /help/board-and-cards#integration-tests
---
Cards now always go through Test. With integration tests off (the default) the tester checks the branch against the test plan with what it can run without a running app, as before; with them on it also gets a running copy and your suites. Cards that were going to skip Test now go through it.
