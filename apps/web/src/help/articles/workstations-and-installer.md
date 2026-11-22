---
title: Workstations and the installer
summary: What a workstation is, the Add a workstation wizard, installing by hand, Claude sign-in, Windows and connecting git hosts.
keywords: [workstation, installer, runner, WSL2, setup, wizard, credentials, src folder, windows task, jira, jira-connect, git host, git-connect, ssh, ssh key, github, gitlab, bitbucket, azure devops, plain git, connect]
order: 18
---

A **workstation** is a computer of yours (Windows, macOS or Linux) where your agents run and work on your code. The **runner** is the software on that computer that pairs with Guildwise HQ and lets agents work. The guided installer sets everything up; you do not need to know about servers. Agents can also run on a server you rent or in a GitHub Codespace: see [Cloud workstations](/help/cloud-workstations).

## What is a workstation {#what-is-a-workstation}

A workstation is your own machine: a laptop, desktop or server. It holds your git repositories and is where agents run their work. You can have one workstation or many. Each agent is assigned to one workstation and only that one.

The runner on each workstation:
- Stays connected to Guildwise HQ.
- Sandboxes agents so they cannot read your SSH keys or other projects. The DevOps engineer is the exception: it works as you (see [DevOps and repository hygiene](/help/devops-and-hygiene#devops-engineer)).
- Manages git, Docker and other tools.
- Syncs vaults (your shared knowledge base).
- Runs repository hygiene (pull the latest changes, keep your unsaved edits safe, clean up finished work).

## Add a workstation {#add-a-workstation}

First choose **where your agents should run**: **My computer** (below), **A VPS (SSH)** or **GitHub Codespaces**. The last two are explained in [Cloud workstations](/help/cloud-workstations).

1. Go to **Workstations** (sidebar: Organization) and click **Add a workstation** (or the button in the middle if the list is empty).
2. **Pick the system**: Windows, Linux or macOS. The page guesses from your browser; change it if needed. Optionally type a name for the workstation.
3. **Read the steps and click Copy command**: the command contains a link (works 30 minutes) and a pairing code (one time only). It never contains a password. You can also read the whole script first with **Download the script**. If 30 minutes pass, choose your system again for a new one.
4. **Run the command on that computer**: open a terminal (Windows: PowerShell), paste and press Enter. Say yes when it asks permission. Windows may ask to restart, possibly more than once; after each restart the installer carries on by itself when you sign in (or run the command again). WSL2 needs virtualization turned on in the BIOS/UEFI: see [Installer troubleshooting](/help/install-troubleshooting#windows-virtualization).
5. **Watch this page**: it shows the installer starting, pairing ("Paired as..."), then **Health checks** one by one, and finally **Ready**. The **Installer log** shows each step. If it stops, the last line marked [x] in the terminal (shown as [fail] in the log) says what to fix.

The installer asks only what it must: your password once (to install system tools), whether you want optional extras (yt-dlp for video transcripts; Docker, only if testers run containers), and how Claude should sign in. Your code lives in `~/src`; the installer asks about folders only if you turned on expert mode in Settings (or run it with `--choose-folders`). On Windows it names its start-up task "Guildwise HQ runner" and removes the older "WSL Boot" task when you run it again.

## Claude sign-in {#claude-sign-in}

The installer asks how agents should use Claude:

- **Claude subscription** (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and work counts against your plan.
- **Anthropic API key**: you pay for exactly what agents use.

Choose whichever your organization provided. You can choose later and run `claude` on that computer any time; the health check "claude" shows the state.

## Installing by hand {#installing-by-hand}

Only needed when the guided setup is not an option:

1. Go to **Workstations** and click **Pair with a code** (or **Pair it with a code instead** in the Add a workstation window).
2. Click **Generate pairing code** and copy the command it shows. The code (`XXXX-XXXX`) is valid for 10 minutes.
3. On the computer, download or build the runner.
4. Run the pair command, add your repository folders (`guildwise-runner repos add`), and start the runner as a service.

The runner command is `guildwise-runner`; the older name `aom-runner` still works.

See the installer's help links for your system's commands. On Windows, install the runner inside WSL2 (Ubuntu): that is the only way to get a sandbox.

## Health checks {#health-checks}

While the installer runs, this page lists the health checks as they finish: Node, git, Claude, the sandbox, Docker, yt-dlp, your repositories and server connectivity. Each shows **ok**, **warn** or **fail**. A **fail** means something is missing or broken and the line says what. A **warn** (Docker, yt-dlp) is optional.

Afterwards, a workstation's card on the **Workstations** page shows its name and runner version, whether it is **Connected** or **Offline**, and an **Unpair** button. Click the name to expand it: its runtimes (with a sandbox warning if one cannot sandbox agents), how many shifts are running, its repositories, its git hosts and the DevOps engineer panel. To run the checks again, run `guildwise-runner doctor` on that computer.

## Shifts at once {#shifts-at-once}

Open a workstation and set **Shifts at once**: the runner's own value, a number or **Unlimited**. The machine's memory and CPU and the model usage limit still apply, and a platform ceiling, when there is one, is shown.

## Shared package caches {#shared-caches}

Agents of one workstation share its package caches (NuGet, npm, pnpm, pip, Gradle, Maven, Go), kept in the runner's data folder, so each package is downloaded once. Packages already restored in your own NuGet folder are reused too, read-only. Because the agents run as the same computer user, one agent could in principle leave a modified package for another; delete the `cache` folder in the runner's data folder to start clean. .NET projects build and test inside the sandbox; if a sandbox error persists after a retry, ask the DevOps engineer to build outside it.

## Agent toolchains {#toolchains}

Agents use the tools found under your home (several .NET SDKs, Node, Go, Python, Java) and any the DevOps engineer registers. The Workstations page lists them; you can remove a registered one. A tool you want agents to have, such as .NET 10, is installed by asking DevOps.

## Windows {#windows}

**Default: WSL2** (recommended). Install the runner inside a WSL2 Ubuntu distribution and follow the Linux instructions. The installer turns on WSL2 for you; you just follow the steps. Windows may ask to restart, possibly more than once, and you run the command again if the installer does not open by itself. WSL2 needs virtualization turned on in the BIOS/UEFI: see [Installer troubleshooting](/help/install-troubleshooting#windows-virtualization). Agents run sandboxed inside WSL2 just like on Linux.

**Native Windows** (not recommended) cannot sandbox agents. Agents run without an OS sandbox and could read your SSH keys. The workstation shows an amber warning that cannot be dismissed. If you must run natively, set `"sandbox": "best_effort"` in the runner config.

For vault SSH keys on Windows, ensure git can find them (OpenSSH or PuTTY with Pageant).

## Git hosts {#git-hosts}

Each repository of a project has a git host: GitHub, GitLab, Bitbucket Cloud, Azure DevOps, or a plain git server. For pull requests, the repository list and creating new repositories, the workstation must be **connected** to that host. Your login or token stays on the workstation; Guildwise HQ only learns whether it works.

Open the workstation card on the **Workstations** page: **Git hosts** shows Connected, Not connected (no token saved), Token refused (hover for the HTTP status and the likely missing scope) or Could not check (the host could not be reached) for each host. Click **Connect** for the one command to run in a terminal on that workstation:

- `guildwise-runner git-connect github` opens a browser to sign in (GitHub CLI).
- `guildwise-runner git-connect gitlab` signs in with the GitLab CLI or asks for a personal access token.
- `guildwise-runner git-connect bitbucket-cloud` asks for your Atlassian e-mail and an API token (old app passwords no longer work).
- `guildwise-runner git-connect azure-devops` uses a **Microsoft Entra service principal** if the workstation has one (the best way for a team; see below), or your Azure sign-in (`az login`). As a fallback, add `--organization <name>` to paste a personal access token. Use a token for one organization: global tokens stop working on 1 December 2026.
- Add `--ssh` to any of them to use an SSH key instead of a token (see below).

Then click **Check again**. The DevOps engineer can walk you through any of these in a chat (**Ask DevOps** on the workstation). It can start a browser sign-in for you and show you the web address and code to enter; it never asks for or types a token. When a token is needed it tells you to run the command above yourself or to use the **Connect** helper.

**SSH instead of an API token.** If you already have SSH keys, you do not need a token for clone, fetch and push. On the workstation card, click **SSH** next to the git host:

1. Choose the **default for new clones**: API token / CLI login, or SSH key.
2. Choose the key: **a key made by the runner** (click **Save and create key**; the public key appears with the place to add it: GitHub *Settings, SSH and GPG keys*, GitLab *User settings, SSH keys*, Bitbucket *Personal settings, SSH keys*, Azure DevOps *User settings, SSH public keys*), **a key file I already have** (its full path on the workstation; it is not copied), or **my ssh-agent**.
3. Click **Check SSH**. Optionally paste a repository address to test with the real thing. You get one state: *SSH works*, *The host refused the key* (add the public key on the host), *Host key changed*, *Host not reachable* (a firewall may block port 22), *No key yet* or *ssh is not installed*.

In a terminal, the same is `guildwise-runner git-connect github --ssh` (add `--key-file <path>` or `--agent`; `--check` tests it). A repository can use the other method: the owner picks **Access** under the repository in the project settings, and the workstation switches that clone between https and ssh by itself. The private key never leaves the workstation and agents never read it.

**Jira.** Below the git hosts the workstation card has a **Jira** line: *Connected as ...*, *Not connected* or *Refused*. Agents use it to read the files attached to a Jira ticket through your workstation (see [Intake and outbox](/help/intake-and-outbox#jira-attachments)). To connect, run `guildwise-runner jira-connect` in a terminal on that workstation: it asks for your Jira address, e-mail and an API token, checks them with Jira and saves them on that computer (`secrets/jira.json`, readable by you only); the page only learns the state.

SSH only covers git itself. Pull requests, branch rules and the repository list still need the token or CLI login: with SSH only, finishing a card pushes the branch and you or the manager open the pull request by hand, and Project settings says so under the repository.

**Azure DevOps: use a Microsoft Entra service principal.** Personal access tokens that are not limited to one organization stop working on 1 December 2026, so for Azure DevOps use a service principal (an app identity in Microsoft Entra) or workload identity:

1. In Microsoft Entra register an application and create a client secret (or a federated credential for workload identity).
2. In Azure DevOps, under Organization settings, Users, add the application with Basic access, and give it Contributor on the project's repositories.
3. On the workstation set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` for the runner (with workload identity, `AZURE_FEDERATED_TOKEN_FILE` instead of the secret), and optionally `AZURE_DEVOPS_ORGANIZATION`.
4. Restart the runner and click **Check again**: Azure DevOps shows Connected.

A personal access token for one organization and `az login` (also `az login --service-principal`) keep working as fallbacks.

A **plain git** server needs no connection, but no pull request is opened: the branch is pushed and the desk tells you to open the request yourself. If a project's main or working branch is protected on the host, finished work arrives as a pull request instead of being pushed directly (see [Testing and finalization](/help/testing-and-finalization#finalization)).

## Runner updates {#runner-updates}

The runner on a workstation keeps itself up to date. A few minutes after it starts, and then once a day, it asks the server which runner version is current. When a newer one exists it downloads it, checks that the file is intact, and waits until no agent is working on that workstation before it restarts into the new version. It never cuts a running job short. If the workstation stays busy for a very long time (about six hours) it updates anyway.

The runner version is shown under the workstation's name. When there is something to know, a small label appears next to it:

- **Update to 0.2.0 pending**: downloaded, waiting for the agents to finish.
- **Updating**: restarting into the new version (a few seconds).
- **Update failed**: it could not install the new version (the tip on the label says why). It keeps running the old one and tries again at the next daily check.
- **Update rolled back**: the new version did not connect within a few minutes, so the runner went back to the previous version by itself. It will not try that version again on this machine.
- **Updates paused**: the platform administrator paused automatic updates. Runners stay on their version until they resume.
- **Updates by hand**: this runner was started by hand and not by the installer's service, so it cannot restart itself. Run the install command again to update it.

Every update is checked before it is installed: the runner verifies the signature on the release and never installs, or rolls back to, a version below its floor (the lowest version Guildwise 1.10.0 accepts). On a self-hosted server with **Only signed runners** off, runners from before 1.10.0 keep working and, with automatic updates on, move to the runner that ships with Guildwise 1.10.0 by themselves, normally within about a day. The new runner then starts in "setup pending": sandboxed card shifts keep running, but DevOps, deploys and other steps outside the sandbox wait until you run `guildwise-runner setup` once on that machine (see [Setting local permissions](#local-permissions)). With **Only signed runners** on, an old runner cannot update itself; it must be reinstalled (see [Reinstalling a runner](#reinstall)).

You do not need to do anything else. Running the install command again still upgrades a runner at any time. To switch automatic updates off on one computer, set `AOM_RUNNER_AUTO_UPDATE=0` for the runner.

**Check for updates.** Next to the runner version on the workstation card, **Check for updates** asks the runner to run its update check now instead of waiting for its timer. The usual rules still apply: it downloads and checks the new version, and waits until no agent is working before it restarts. The runner's answer appears beside the button. The button is disabled when the workstation is offline, or when its runner is too old to report updates.

## Works for {#works-for}

A workstation works only for the organizations you own when you pair it.

To let it work for another organization, switch that organization on under **Works for** on the Workstations page, or tick it when you accept an invitation (on by default for an organization you create, off when you join as a member). Hiring an agent onto your own workstation switches serving on for that organization. Moving an agent onto someone else's workstation, and the automatic DevOps hire, need that person's consent. Switching an organization off marks its agents there as needing a new home and retires its DevOps engineer; it is refused while a shift of that organization runs there.

## Reinstalling a runner {#reinstall}

Reinstalling means running the **Add a workstation** command from your own server again.

The installer starts with **Looking for an older runner**: it finds an old install, stops it and quarantines it (a single archive under `~/.guildwise-quarantine/<time>/`, with a `MANIFEST.txt`; use `--legacy remove` to delete instead). Nothing of the old install is read or reused: no token, key, sudo password, policy or clone. Delete the quarantine after you have looked at it. If sudo was ever granted to the old runner, change that user's password, because the old sealed password may be known. A sealed sudo password of a 1.10.0 test install is deleted without being read.

When it is required:

- **Only signed runners** is on: a runner that is unsigned or older than 1.10.0 is unlinked and its card shows **Reinstall required** with a button that opens **Add a workstation**. It cannot be paired again in place.
- A self-hosted server with the setting off needs nothing. Old runners keep working and update by themselves.
- After a failed first start, run the install command again (see [Troubleshooting](/help/troubleshooting#reinstall-needed)).

## Setting local permissions {#local-permissions}

At the end of the installer, `guildwise-runner setup` shows **one screen** with every choice, named in plain words, with the safe answer already filled in. Press **Enter** to accept, or type the number of a line (like `1a`) to change it. You can run setup again at any time (it refuses to run as root). Your answers stay on the machine and never come from the server. `--yes` alone picks the safe answers.

1. **DevOps helpers** (agents that install tools and run commands here), one line per organization. Starts at No.
2. **When the website asks a helper**: Ask me first (safe), or start without asking.
3. **Docker**: its own private Docker (safe), none, or the computer's Docker (full control: type `root-equivalent`).
4. **Publishing your apps**: Ask me first, or never.
5. **Install scripts** of each code project. Starts at No.
6. **Video transcripts**: yt-dlp in the runner's own folder (Yes). Later: `guildwise-runner extras install yt-dlp`.

Lines 1 and 5 are left out when the server offers nothing. You can change all of this later on the [Approvals page of the computer](#approvals-page), except Docker, which needs a terminal. Scripted installs use `--devops-orgs`, `--devops-requests ask|auto`, `--allow-scripts`, `--with-ytdlp` or `--no-ytdlp`.

The rest of what setup settles:

- **Runner user**: a dedicated `guildwise-runner` user (Linux, macOS) or a dedicated WSL distribution (Windows), or your own user.
- **Own clones**: the runner works only in its own clones under its home folder, never in your folders. You get its work through git.
- **DevOps organizations**: which organizations the DevOps engineer may serve. Each starts as No; the server's list is only a suggestion.
- **Docker**: by default the runner gets its own rootless Docker (one per runner, never shared). If Docker is already installed and not rootless, the installer says "Docker detected, not running in rootless mode" and lets you choose: a separate rootless Docker for the runner (recommended), or the installed Docker, which gives the runner root-equivalent power, so you type `root-equivalent` (or pass `--docker host --accept-root-equivalent`). A rootless Docker of another user that is already running can be shared after you type `shared-daemon` (or pass `--docker shared --docker-socket <path> --accept-shared-daemon`); runners that share a daemon can each control the other's containers. On a Mac the installer uses Docker Desktop, after a warning that containers can read and write the folders Docker Desktop shares (by default all of /Users), and waits for you to install it from https://www.docker.com/products/docker-desktop/ if it is missing. On Windows the runner has its own engine inside its WSL distribution.
- **No sudo**: the runner never gets sudo. The installer asks for your password once and does all root work in that one go: it installs a baseline (build tools, git, curl, unzip, the libraries headless Chromium and Playwright need, fonts, the rootless Docker prerequisites), creates the runner user and sets up Docker. Use `--skip-baseline` if you manage packages yourself. The DevOps engineer installs stack tools (Node, Python, .NET, Java, Go, Rust, Android SDK, ...) only in the runner's own home, each checked against the vendor's checksum. Other system packages are your job: the runner tells you the exact command.
- **GitHub is optional**: nothing in the installer or setup asks for GitHub. Repositories and setup can come through Guildwise; `gh auth login` is only for GitHub repositories.
- **Deploy approvals**: the default for new deploy scripts.

Steps that need root are printed as `sudo /usr/local/lib/guildwise/guildwise-admin ...`. `guildwise-admin` is owned by root, installed from the verified package, and the runner can never change it. For an offline install, download the package, verify it yourself and run the installer with `--from-file`. Otherwise the installer script comes from your server and you trust it the first time. The macOS dedicated user and the Windows distribution are not yet tested on hardware.

## Approvals on the workstation {#approvals}

The runner no longer believes everything the server sends. Some things are held until you say yes on the machine, in a terminal:

- `guildwise-runner pending` lists held items.
- `guildwise-runner approve <id>` approves one (add `--pin` to pin it). `guildwise-runner deny <id>` refuses it.

Held: new deploy scripts (unless a pin matches the exact script, environment, folder and target), recipe writes, vault setup, secret and provider-key reseals, installs that need extra paths, release signing, and every DevOps task not started on that machine. **Deploy pins** bind a deploy script to its exact command; `guildwise-runner deploy pin-commit` also binds an unattended redeploy to one commit, because otherwise it builds whatever is on the branch.

**Install scripts per repository.** Only package installs known to run no project code run by themselves (npm, pnpm, Yarn, Composer with scripts off, `go mod download`, `cargo fetch`). Others (Bundler, `dotnet restore`, Gradle, Maven, pip) need `guildwise-runner repo allow-scripts` for that repository on this machine.

The workstation page shows what is waiting: setup pending, a start-up refusal with its fix, held items.

**Copy-paste commands.** Each held item shows one plain sentence, the exact command in a grey box and a **Copy** button. Copy it, paste it in a terminal on the workstation and press Enter; the terminal shows what will run and asks again. The website never approves for you. A Guildwise command always starts with `sudo -u guildwise-runner` or with the runner's own path (ending in `guildwise-runner`). If a command looks different, do not paste it.

### Approvals on this computer {#approvals-page}

Each workstation runs a small private page, **Approvals on this computer**, at an address starting with `127.0.0.1` (always "this very computer"). It opens only on that computer. The installer opens it at the end; the **Open Approvals on this computer** link on the Workstations page does too.

- **Pair the browser once.** Click **Pair this browser**, copy the command (like `guildwise-runner approvals pair K7M2-Q9`), paste it in a terminal on that computer, check the fingerprint matches, and type `yes`. The code works for 10 minutes. `guildwise-runner approvals devices` lists paired browsers; `approvals forget <fingerprint>` removes one.
- **The top bar** names the instance and the server. It is yellow-orange for any instance other than prod, so a test window is never mistaken for the real one.
- **The page** shows this computer's status, **Waiting for your yes** (one item at a time, with full detail; no approve-all), **What this computer allows** (tick boxes) and **Changed only in a terminal** (Docker mode, signing keys and the like, each with its command).
- If another program uses the page's port, the Desk says so. Run `guildwise-runner approvals port <new number>` and pair again.

## Passkey approvals {#passkeys}

The **Approvals** button on a workstation card opens the approvals page. **Waiting for your yes** lists held items. **Approve with passkey** appears for only two kinds: a redeploy at a new commit and a recipe change. Everything else shows the `guildwise-runner approve <id>` command. Grants, DevOps, install scripts and CEO turns always need the machine.

1. Under **Passkeys**, type a name and click **Add a passkey** (**Confirm it's you** is asked).
2. On the machine run `guildwise-runner passkey trust`. The page names the start of the credential id.
3. To remove one, use the browser if it is not yet trusted. A trusted one stays until `guildwise-runner passkey remove` on the machine.

Passkeys work only on the server's public https address. The server never approves anything: the runner verifies each passkey itself.

## Signed runners {#signed-runners}

A signed runner release carries a signature (minisign) over its manifest, and the runner checks it before every update. The server's own check at pairing cannot prove what code runs on a remote machine, so the runner's check is the real protection.

- **Official key**: Guildwise Cloud and the official image use the key published by the project.
- **Your own key**: a self-hosted server can sign its own runner release and trust only that key (`AOM_RUNNER_RELEASE_PUBKEY`). This is optional. See [Open source and self-hosting](/help/open-source-and-self-hosting#security-settings).
- **Setting**: **Platform > Security > Security settings > Only signed runners**. Off by default on self-hosted servers; locked on in Guildwise Cloud. Turning it on unlinks unsigned workstations, which then show **Reinstall required**.
- **Start-up refusal**: when the server says signed runners are required, or when setup asks for it, the runner refuses to start (exit code 78, shown on the workstation page) if its user is root-equivalent (root, passwordless sudo, the docker group, the socket of another Docker daemon it can write) or its files are writable by others. Its own rootless Docker never counts, and a shared rootless daemon you accepted at install only shows a warning. Fix it and start again; see [Troubleshooting](/help/troubleshooting#exit-78). With the setting off, a self-updated runner only warns.
- To sign a release for one deploy environment, see [Signing the runner per environment](/help/phases#runner-signing).

## Unpairing {#unpairing}

If a workstation goes away (you sold the computer, decommissioned a server), go to **Workstations** and click **Unpair** on its card, then confirm. Its runner token stops working and the runner shuts down, cards claimed there go back to the queue, and its agents stay on it until you retire it or move them. To use the machine again, pair it with a new code.

## Retiring a workstation {#retiring}

Owners and Admins can click **Retire** on a workstation's card to hand its agents over before it goes. Choose **Move its agents to another workstation** (pick the new one in the list) or **Mark its agents as needing a new home** (they show the Re-home action on the Agents page). Retiring also unpairs the computer, retires its DevOps engineer, and sends cards whose work lived there back to start from the base branch. It is refused while one of its agents is in a shift; the dialog names them, and you can check again when they finish. A workstation you already unpaired that still holds agents is listed under **Removed workstations with agents**: use **Hand over agents** there.
