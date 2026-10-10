# Design: cloud workstations and repositories not on GitHub

Oct 10, 2026 · status: research, nothing built · companion to `docs/RUNNER.md`, `docs/ARCHITECTURE.md` (§n), `docs/design/organizations.md`

> Owner: "Investigate the possibility of integrating with something like GitHub Codespaces. We should also consider that a client's repo may not be stored on GitHub."

Prices, limits and product states below are **as of 2026-10-10** unless a source says otherwise; links are at the end of each part.

## 0. Summary

- Our runner is already a good fit for the cloud: it makes **outbound connections only** (wss to the server), pairs with a one-time code, installs headless (`GUILDWISE_YES=1`) and runs as a systemd user service. What is missing is (a) automatic pairing at boot, (b) start/stop on demand, and (c) a forge layer that is not `gh`.
- **GitHub Codespaces** can host the runner, but it only works for repositories on GitHub, stops a codespace after at most **4 hours** without *user* activity (a background daemon does not count), has no African region, and its terms forbid use "unrelated to the development or testing of the software project associated with the repository" and offering Codespaces as part of a commercial service. Usable, but as a second provider, after a spike.
- **Best first cloud option: a VM in the customer's own cloud account** (AWS `af-south-1` Cape Town, Azure South Africa North, Hetzner, any VPS), provisioned by cloud-init running our existing installer, started and stopped by the platform through the cloud API. Works with any git host, has no idle cap, keeps code in a region the customer picks (POPIA), and runs our bubblewrap sandbox without container tricks.
- **A hosted Guildwise worker pool (option B) is not recommended now**: customer code on our infrastructure, and Anthropic's terms forbid us collecting, storing or intermediating a user's Claude login or paying for Claude usage on the user's behalf.
- **Forges**: introduce a `Forge` adapter (runner side, with an optional server-held org credential), ship GitHub (cloud + Enterprise Server) and a **plain git** fallback first, then GitLab and Azure DevOps, then Bitbucket Cloud and Gitea/Forgejo. Bitbucket Data Center and CodeCommit on demand only.

---

## Part 1. Cloud workstations

### 1.1 GitHub Codespaces

**What it is.** A Linux VM per codespace, running a dev container built from the repository's `.devcontainer/devcontainer.json`, created from a GitHub repository (branch, PR or template). The repository is cloned into `/workspaces/<repo>`; other repositories can be cloned inside, but **a codespace cannot be created for a GitLab, Bitbucket or Azure DevOps repository**.

**Automation.** REST: `POST /repos/{owner}/{repo}/codespaces` (or `POST /user/codespaces` with `repository_id`), `POST /user/codespaces/{name}/start`, `/stop`, `DELETE /user/codespaces/{name}`, `GET .../machines`. Create takes `machine` (e.g. `standardLinux32gb`), `ref`, `devcontainer_path`, `geo` (`EastUs`, `WestUs2`, `WestEurope`, `SouthEastAsia`), `idle_timeout_minutes`, `retention_period_minutes` (0 to 43 200 = 30 days). Tokens: OAuth app / classic PAT with the `codespace` scope, or a GitHub App with *Codespaces: write*. CLI: `gh codespace create|list|stop|delete|ssh|cp|ports`. Codespaces are owned by a **user**, so the platform acts with a user's token, not an org-wide one.

**Machine types and price** (GitHub docs, as of 2026-10-10): 2-core / 8 GB / 32 GB $0.18 per hour, 4-core $0.36, 8-core $0.72, 16-core $1.44, 32-core $2.88; storage **$0.07 per GB-month**, charged while the codespace exists, stopped or not. Personal accounts get 120 core-hours + 15 GB-month (Free) or 180 + 20 (Pro) per month; **organizations get no free quota**. Compute is billed to the account that owns the repository's codespace (org pays if the org enables org billing for its repos; otherwise the user). Budgets can block create/resume when spent.

**Idle and retention.** Default idle timeout 30 min, range 5 to 240 min (an org policy can lower the maximum). Activity is user input, terminal input/output from a connected client, and editor file changes; **a headless background process is not activity**. A stopped codespace keeps its disk (and `~/.claude`, `~/.aom-runner`) until the retention period ends (default and maximum 30 days) and is then deleted. A rebuild wipes the home folder unless a volume is mounted.

