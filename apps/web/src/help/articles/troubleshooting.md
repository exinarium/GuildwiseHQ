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

## Cards wait in Design with no architect hired {#design-no-architect}

A project has **Investigate & design before build** turned on in the **Architect** settings, but you haven't hired an architect yet. Cards move into the **Design** stage and wait because nobody can claim it.

To fix it:

1. Go to **Agents** and hire an **Architect** (senior only).
2. Or, turn off **Investigate & design before build** in the project's **Architect** settings if you don't need design for now. You can turn it back on anytime.

See [The architect](/help/architect).

## Main branch merge was skipped or conflicted {#merge-main-skipped-conflicted}

When your repository has a main branch and a different working branch, the runner tries to merge the latest main into the working branch before a card's work starts (on by default). In the project's **Architect** settings, **Merge the latest main branch first** controls this.

**Skipped** appears on the card when the architect role is not hired (the merge happens before the card's first work, so there is nobody to resolve a conflict). Answer the question on your desk to set the branch or hire an architect.

**Conflicted** means the merge went into the card branch instead (the working branch is protected or moved before the runner could finish). The architect resolves the conflict by editing the conflicted files, then `aom git merge-main` or let the runner finish the merge when the shift ends. On a card without an architect the conflict is left unresolved and the desk asks you what to do.

See [The architect > Merge the latest main branch first](/help/architect#merge-main).

## A workflow variant is waiting for approval {#variant-awaiting-approval}

You submitted a project variant (custom steps added to Code or another workflow for one project) and it is waiting on your desk.

To approve and use it:

1. Open the **Desk** and find the item about the variant.
2. Review the variant and decide: **Approve** to let new cards use it (running cards keep the version they started on), or **Reject** to discard it.
3. Once approved, go to **Project settings, Workflows** and you will see the new version listed as pending. Enable it if it is not marked as primary.

See [Workflows of a project](/help/projects#workflows) and [Organization chart and design](/help/org-chart-and-design#variants).

## An agent says the work is out of scope {#out-of-scope}

The agent reported work outside the scope of its role. Check:

- **Shift log**: look in `~/.aom-runner/logs/shifts/<shiftId>.jsonl` to see what the agent tried to do.
- **Card thread**: read the card's comments to see what went wrong.
- **Fix it**: adjust the card spec or agent skills and try again.

## Git host says "Token refused" {#token-refused}

The badge on the Workstations page shows **Token refused** for a git host where you expected to be connected.

On the **Git hosts** panel, hover over the badge to see the HTTP status and the likely missing scope. Run the connect command shown in the **Connect** helper, usually with different credentials or a token with broader permissions. For Bitbucket, the documented token needs **repository** and **pull request** read/write scopes; if you only have the repository scope, git access still works but pull requests are unavailable.

## SSH says "refused the key", "host key changed" or "not reachable" {#ssh-problems}

On **Workstations**, open the workstation, click **SSH** on the git host and press **Check SSH**. The state tells you what to do:

- **The host refused the key**: the public key is not on your account at the host. Copy the public key shown there and add it (GitHub *Settings, SSH and GPG keys*; GitLab *User settings, SSH keys*; Bitbucket *Personal settings, SSH keys*; Azure DevOps *User settings, SSH public keys*), then check again. With a key file of your own, make sure the path is the private key and that it has no passphrase (the runner cannot type one; use **my ssh-agent** for a protected key).
- **No key yet**: the key file does not exist on the workstation. Click **Save and create key**, or fix the path.
- **Host key changed**: the host identified itself differently than the first time. If you did not expect that (a new server, a re-installed host), stop. Otherwise remove the host's line from `secrets/known_hosts` in the runner's data folder and check again.
- **Host not reachable**: port 22 may be blocked by a firewall or a VPN. Test from a terminal on the workstation with `ssh -T git@github.com`.
- **ssh is not installed**: install the OpenSSH client on the workstation.

If SSH works but pull requests are not opened, that is expected: pull requests need the API token or CLI login (**Connect**). The branch is pushed and the manager opens the pull request.

## Runner update rolled back {#update-rolled-back}

The runner tried to update to a new version but rolled back automatically because the new version did not connect within a few minutes. The label on the runner shows **Update rolled back**.

This usually means the new version has a bug or incompatibility with your machine's setup. Check the runner log (`~/.aom-runner/logs/runner.log`) for errors, then contact support with the log. The runner keeps running on the old version and will not try that version again on this machine.

## Working branch could not be created or pushed {#working-branch-push-failed}

A card shows **Last attempt failed: working branch 'X' could not be created or pushed** or names a reason like "protected repository".

The working branch is where finished card work is combined after review and test (see [Projects](/help/projects#reference-repos) and [Testing and finalization](/help/testing-and-finalization#finalization)). If it does not exist, Guildwise tries to create it from the main branch and push it. If the push is refused (a protected repository, no access, or an uncommitted conflict), a question waits on your desk: **Which branch is the working branch of `<repository>`?**

To fix it:

1. **On the Workstations page**, open the workstation and look under **Repositories** for the problematic repository.
2. If the error says the branch is protected, go to **Project settings > Repositories** and read the error under the repository. You may need to change **How finished work lands** to **Pull request** if the branch rules block direct commits.
3. If the error says no access, check the repository's **Access** setting: it must be the workstation's default or an SSH key / API token the runner can use.
4. Answer the question on your desk to set which branch to use going forward. The card will then retry.

See [DevOps and repository hygiene](/help/devops-and-hygiene#working-branch) for more detail.

## An agent says it cannot read a repository {#reference-repositories-needed}

In a chat or on a card, the agent says it cannot find or read a code repository (for example to compare two or look up how something is used elsewhere).

Agents can only read the folder they are working on (their card's branch) and, in a chat about a project, the project's own repositories. To let agents read other code, the project owner adds **Reference repositories** in the project settings so they can compare or look things up. Every repository you do not pick stays blocked, along with everything else on the workstation.

To fix it:

1. Open **Projects** and click the gear on the project.
2. Go to **Reference repos**.
3. Under **Add a reference repository** pick the repository the agent needs (the repositories of other projects, listed under **Projects**, or any repository cloned on a workstation, listed under **On <workstation>**).
4. Click **Add**.

Secret files like `.env` and keys stay blocked even in reference repositories. Agents are told which folders they can read, so they may ask you to add a repository instead of searching for a setting. See [Projects](/help/projects#reference-repos) for the full explanation.

## A project says "Paused until ..." {#usage-limit}

The Claude subscription behind the project reached its session or weekly **usage limit**. Nothing is broken: cards wait in their queue without penalty and work continues by itself when the limit resets (shown on the board and the project page, in your time zone). You also get one notice on the **Desk**, which closes by itself. To avoid waiting, use another workstation or a different Claude plan.
