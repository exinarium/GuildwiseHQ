---
title: Troubleshooting
summary: Day-to-day problems: offline workstations, missing handoffs, vault conflicts, mismatched agents, waiting projects and cloud workstations.
keywords: [troubleshooting, problem, workstation, agent, vault, conflict, fix]
order: 23
---

Here are solutions to common day-to-day problems in Guildwise HQ.

## A workstation shows "Offline" {#workstation-disconnected}

The runner process stopped or the connection timed out. On that computer, check the state:

```
aom-runner status               # shows process state and connection
aom-runner doctor               # checks node, git, claude, docker, server connectivity
```

The guided installer runs the runner as a service. Restart it with `systemctl --user restart aom-runner` (Linux, and WSL2 on Windows) or by logging out and in again (macOS, where it starts at login). If you run the runner by hand, `aom-runner start` runs it in the foreground. The log is in `~/.aom-runner/logs/runner.log`.

## An agent finished but I do not see a handoff {#no-handoff}

The shift may have run past its time limit (an hour by default; the server stops it) or the runner crashed. Check:

- **Board**: the card should be back in its queue with the last handoff attached.
- **Workstations**: is the runner connected?
- **Logs**: check `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what happened.

## "The runner is running: stop it first" {#rotate-token}

When rotating the runner's token to refresh the connection:

1. Stop the runner: `systemctl --user stop aom-runner` (or press Ctrl+C if you run it in a terminal).
2. Rotate the token: `aom-runner rotate-token`.
3. Start it again: `systemctl --user start aom-runner` (or `aom-runner start`).

## Vault sync is paused with a conflict {#vault-conflict}

Vault sync stops if a local change conflicts with a remote change. Open **Vaults** in the sidebar, find the vault (it shows **Sync paused: conflict** and the conflicting files), and resolve it:

1. Fix the conflicting file(s) in the clone on your workstation (in Obsidian, VS Code, or your text editor) and commit.
2. Click **I resolved it, resume**.
3. Sync restarts.

This usually happens when you and an agent edit the same file at the same time. Merge the changes.

## Card does not match available agents {#card-no-match}

The repository must be listed under the workstation, and the agent must have the role and workstation assigned. Check:

- **Workstations**: open the workstation on the Workstations page and see if the repository is listed under **Repositories**.
- **Agents**: go to the agent's card and check its workstation, role, seniority and allowed projects (**Projects**).

The warning icon on the card says which of these it is (see [Board and cards](/help/board-and-cards#why-a-card-does-not-move)). If you just added a repository folder to the runner, it is re-scanned when the runner connects and every 10 minutes.

## Every card of a project is waiting {#toolchain-waiting}

Before agents build on a workstation, its DevOps engineer installs the tools and packages the project needs. Until that is done, every agent card of the project waits and says why. Open **Project settings, Development environment** to see what is missing and press **Fix** next to a missing tool to send the DevOps engineer to fix it (then the check runs again by itself), press **Check again** after fixing it yourself, or look on your desk for a notice that needs your help (for example a right you did not tick). See [New repositories and the toolchain](/help/devops-and-hygiene#setup).

## A cloud workstation needs attention {#cloud-attention}

A Codespace that cannot start (credits or spending limit used up on GitHub) shows **Needs attention** and leaves a notice on your desk. Fix it on GitHub and press **Wake**. See [Cloud workstations](/help/cloud-workstations#codespaces).

## An agent says the work is out of scope {#out-of-scope}

The agent reported work outside the scope of its role. Check:

- **Shift log**: look in `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what the agent tried to do.
- **Card thread**: read the card's comments to see what went wrong.
- **Fix it**: adjust the card spec or agent skills and try again.

## Git host says "Token refused" {#token-refused}

The badge on the Workstations page shows **Token refused** for a git host where you expected to be connected.

On the **Git hosts** panel, hover over the badge to see the HTTP status and the likely missing scope. Run the connect command shown in the **Connect** helper, usually with different credentials or a token with broader permissions. For Bitbucket, the documented token needs **repository** and **pull request** read/write scopes; if you only have the repository scope, git access still works but pull requests are unavailable.

## Runner update rolled back {#update-rolled-back}

The runner tried to update to a new version but rolled back automatically because the new version did not connect within a few minutes. The label on the runner shows **Update rolled back**.

This usually means the new version has a bug or incompatibility with your machine's setup. Check the runner log (`~/.aom-runner/logs/runner.log`) for errors, then contact support with the log. The runner keeps running on the old version and will not try that version again on this machine.
