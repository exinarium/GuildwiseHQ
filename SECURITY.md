# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

**https://github.com/exinarium/GuildwiseHQ/security/advisories/new**

Include:

- the affected version or commit, and whether it is a self-hosted install or Guildwise Cloud;
- the steps to reproduce, or a proof of concept;
- the impact as you understand it;
- whether you intend to publish, and when.

Never commit credentials: the test fixtures contain only placeholders. If you find a real secret in the repository history, report it the same way.

Do not include real personal data, real credentials or secrets from a live system in your report. Use a test installation.

## What to expect

- We read every report and try to respond. We do not guarantee a response time; the project is maintained on a best-effort basis (see [GOVERNANCE.md](GOVERNANCE.md)).
- We aim to fix confirmed vulnerabilities **within four weeks** of the report, and we coordinate the public disclosure with you so that it follows the fix.
- We credit reporters in the advisory and the changelog unless you ask us not to.

## Supported versions

Only the **latest release** receives security fixes. Upgrade to it to get fixes. The `main` branch is not a supported release.

## Scope

In scope: the code in this repository, including the server, the web app, the runner and the installers, and the default deployment files (`docker-compose.prod.yml`, `deploy/Caddyfile`, `Dockerfile`).

Out of scope:

- your own infrastructure, your own configuration choices and your own backups (self-hosters are responsible for their deployment; see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md));
- third-party services, such as Anthropic, git hosts, SMTP providers and payment providers;
- findings that need a user to install malicious software on their own machine, unless the runner's protections were bypassed.

## Safe testing

Test only against systems you own or are allowed to test. Do not run tests against Guildwise Cloud data belonging to other people.
