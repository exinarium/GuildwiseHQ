### Troubleshooting
Day-to-day problems: offline workstations, missing handoffs, vault conflicts, mismatched agents, waiting projects and cloud workstations.
- A workstation shows "Offline": The runner process stopped or the connection timed out. On that computer, check the state:
- An agent finished but I do not see a handoff: The shift may have run past its time limit (an hour by default; the server stops it) or the runner crashed. Check:
- "The runner is running: stop it first": When rotating the runner's token to refresh the connection:
- Vault sync is paused with a conflict: Vault sync stops if a local change conflicts with a remote change. Open Vaults in the sidebar, find the vault (it shows Sync paused: conflict and the conflicting files), and resolve it:
- Card does not match available agents: The repository must be listed under the workstation, and the agent must have the role and workstation assigned. Check:
- Every card of a project is waiting: Before agents build on a workstation, its DevOps engineer installs the tools and packages the project needs. Until that is done, every agent card of the project waits and says why.…
- A cloud workstation needs attention: A Codespace that cannot start (credits or spending limit used up on GitHub) shows Needs attention and leaves a notice on your desk. Fix it on GitHub and press Wake. See Cloud workstations.
- Cards wait in Design with no architect hired: A project has Investigate & design before build turned on in the Architect settings, but you haven't hired an architect yet. Cards move into the Design stage and wait because nobody can claim it.
- Main branch merge was skipped or conflicted: When your repository has a main branch and a different working branch, the runner tries to merge the latest main into the working branch before a card's work starts (on by default). In the project's Architect settings, Merge the latest main branch first controls this.
- A workflow variant is waiting for approval: You submitted a project variant (custom steps added to Code or another workflow for one project) and it is waiting on your desk.
- An agent says the work is out of scope: The agent reported work outside the scope of its role. Check:
- Git host says "Token refused": The badge on the Workstations page shows Token refused for a git host where you expected to be connected.
- SSH says "refused the key", "host key changed" or "not reachable": On Workstations, open the workstation, click SSH on the git host and press Check SSH. The state tells you what to do:
- Runner update rolled back: The runner tried to update to a new version but rolled back automatically because the new version did not connect within a few minutes. The label on the runner shows Update rolled back.
- Working branch could not be created or pushed: A card shows Last attempt failed: working branch 'X' could not be created or pushed or names a reason like "protected repository".
- An agent says it cannot read a repository: In a chat or on a card, the agent says it cannot find or read a code repository (for example to compare two or look up how something is used elsewhere).
- A project says "Paused until ...": The Claude subscription behind the project reached its session or weekly usage limit. Nothing is broken: cards wait in their queue without penalty and work continues by itself when the limit resets (shown on the board and the project page, in your time zone).…
