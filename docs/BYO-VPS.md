# Bring your own VPS

Run your agents on any Linux server you rent, with your own cloud account and your own Claude key. Guildwise HQ installs its runner there over SSH and pairs it for you. You pay the VPS company directly; Guildwise adds no charge. Companion to `docs/RUNNER.md` ("Cloud workstations") and `docs/SELF-HOSTING.md`.

## What to rent

| Need | Suggestion |
| --- | --- |
| Operating system | Ubuntu 22.04 or 24.04, Debian 12 (anything with apt, dnf or pacman works; apt is best tested) |
| Size | 2 vCPU and 4 GB RAM runs one or two agents at a time; 4 vCPU and 8 GB for four. Disk 40 GB or more |
| Where | Any provider with SSH access. Pick a region close to you and, for POPIA, one that suits where your code may live (for example AWS `af-south-1` Cape Town, Azure South Africa North, or a European Hetzner region) |
| Price | Typically 5 to 25 US dollars a month. Enter it on the form so the page can show an estimate |
| Not suitable | A server that only offers a web console, or where you cannot use `sudo` |

Android emulators and iOS builds need more than a small VPS: the emulator needs KVM, and iOS needs a Mac. Keep one workstation of yours for those.

## Before you start

1. Create a normal user with sudo rights (safer than `root`):
   `adduser deploy && usermod -aG sudo deploy`
2. Make sure you can log in over SSH with a password or a key. The installer does not need any inbound port other than SSH, and the runner only makes **outbound** connections to Guildwise HQ.
3. Have your repositories' access ready on the server later (an SSH key or a token for your git host). Credentials for git stay on the server.

## Add it

1. **Workstations**, then **Add a workstation**, then **A VPS (SSH)**.
2. Enter the address, port, user and password or key. Click **Install and pair**.
3. Wait for the card to say **Running** (a few minutes). The password or key was used for that one login and is not stored. Guildwise keeps only the server's public host key fingerprint.

If the key has a passphrase, enter it too. If the install fails, the card says why (login refused, no space, no sudo); fix it and add again.

## Sign in to Claude on the server

The recommended way is your own Anthropic API key. It stays on the server; Guildwise never receives or stores it.

```bash
ssh deploy@your-server
read -rs K; printf %s "$K" | aom-runner auth api-key
systemctl --user restart aom-runner
```

A subscription login also works (`claude`, then follow the prompts). It is meant for one person's own use: many agents in parallel can hit its limits, so use an API key for a team.

## Add your code

```bash
aom-runner repos add ~/src
```

The DevOps engineer clones the project repositories onto the server when you add a repository in the project settings. Set up the git host connection (SSH key or token) on the server as you would on a laptop.

## Start, stop and cost

A VPS bills the same every month whether or not agents work. Guildwise does not know your provider's API, so **start and stop are manual**: switch the server off at your provider when you do not need it, and on again when you do (the runner starts by itself at boot and reconnects). Cloud workstations that Guildwise can start and stop on its own are GitHub Codespaces.

## Docker deploys

A VPS can run Docker, so it can be the target of Docker deploys: install Docker on it (`curl -fsSL https://get.docker.com | sh` and add your user to the `docker` group), then choose this workstation in the project's deploy target.

## Reinstall, move or remove

- **Reinstall**: remove the cloud workstation on the Workstations page and add it again. The installer keeps what works.
- **Remove**: unpairs the runner and forgets the record. The server itself keeps running until you cancel it at your VPS company.
- **A changed host key** (you rebuilt the server) is refused until you remove and add it again, so nobody can quietly stand in for your server.

## Unattended pairing without the wizard

For provisioning scripts, cloud-init or a boot unit, the runner pairs by itself when started with a one-time code from the Workstations page (Pair workstation):

```bash
GUILDWISE_SERVER=https://app.example.com GUILDWISE_PAIR_CODE=ABCD-EFGH GUILDWISE_NAME="Build server" aom-runner up
```

`aom-runner up` is safe to run at every boot: if the machine is already paired with that server it just connects (the single-use code is ignored). `ANTHROPIC_API_KEY` in the environment is stored in the runner's config (mode 0600) the same way as `aom-runner auth api-key`.
