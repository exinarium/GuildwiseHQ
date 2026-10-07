---
title: Two-factor login
summary: Setting up two-factor authentication, recovery codes, enforcement and owner reset.
keywords: [two-factor, 2FA, authentication, recovery codes, security]
order: 3
---

Two-factor login adds a second step to signing in: after your password, you enter a code from an authenticator app on your phone. This makes it much harder for someone to access your account.

## Setting up {#setting-up}

To set up two-factor login on your own account:

1. Go to **Settings > Security**.
2. Enter your password.
3. Open an authenticator app on your phone (for example Google Authenticator, Authy or Microsoft Authenticator).
4. Scan the QR code shown, or type the code manually if scanning does not work.
5. Type the six-digit code from your authenticator app.

Two-factor login is now active on your account. The next time you sign in, after your password you will be asked for the code.

## Recovery codes {#recovery-codes}

When you turn on two-factor login, you receive ten recovery codes. Each code can be used once if you lose your phone or cannot access your authenticator app.

Save them somewhere safe: a password manager, a printed list, or a secure note. If you lose your phone and your recovery codes, you cannot sign in unless the Owner or a platform administrator resets your two-factor login.

## Enforcement {#enforcement}

The Owner can require two-factor login for everyone in the organization. This means all Members and Admins must set it up themselves (the Owner needs it on their own account first).

When enforcement is on, Members who have not yet set up two-factor login are held at the setup screen when they try to sign in and cannot proceed until they do.

To turn on enforcement, go to **Settings > Organization > Security > Require two-factor login for all members** and toggle it on. Every member will be notified.

## Turning off {#turning-off}

To turn off two-factor login on your own account:

1. Go to **Settings > Security**.
2. Click **Turn off two-factor login**.
3. Confirm.

If your organization has enforcement turned on, you cannot turn it off. The Owner must turn off enforcement first.

## Owner reset {#owner-reset}

If someone loses their phone and recovery codes and cannot sign in, the Owner (or a platform administrator) can reset their two-factor login:

1. Go to **Settings > Organization > Members**.
2. Find the person in the list.
3. Click the menu and choose **Reset two-factor login**.

The person can then sign in with their password and set up two-factor login again.