**Can our runner daemon live there?** Yes for bursts, no as an always-on machine: it will be stopped at most 4 hours after the last real activity, in the middle of a shift if unlucky (our lease and reaper already turn that into `runner_lost_shift`, §8). Keep-alive tricks (synthetic terminal output) work around a control GitHub put there for billing and fairness; we should not ship them. The terms also forbid "the provision of a stand-alone or integrated application or service offering Codespaces ... for commercial purposes" and any use unrelated to developing the repository. Running agents that develop *that* repository, in the *customer's* account, at the customer's request is arguably development use, but it needs legal confirmation before we automate it.

**Prebuilds and secrets.** Prebuilds snapshot the built container per branch and region (cost: Actions minutes + storage) and cut start time to seconds. Secrets exist at user, repository and organization level and appear as environment variables; there is no per-codespace secret, which matters for pairing (1.5).

**Network.** Outbound open; inbound only through GitHub's authenticated port forwarding. Our outbound-only runner needs nothing more.

**Sandbox caveat.** Our agents run under bubblewrap (Linux) inside the runner host. In a container, unprivileged user namespaces are often blocked by seccomp/AppArmor, so bwrap may fail; a spike must confirm whether Codespaces allows it or needs `"privileged": true`/extra `runArgs`. A VM has no such problem.

### 1.2 Alternatives that work with any git host

| Option | Model | Automation | Pricing basis (2026-10-10) | Any git host | Self-host | Fit for a long-running runner |
| --- | --- | --- | --- | --- | --- | --- |
| **Ona** (ex-Gitpod) | Dev-container environments, SaaS or "runners" in your own AWS/GCP | API, CLI | Credits (OCUs); Free tier up to 3 parallel envs; Core from $20/month; about $0.11/h for 2 vCPU/8 GB, $0.23/h for 4 vCPU/16 GB | GitHub, GitLab, Bitbucket, Azure DevOps | Runner in your cloud, control plane SaaS | Good technically. **Gitpod Classic PAYG ended 2025-10-15; OpenAI agreed to acquire Ona on 2026-06-11** (pending approval). Strategic risk for a Claude-based product |
| **Coder** | Self-hosted control plane, workspaces defined by **Terraform templates** (VM, container, Kubernetes) | REST API, `coder` CLI, autostart/autostop schedules | Community edition free; Premium per user per year (price on request); you pay your own infra | Yes (external auth for GitHub, GitLab, Bitbucket, Azure DevOps, Gitea) | Yes, fully | Very good: templates can be VMs, and the template can pass a per-workspace pairing code. Heavy for a small customer to operate |
| **DevPod** (Loft) | Client-side, provider-based (Docker, SSH, AWS, GCP, Azure, Kubernetes), devcontainer.json | CLI | Free; you pay the cloud | Yes | n/a (no server) | **Upstream effectively unmaintained** (no default-branch commit since 2025-11, no stable release since 2025-03; a community fork is active). Do not build on it |
| **Daytona** | Agent sandboxes via SDK/API, per-second billing | SDK, REST | $0.0504/vCPU-h + $0.0162/GiB-h, storage beyond 5 GiB; $200 free credit | Yes (clone inside) | **Went closed source 2026-06-11**; old AGPL repo frozen | Built for short sandboxes; fine for burst shifts, less for a persistent workstation with vault sync |
| **BYO cloud VM** | A VM or VPS running our installer | The cloud's API (EC2, Azure, Hetzner, DigitalOcean) + cloud-init | e.g. EC2 `t4g.medium` (2 vCPU/4 GB) $0.0336/h on demand in us-east-1; Hetzner CX23 €5.49/month after the 15 June 2026 increase (CPX tiers rose 2.4 to 3x) | Yes | Yes | **Best**: no idle cap, VM-level sandbox works, region of choice (AWS `af-south-1`, Azure South Africa North) |
| **devcontainer spec** | The common denominator: Codespaces, Ona, DevPod, Coder (envbuilder) and the `@devcontainers/cli` all read `devcontainer.json` | `devcontainer up` | n/a | n/a | n/a | Lets one repository file describe the toolchain everywhere |

