---
title: Integration tests run by the tester
date: 2026-10-14
audience: all
help: /help/board-and-cards#integration-tests
---
Under **Project settings > Run and test** you can switch on integration tests (it starts off). A card then waits in Test while its workstation starts the card's branch; the tester runs your suites against it and each result shows on the card, with flaky runs marked. The copy is stopped at the verdict, or kept for a while after a failure. Switch it off for a single card in **Details**. You can also point the tester at a deployed target instead (opt it in under **Deploy targets > Testing**; test accounts are sealed for the workstation and never stored here).
