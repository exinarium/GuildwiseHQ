---
title: Troubleshooting
summary: Day-to-day problems: disconnected workstations, missing handoffs, vault conflicts, mismatched agents.
keywords: [troubleshooting, problem, workstation, agent, vault, conflict, fix]
order: 23
---

Here are solutions to common day-to-day problems in Guildwise HQ.

## A workstation shows "Disconnected" {#workstation-disconnected}

The runner process stopped or the connection timed out. To check the state:

```
aom-runner status               # shows process state and connection
aom-runner doctor               # checks node, git, claude, server connectivity
```

To restart it: `aom-runner start` or check logs in `~/.aom-runner/logs/runner.log`.

## An agent finished but I do not see a handoff {#no-handoff}

The shift may have timed out (server killed it after 1 hour offline) or the runner crashed. Check:

- **Board**: the card should be back in its queue with the last handoff attached.
- **Workstations**: is the runner connected?
- **Logs**: check `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what happened.

## "The runner is running: stop it first" {#rotate-token}

When rotating the runner's token to refresh the connection:

1. Stop the runner: `aom-runner stop` or press Ctrl+C.
2. Rotate the token: `aom-runner rotate-token`.
3. Restart: `aom-runner start`.

## Vault sync is paused with a conflict {#vault-conflict}

Vault sync stops if a local change conflicts with a remote change. Go to **Projects > Settings > Vaults**, find the vault, and resolve manually:

1. Click **Resolve**.
2. Fix the conflicting file(s) on your workstation (in Obsidian, VS Code, or your text editor).
3. Commit and push the fix.
4. Sync restarts automatically.

This usually happens when you and an agent edit the same file at the same time. Merge the changes.

## Card does not match available agents {#card-no-match}

The repository must be listed under the workstation, and the agent must have the role and workstation assigned. Check:

- **Workstations**: go to the workstation page and see if the repository is listed under it.
- **Agents**: go to the agent's card and check its assigned workstation and role.

If you just added a repository, agents see it after they reconnect (next heartbeat).

## Out of scope when I expected to run {#out-of-scope}

The agent reported work outside the scope of its role. Check:

- **Shift log**: look in `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what the agent tried to do.
- **Card thread**: read the card's comments to see what went wrong.
- **Fix it**: adjust the card spec or agent skills and try again.