Anthropic publishes a Claude Code Dev Container Feature (`ghcr.io/anthropics/devcontainer-features/claude-code`). We can publish our own `ghcr.io/guildwise/devcontainer-features/runner` that installs the runner and Claude Code and registers a `postStartCommand`.

### 1.3 Design options for Guildwise

**(A) Platform-provisioned cloud workstation per project.** A new workstation kind `cloud` with a provider (`codespaces`, `coder`, `vm-aws`, `vm-hetzner`, ...). The org stores a provider credential on the server. When the dispatcher finds a queued card whose only eligible workstation is a stopped cloud workstation, it calls `provider.start()`; the runner boots, connects, and the card is claimed. After N idle minutes with no shifts the server calls `provider.stop()`. Per project or per org: a VM per **org** (several projects, `maxConcurrentShifts` 4) is cheaper than one per project; Codespaces forces one per repository.

**(B) Hosted Guildwise worker pool.** We run the VMs. Lowest friction for the customer, but: customer source on our infrastructure (we become an operator under POPIA and need cross-border, breach and retention terms per customer); per-tenant isolation (a VM per org, never shared kernels); and the Claude login problem in 1.4. We would also carry compute cost or resell it.

**(C) Documented BYO cloud VM.** Today's installer already works on a fresh Ubuntu VM. We document sizes, regions and steps and add an unattended mode (pairing code by environment variable, `claude setup-token` done by the user over SSH). **(C+)** later automates C as a provider of A.

| | A: Codespaces | A: Coder (customer-run) | A/C+: VM in customer cloud | B: hosted pool | C: documented BYO VM |
| --- | --- | --- | --- | --- | --- |
| Compute per agent-hour (4 shifts/VM) | $0.09 (4-core $0.36/h ÷ 4) + storage | customer infra, about $0.01 to $0.05 | $0.01 to $0.05 | ours, about $0.01 to $0.05 + margin | $0.01 to $0.05 |
| Always-on cost | not possible (4 h idle cap) | per schedule | €5.49/month (Hetzner CX23) to ~$25/month (t4g.medium) | ours | same as C+ |
| Setup friction | low if on GitHub; GitHub repos only | high (run Coder) | medium: paste a cloud API token, pick region | lowest | medium: SSH + one command |
| Code residency | GitHub regions, none in Africa | customer | customer, region of choice | us | customer |
| Credentials on the machine | Codespaces secrets | template secrets | cloud-init + runner config | ours to protect | user-managed |
| Our effort | M (spike first) | M | M | L (ops, security, billing) | S |

Claude usage, not compute, dominates the cost of an agent-hour in every option; compute is a rounding error unless a VM is left running for nothing.

**Toolchain fit.** Our `src/toolchain/stacks.ts` detection already knows what a repository needs; for a cloud workstation we can **generate a devcontainer.json** (features for dotnet, node, python, java, docker-in-docker) when the repository has none, and prefer the repository's own when it exists. Limits: Linux builds .NET MAUI **Android only**; iOS and Mac Catalyst need macOS with Xcode, which no Linux container or VM provides (macOS cloud: AWS EC2 Mac dedicated hosts with a 24-hour minimum allocation, MacStadium, Scaleway). The Android emulator needs KVM, which containers and most small VMs do not expose; tester shifts that need it want a bare-metal or nested-virtualization instance. A mixed MAUI project therefore needs a cloud Linux workstation plus a customer Mac for iOS, which our multi-workstation model already supports.

### 1.4 Claude authentication inside a cloud workstation

