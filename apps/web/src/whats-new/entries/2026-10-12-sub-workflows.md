---
title: A workflow step can start another workflow
date: 2026-10-12
audience: admin
help: /help/org-chart-and-design#sub-workflows
---
A step of a custom workflow can now **start a card in another workflow**, in the same project or in another project of your organization, and either **wait** for it (the card shows "Waiting for SUP-12" and carries on, with chosen fields copied back, when that card ends) or **carry on** at once. In the workflow builder pick **Start another workflow** as the kind of step, then choose the workflow, the project, what to pass on and bring back, and what happens if the other card is cancelled. Nesting is limited to three levels and cycles are refused when you save. If a step cannot start its card, the card is blocked and a notice on your desk says why. When you cancel a card that is waiting, you can tick **Also cancel the card it is waiting for**. You can still ask the BA in a design chat to draft one.
