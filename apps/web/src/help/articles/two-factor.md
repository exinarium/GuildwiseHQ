---
title: Two-factor login
summary: Setting up two-factor authentication, recovery codes, enforcement and owner reset.
keywords: [two-factor, 2FA, authentication, recovery codes, security]
order: 3
---

Two-factor login adds a second step to signing in: after your password, you enter a code from an authenticator app on your phone. This makes it much harder for someone to access your account.

## Setting up {#setting-up}

To set up two-factor login on your own account:

1. Go to **Settings** (bottom of the sidebar) and find the **Two-factor login** panel.
2. Click **Set up** and enter your password.
3. Open an authenticator app on your phone (for example Google Authenticator, Authy or Microsoft Authenticator).
4. Scan the QR code shown, or type the code manually if scanning does not work.
5. Type the 6-digit code from your authenticator app.

Two-factor login is now active on your account. The next time you sign in, after your password you will be asked for the code.

## Recovery codes {#recovery-codes}

When you turn on two-factor login, you receive ten recovery codes, shown once. Each code can be used once if you lose your phone or cannot access your authenticator app.

Save them somewhere safe: a password manager, a printed list, or a secure note. The panel shows how many recovery codes are left, and **New recovery codes** makes a fresh set (the old ones stop working). If you lose your phone and your recovery codes, you cannot sign in unless the Owner or a platform administrator resets your two-factor login.

## Enforcement {#enforcement}

The Owner can require two-factor login for everyone in the organization. This means every Member and Admin must set it up themselves. You need it on your own account first, otherwise the switch refuses.

When enforcement is on, anyone who has not yet set up two-factor login is held at the setup screen at their next visit and cannot continue until they do.

To turn on enforcement, go to **Organization** (bottom of the sidebar) > **General** and switch on **Require two-factor login**. Only the Owner sees it as changeable.

## Turning off {#turning-off}

To turn off two-factor login on your own account:

1. Go to **Settings** and find the **Two-factor login** panel.
2. Click **Turn off**.
3. Enter your password and a code from your app, then confirm.

If your organization has enforcement turned on, you cannot turn it off. The button is greyed out (it shows **Required**) until the Owner turns off enforcement.

## Owner reset {#owner-reset}

If someone loses their phone and recovery codes and cannot sign in, the Owner (or a platform administrator, under Accounts) can reset their two-factor login. Admins cannot. As Owner:

1. Go to **Organization** > **Members**.
2. Find the person in the list.
3. Open the actions menu on their row and choose **Reset two-factor login**.

The person can then sign in with their password and set up two-factor login again at their next sign-in.