Claude Code reads `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or a browser sign-in stored in `~/.claude`. Our runner already supports all three (`runtimes.claude-code.authMode`). Anthropic's Legal and compliance page (read 2026-10-10) says:

- Subscription OAuth (Free, Pro, Max, Team, Enterprise) is for "ordinary use of Claude Code and other native Anthropic applications", and "advertised usage limits for Pro and Max plans assume ordinary, individual usage". Many parallel agents on one Pro/Max login may hit limits or enforcement.
- Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; sign-in must complete through Anthropic's own flow. Running Claude Code in hosted sandboxes requires the Commercial Terms, an **unmodified** binary, and each end user authenticating with their own API key, subscription or cloud-provider credential; the platform may not pay for or resell usage.
- It does allow "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code", and configuring the customer's own API key in an environment or machine image.

Consequences: the **server must never receive or store** a Claude token. In options A and C the user signs in on their own machine (SSH into the VM and run `claude` / `claude setup-token`, or put their API key in their own Codespaces secret). Recommended default for cloud workstations: an **org API key** (Console, Bedrock or Vertex) owned by the customer; subscription login allowed but labelled "individual use". Option B is only viable with customer-supplied API keys stored on the per-tenant VM, never in our database, and after checking the Commercial Terms with Anthropic.

### 1.5 Automatic pairing at boot

Today a pairing code is single-use, valid 10 minutes, and minted by the wizard. For a provisioned machine:

1. The server mints a pairing code bound to a *pending* cloud workstation row when it calls `provider.create()`.
2. VM/Coder: the code goes into cloud-init / Terraform variables; the installer runs with `GUILDWISE_YES=1 GUILDWISE_PAIR_CODE=...` and pairs. Codespaces: no per-codespace secret exists, so either run `gh codespace ssh -c 'aom-runner pair --code ...'` right after create (server holds the user's token), or use an **enrollment token** org secret (`GUILDWISE_ENROLL`) that can only pair a workstation the server has already announced by name, exchanged once by `postStartCommand: aom-runner up`.
3. `aom-runner up` is idempotent: pair if there is no `config.json`, otherwise start. Pairing survives stop/start (disk kept) and is redone after a rebuild or deletion.

---

## Part 2. Repositories not on GitHub

### 2.1 What we depend on today

`gh` for repository creation (`src/repo/create.ts`), `gh pr create` (`src/git/gh.ts`), gh's git credential helper for HTTPS probes (`src/repo/clone.ts`); the "new repository" form assumes `owner/name` and builds `https://github.com/<owner>/<name>.git` (`apps/web/src/pages/ProjectSettings.tsx`); GitHub issue polling for integrations. Plain git (clone, worktrees, push, local merge, `branch.check_merged` via `git merge-base`) is already forge-neutral. `normalizeRemoteUrl` (`packages/shared/src/ids.ts`) does **not** map the HTTPS and SSH forms of Azure DevOps (`dev.azure.com/o/p/_git/r` vs `ssh.dev.azure.com:v3/o/p/r`) or Bitbucket Data Center (`/scm/proj/repo` vs `:7999/proj/repo`) to the same key, so the same repository would be two repositories.

### 2.2 Forges

| Forge | Automated-agent auth | Repo list/create | PR/MR + merge | CLI | Webhooks | Protected branches |
| --- | --- | --- | --- | --- | --- | --- |
| **GitHub.com / Enterprise Server** | GitHub App (installation tokens, 1 h), OAuth app, fine-grained or classic PAT, deploy keys (one repo, no API) | `GET /installation/repositories`, `POST /orgs/{o}/repos` | `POST /repos/{o}/{r}/pulls`, `PUT .../merge`, auto-merge (GraphQL) | `gh` (GHES via `GH_HOST`) | repo, org, App | branch protection + rulesets (required reviews, status checks, no direct push) |
| **GitLab.com / self-managed** | OAuth app (instance or group), PAT, project/group access tokens (**Premium+ on GitLab.com**, any tier self-managed), deploy keys/tokens (git only) | `GET /projects?membership=true`, `POST /projects` (namespace, subgroups) | Merge requests API, `PUT .../merge`, "merge when pipeline succeeds" | `glab` (self-managed via host) | project; group hooks Premium | protected branches (who may push/merge), MR approvals |
| **Bitbucket Cloud** | OAuth consumer (workspace), API tokens with scopes (**app passwords disabled 2026-06-09**), repository/project/workspace access tokens, SSH/access keys | `GET /2.0/repositories/{ws}`, `POST /2.0/repositories/{ws}/{slug}` | `/pullrequests`, `POST .../merge` | none official for repos/PRs (Atlassian `acli` targets Jira/Confluence; third-party `atlassian-cli`) | repo, workspace | branch restrictions, merge checks (Premium for enforcement) |
| **Bitbucket Data Center** | HTTP access tokens (user, project, repo), SSH keys | `/rest/api/latest/projects/{p}/repos` | `/rest/api/latest/.../pull-requests`, merge endpoint | none | repo, project | branch permissions, merge checks. **End of sale to new customers 2026-03-30; DC end of life 2029-03-28** (Bitbucket gets a dual DC/Cloud licence) |
| **Azure DevOps Repos** | Microsoft Entra service principal or managed identity (recommended), org-scoped PATs (**global PATs stop 2026-12-01**), legacy Azure DevOps OAuth being retired for Entra OAuth, SSH keys | `GET _apis/git/repositories`, `POST _apis/git/repositories` (per project) | `pullrequests` API, auto-complete, `PATCH` to complete | `az repos` (azure-devops extension), `az repos pr create --auto-complete` | service hooks | branch policies: require PR, min reviewers, build validation (direct push refused) |
| **Gitea / Forgejo** | OAuth2 apps, scoped access tokens, deploy keys | `GET /api/v1/user/repos`, `POST /api/v1/orgs/{o}/repos` | `POST /repos/{o}/{r}/pulls`, `POST .../pulls/{n}/merge` (auto-merge supported) | `tea` (both), `fj` (Forgejo) | repo, org, system | protected branches: approvals, status checks, push allow-list |
| **AWS CodeCommit** | IAM (`git-remote-codecommit`, HTTPS git credentials), SSH keys | `ListRepositories`, `CreateRepository` (SDK) | `CreatePullRequest`, `MergePullRequestBy*` | `aws codecommit` | via EventBridge | approval rule templates. **Back to general availability since 2025-11-24**, open to new accounts again |
| **Plain git (SSH/HTTPS)** | SSH key or HTTPS credential helper on the workstation | none | none (push branch; local merge + push) | `git` | none | server hooks only; a refused push is the only signal |

