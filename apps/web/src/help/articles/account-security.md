---
title: Account security
summary: Sign-in protection and locks, password reset with a code, security mails, Confirm it's you, requiring two-factor login and the platform Security page.
keywords: [security, lockout, locked, too many attempts, password reset, reset code, recovery code, new device, confirm it's you, step-up, require two-factor, enforcement, block list, failed sign-ins, super admin]
order: 4
---

Guildwise HQ protects sign-in with limits, mails and a few extra checks. Most of them are on for everyone and need nothing from you. This page explains what you may notice. Two-factor setup is in [Two-factor login](/help/two-factor).

## Sign-in protection {#lockout}

Wrong answers are counted: a wrong password, a wrong two-factor code, a wrong answer to **Confirm it's you** and a wrong password reset code.

- **Account lock.** After 5 failures on one address, sign-in pauses for 15 minutes. Each further lock doubles the pause, up to 60 minutes. An address that does not exist behaves the same, so nobody can tell which addresses have accounts.
- **Address lock.** 20 failures from one internet address in 15 minutes pause that address for 15 minutes. 100 failures in 24 hours pause it for 24 hours. Private, loopback and proxy addresses are never locked this way.
- You see "Too many attempts" with the time to wait (the server answers 429 `too_many_attempts`).

What still works during a lock:

- A browser that already signed in to that account in the last 30 days, from the same address and browser family, can still sign in. The person who owns the account is not shut out by someone guessing their address.
- A completed [password reset](#reset) clears the lock.

Every sign-in, good or bad, is recorded for the platform administrators (see [the Security page](#security-page)).

## Password reset needs a code {#reset}

Use **Forgot your password?** on the sign-in page. If your account has two-factor login, the reset page also asks for a code: a 6-digit code from your authenticator app, or one of your recovery codes. Someone who only has your mailbox cannot take the account.

- The page shows how many tries are left. After 5 wrong codes the link stops working and you ask for a new one.
- At most 5 reset links per account in 24 hours. Beyond that nothing is sent, and the page looks the same.
- A completed reset signs you out everywhere and clears any sign-in lock.

If you have lost both your authenticator and your recovery codes, see [recovery by email](/help/two-factor#recover-by-email).

## Security mails {#mails}

You are mailed when something sensitive happens on your account:

- **Account locked** (at most once per account per 24 hours).
- **Right password, wrong code**: someone knew your password but not your second step (at most once an hour).
- **Password changed**, with the time and internet address. This covers your own change, a reset link and a reset by an administrator.
- **Reset by an Owner, Admin or platform administrator**: names who did it, when and from where. It never contains a temporary password.
- **Sign-in from a new device.** The first sign-in of an account, and the first one after upgrading to 1.10.0, send nothing. A server operator can limit this to platform administrators or switch it off (`AOM_SIGNIN_NOTICES`).

If you did not do it, change your password and your two-factor login at once. Security mails carry no open or click tracking.

## Confirm it's you {#confirm}

Before a sensitive action Guildwise asks **Confirm it's you**: "Enter the 6-digit code from your authenticator app (or a recovery code) to continue." Accounts without two-factor login are asked "Enter your password to continue." After a correct answer the action carries on by itself.

- An answer counts for 10 minutes, so a few sensitive steps in a row ask once.
- 5 wrong answers end the session.
- Asked for: every platform administrator change; showing the workstation sealing key; workstation secrets and provider keys; project Claude and provider accounts; deploy targets and their signing key; organization provider keys; resetting a member's password or two-factor login and **Email a reset link**; adding a passkey; approving an ownership transfer; block list changes; and adding or revoking a render worker.

## Require two-factor login {#enforcement}

The **Require two-factor login** setting forces everyone to use two-factor login on the whole server. It is off by default.

When it is on, someone without two-factor login who signs in sees **Secure your account** ("Set up two-factor login to continue.") and cannot use anything else until it is set up. People whose only organizations are simulations are not asked. Turning your own two-factor login off is refused while it is required. If an email recovery removed your two-factor login, you set it up again at the next sign-in.

- A platform administrator changes it on **Platform > Security > Security settings** (see [below](#security-page)). The tab shows how many users have no two-factor login yet.
- **Guildwise Cloud** has it locked on. The switch is disabled with "Set by Guildwise Cloud; cannot be changed here". Every Cloud sign-up goes: verify your email, set up two-factor login, then billing and your organization. Nothing in an organization is usable before that.
- Self-hosted servers: the default is off. An operator can set `AOM_ENFORCE_TWO_FACTOR=true`. See [Open source and self-hosting](/help/open-source-and-self-hosting#security-settings).
- The Owner's own organization-wide switch is described in [Two-factor login](/help/two-factor#enforcement).

## The platform Security page {#security-page}

Platform administrators (super admins) find **Security** in the **Platform** area. It has four tabs:

- **Failed sign-ins**: recent failures and the locks in force.
- **Sign-ins**: every sign-in with time, address and result.
- **Block list**: domains (subdomains too), exact addresses, internet addresses or ranges, and allowed domains. It is checked at sign-up (Guildwise Cloud), invitation, accepting an invitation, sign-in and password reset. Every change needs **Confirm it's you** and mails every platform administrator.
- **Security settings**: **Only signed runners** and **Require two-factor login**, each with its default and Cloud lock, plus counts of unsigned workstations and users without two-factor login. Every change is recorded in the audit log. Turning **Only signed runners** on while some workstations are unsigned asks you to confirm, because it unlinks them. See [Signed runners](/help/workstations-and-installer#signed-runners).

Platform administrator sessions last at most 8 hours and end after 30 minutes of no use. After the 1.10.0 upgrade platform administrators sign in once more.
