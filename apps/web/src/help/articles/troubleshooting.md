---
title: Troubleshooting
summary: Day-to-day problems: disconnected workstations, missing handoffs, vault conflicts, mismatched agents.
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

The warning icon on the card says which of these it is (see Board and cards). If you just added a repository folder to the runner, it is re-scanned when the runner connects and every 10 minutes.

## An agent says the work is out of scope {#out-of-scope}

The agent reported work outside the scope of its role. Check:

- **Shift log**: look in `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what the agent tried to do.
- **Card thread**: read the card's comments to see what went wrong.
- **Fix it**: adjust the card spec or agent skills and try again.