For HTTPS git on a workstation, **Git Credential Manager** covers GitHub, GitLab, Bitbucket and Azure Repos with one helper; SSH keys cover everything.

### 2.3 The `Forge` adapter

Runner side (`apps/runner/src/forge/`), selected per repository from its host and an org-configured forge record (kind + base URL), with one REST implementation per kind (not CLI wrappers, except where only a CLI login exists):

```ts
interface Forge {
  readonly kind: 'github' | 'gitlab' | 'bitbucket-cloud' | 'bitbucket-dc' | 'azure-devops' | 'gitea' | 'codecommit' | 'git';
  readonly caps: ForgeCaps; // matrix below
  parseRemote(url: string): { host: string; namespace: string[]; name: string; canonical: string } | null;
  listRepos?(q: { search?: string; namespace?: string }): Promise<RepoRef[]>;
  createRepo?(r: { namespace: string; name: string; private: boolean; defaultBranch: string }): Promise<RepoRef>;
  gitAuth(repo: RepoRef): Promise<{ url: string; env?: Record<string, string> }>; // credential for clone/push, runner process only
  openChange?(c: { repo: RepoRef; base: string; head: string; title: string; body: string; draft?: boolean }): Promise<{ id: string; url: string }>;
  changeState?(id: string): Promise<'open' | 'merged' | 'closed'>;
  merge?(id: string, how: 'merge' | 'squash' | 'rebase'): Promise<{ commit: string } | { blocked: string }>;
  checks?(repo: RepoRef, sha: string): Promise<{ state: 'pending' | 'success' | 'failure'; items: Check[] }>;
  branchRules?(repo: RepoRef, branch: string): Promise<{ directPushAllowed: boolean; requiresChange: boolean }>;
  registerWebhook?(repo: RepoRef, url: string, secret: string): Promise<void>; // server side
}
```

| Capability | GitHub/GHES | GitLab | Azure DevOps | Bitbucket Cloud | Bitbucket DC | Gitea/Forgejo | CodeCommit | plain git |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| list / create repo | yes / yes | yes / yes | yes / yes (in a project) | yes / yes | yes / yes | yes / yes | yes / yes | no / no |
| open PR, state, merge | yes | yes | yes | yes | yes | yes | yes | no (push branch, local merge) |
| status checks | yes | pipelines | build policies | yes | yes | yes | no | no |
| branch rules readable | yes | yes | yes | yes | yes | yes | partial | no |
| webhooks | yes | yes | service hooks | yes | yes | yes | EventBridge | no |

**Plain git fallback.** Any URL the adapters do not recognise is `git`: `finalize --action pr` pushes the branch and posts a desk notice "open the PR yourself" (what we do today without `gh`); `merge` keeps the local integration-worktree merge; merge checks use `git merge-base`. "Create a new repository" is disabled for it.

