# Owner requirements: run steps + deploy setup UX (2026-10-20)

1. The whole deploy setup must be possible through the UI (otherwise it does not work for clients). Includes a
   "production" checkbox on deploy targets.
2. Redesign the project run steps (run plan) the same way: not plain text boxes.
3. Users with NO coding experience must be able to set up both runs and deploys. DevOps does the work; the user
   answers plain-language questions and confirms. Advanced (raw steps/recipe) view for developers, same underlying plan.
4. Target hosting: mostly the client's own PC / office server ("on this computer", workstation + Docker) or a VPS
   over SSH (guided: address + login once, app creates/installs a dedicated key, prepares Docker, folders, reverse proxy
   + HTTPS). Hosting platforms (Render/Fly/...) are out of scope for v1.
5. Setup must be non-destructive: if the environment is already set up (containers running, folders, proxy config,
   database), detect it first and adopt/reuse it — never kill or overwrite what is running. Show what was found and what
   would change; only change with confirmation.
6. A "Scan with DevOps" button on BOTH the run steps and the deploy setup: DevOps scans the repo (and the target
   environment) and populates the steps if it can find them; the user reviews and confirms.
7. UAT on "after merge" (debounced batch), production "on request" + gated on UAT healthy same commit + owner approval,
   as safe defaults. Local environments (UAT) can reuse the run plan for building/starting the app.
8. Existing SSH sign-in: detect hosts the workstation can already reach (ssh config aliases / known hosts, test with a
   non-interactive connect), offer "Use the sign-in this computer already has" as the default. A dedicated deploy key is
   optional (recommended, offered, never forced). Never edit ~/.ssh/config, existing keys or the server's
   authorized_keys without explicit confirmation; never remove or replace existing keys; the app never reads or shows
   private keys (the runner calls ssh as the user).
9. No existing SSH setup: guided connect (address, username, one-time password or the key the host gave them; the
   password is used once to install a dedicated deploy key the workstation generates, never stored), plus a copy-paste
   fallback for hosting panels. Connection test at the end.
10. Moving: the deploy setup belongs to the project/target, not to a machine or key. New/replacement workstation ->
   app detects it cannot reach the target and offers "Reconnect" (same guided flow, new key for that workstation; old
   key can be revoked). New server -> add a new target, non-destructive scan, guided move (database backup/restore,
   env/secrets carry-over, switch the domain), old target kept as fallback until the owner confirms. Each target shows
   which workstation deploys it and whether it can currently reach it.
