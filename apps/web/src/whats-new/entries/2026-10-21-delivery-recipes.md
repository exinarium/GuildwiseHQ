---
title: Deploys you approve once, that run without a model
date: 2026-10-21
audience: admin
help: /help/phases#delivery-recipes
---
A project can now deploy through a **recipe**: a small script in the project vault that always does the same steps (deploy, wait until it is healthy, smoke check). Ask your CEO to "set up deploys for this project": it asks about the environments, the targets, the gate and the secrets, and DevOps writes the scripts and tries them. Then **you approve that exact version** under **Project settings, Delivery**. Change a byte and it needs a new approval.

The recipe says who releases each environment: you (the new **Deploys** page lists releases that are ready, with the commit, the environment and the servers, and you press **Release**, choosing the servers when there are several), the CEO (only where the recipe names it), or automatically once the gate holds. A gate can require an earlier environment to be healthy on the same commit, tests to have passed, a time window and a freeze. A model never runs a deploy command: it can only ask Guildwise, and your workstation runs the script itself, with secrets that stay on that workstation. Projects that deploy with instructions work as before.