**Protected branches.** Before a `merge` completion, call `branchRules`; when direct pushes are refused, open a change instead and record it, rather than failing on push.

**Where credentials live.** Two modes, chosen per org and forge:

1. **Workstation-held** (today's model, §16.5): the user's `gh`/`glab`/`az` login, GCM or a token in `config.json` (0600). Works for every forge including self-hosted ones behind a VPN the server cannot reach. Required for plain git and on-prem forges.
2. **Server-held org connection**: a GitHub App installation, GitLab OAuth app or group token, Entra service principal, Bitbucket OAuth consumer, Gitea OAuth app, stored encrypted on the server. Needed for the repository picker in the browser, webhooks, cloud workstations that start with no human login, and for not depending on the project owner's machine being online. The server sends a **short-lived, repo-scoped token** with each runner command (GitHub App installation tokens; GitLab and Azure equivalents where available), used only by the runner process, never exported to agents (as `GH_TOKEN` is withheld today).

This changes the rule "external credentials live only on workstations" for forges; it is an owner decision (Q4).

**Order of support.** (1) Adapter layer + GitHub (gh path kept as the workstation-held implementation) + plain git + URL normalisation + generic form. (2) GitLab (SaaS and self-managed share one API). (3) Azure DevOps (common in .NET shops). (4) Bitbucket Cloud. (5) Gitea/Forgejo (one adapter for both). GHES is GitHub with a base URL. Bitbucket DC and CodeCommit only when a paying customer asks (DC is end-of-sale).

---

## Part 3. Recommendation and plan

**Recommendation.** Do C and the forge layer now; build A with a VM provider in the customer's cloud next; treat Codespaces as an optional second provider after a spike; defer B.

| Phase | Scope | Rough effort |
| --- | --- | --- |
| 0 | `docs/guide` page "Run a workstation in the cloud" (VPS/EC2/Azure sizes, regions incl. `af-south-1`, POPIA note, Claude sign-in over SSH); `GUILDWISE_PAIR_CODE` unattended pairing; `aom-runner up` | 2 to 3 days |
| 1 | `Forge` interface, GitHub + plain git adapters, `normalizeRemoteUrl` for Azure/Bitbucket DC/GitLab subgroups, generic "add repository" form (host picker, namespace path), `branchRules` before merge | 1.5 to 2 weeks |
| 2 | GitLab and Azure DevOps adapters (workstation-held tokens first), credential checks in `doctor` and on the Workstations page | 2 weeks |
| 3 | Cloud workstation kind: provider interface (`create/start/stop/delete/status`), Hetzner + AWS providers via cloud-init, wake-on-queued-card in the dispatcher, idle stop, cost shown per workstation | 3 to 4 weeks |
| 4 | Server-held forge connections (GitHub App first, then GitLab OAuth), repository picker, webhooks for merge detection replacing polling | 2 to 3 weeks |
| 5 | Optional: Codespaces provider (after spike: bwrap in container, idle behaviour, legal read of the terms) and/or Coder template; Bitbucket Cloud and Gitea adapters | 2 to 3 weeks each |

**Risks.** Claude terms change again (they changed in January, February and October 2026); cloud workstations make subscription use more visible, so steer to API keys. Server-held forge tokens raise our breach impact; encrypt, scope and expire them. Idle stop mid-shift loses work unless shifts checkpoint (leases already recover the card). Bubblewrap may not run in containers. Vendor churn: Ona (OpenAI acquisition), Daytona (closed source), DevPod (unmaintained), Hetzner (two price rises in 2026). Forge auth churn: Bitbucket app passwords gone, Azure global PATs end 2026-12-01. iOS work still needs a customer Mac.

## Open questions for the owner

1. **Which cloud option first?** (a) documented BYO VM only; (b) platform-provisioned VM in the customer's cloud account; (c) Codespaces first; (d) hosted pool. **Recommendation: (a) now, (b) next**; (c) only after a spike, (d) not before the Claude and POPIA questions are settled.
2. **Which VM providers first for (b)?** (a) AWS (Cape Town region); (b) Azure (South Africa North); (c) Hetzner (cheapest, EU only); (d) generic SSH host only. **Recommendation: AWS + Hetzner**, Azure third.
3. **Claude authentication on cloud workstations?** (a) API key only; (b) API key by default, subscription allowed with an "individual use" warning; (c) anything goes. **Recommendation: (b)**, and the server never stores a Claude credential.
4. **Forge credentials: keep "workstation only" or add server-held org connections?** (a) workstation only; (b) server-held for GitHub/GitLab/Azure with short-lived tokens pushed per command, workstation-held as fallback; (c) server only. **Recommendation: (b)**, needed for cloud workstations and webhooks.
5. **Forge order after GitHub?** (a) GitLab, Azure DevOps, Bitbucket Cloud, Gitea; (b) Azure DevOps first (likely for .NET/MAUI clients); (c) ask current customers. **Recommendation: (c) quickly, defaulting to (a)**.
6. **Cloud workstation scope?** (a) one per org shared by its projects; (b) one per project; (c) the manager chooses. **Recommendation: (a)** with (c) as an option; Codespaces would force per-repository.
7. **Idle policy?** (a) stop after 30 min without shifts, start on a queued card; (b) office-hours schedule; (c) always on. **Recommendation: (a)** plus an optional schedule; show the monthly estimate.
8. **Who pays compute?** (a) the customer's cloud account (we never touch compute billing); (b) we resell. **Recommendation: (a)**.
9. **Plain git repositories: allow "merge" completion (direct push to the working branch)?** (a) yes, as today; (b) only push branches. **Recommendation: (a)**, with the protected-branch check where the forge is known.

## Sources

- GitHub Codespaces billing: https://docs.github.com/en/billing/concepts/product-billing/github-codespaces
- Codespaces REST API: https://docs.github.com/en/rest/codespaces/codespaces
- Idle timeout and retention: https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces, https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/restricting-the-idle-timeout-period, https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/restricting-the-retention-period-for-codespaces
- Codespaces terms: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- Codespaces and non-GitHub repos: https://github.com/orgs/community/discussions/10479
- Claude Code legal and compliance (authentication): https://code.claude.com/docs/en/legal-and-compliance
- Claude Code dev containers: https://code.claude.com/docs/en/devcontainer
- Ona: https://ona.com/stories/gitpod-classic-payg-sunset, https://ona.com/stories/migrating-from-classic-to-ona, https://www.forbes.com/sites/janakirammsv/2026/06/13/openai-buys-ona-to-run-codex-agents-inside-enterprise-clouds/, https://thenextweb.com/news/openai-acquires-ona-codex
- Coder: https://coder.com/blog/coder-the-github-codespaces-alternative, https://www.g2.com/products/coder/pricing
- DevPod status: https://github.com/loft-sh/devpod/issues/1915, https://silenwang.github.io/en/2026/01/17/%E5%95%8A%E8%BF%99-%E5%8E%9F%E6%9D%A5devpod%E5%B7%B2%E7%BB%8F%E8%A2%AB%E5%AE%98%E6%96%B9%E6%94%BE%E5%BC%83%E4%BA%86%E4%B9%88/
- Daytona: https://www.daytona.io/pricing, https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source
- Hetzner price adjustment: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/, https://northflank.com/blog/hetzner-cloud-server-price-increases
- EC2 t4g.medium: https://instances.vantage.sh/aws/ec2/t4g.medium
- Bitbucket app passwords: https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-transitions-to-api-tokens-enhancing-security-with-app-password-deprecation
- Atlassian Data Center end of life: https://www.atlassian.com/licensing/data-center-end-of-life
- GitLab access tokens: https://docs.gitlab.com/user/project/settings/project_access_tokens, https://docs.gitlab.com/user/group/settings/group_access_tokens/
- Azure DevOps global PAT retirement: https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/, https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate
- AWS CodeCommit back to GA: https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability
- Gitea/Forgejo CLIs: https://github.com/deevus/tea-skills, https://forgejo.zerova.net/public/fj
- Bitbucket CLI landscape: https://atlassian-cli.pages.dev/blog/acli-vs-atlassian-cli

Not verified against a primary source and worth a check before building: Ona's exact OCU rates and git-provider list (pricing page is behind a sales form), Bitbucket access-token tier limits, the Azure DevOps OAuth retirement date, Coder Premium price, and whether Codespaces permits bubblewrap without `privileged`.
