---
title: Two-factor login
summary: Setting up two-factor authentication, recovery codes, enforcement, recovery by email and member resets.
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

Save them somewhere safe: a password manager, a printed list, or a secure note. The panel shows how many recovery codes are left, and **New recovery codes** makes a fresh set (the old ones stop working). If you lose your phone and your recovery codes, you can still recover by email (see [Recovery by email](#recover-by-email)).

## Enforcement {#enforcement}

The Owner can require two-factor login for everyone in the organization. This means every Member and Admin must set it up themselves. You need it on your own account first, otherwise the switch refuses.

When enforcement is on, anyone who has not yet set up two-factor login is held at the setup screen at their next visit and cannot continue until they do.

The same requirement can be set for the whole server: see [Require two-factor login](/help/account-security#enforcement). It is off by default and locked on in Guildwise Cloud.

To turn on organization enforcement, go to **Organization** (bottom of the sidebar) > **General** and switch on **Require two-factor login**. Only the Owner sees it as changeable.

## Turning off {#turning-off}

To turn off two-factor login on your own account:

1. Go to **Settings** and find the **Two-factor login** panel.
2. Click **Turn off**.
3. Enter your password and a code from your app, then confirm.

If your organization has enforcement turned on, you cannot turn it off. The button is greyed out (it shows **Required**) until the Owner turns off enforcement.

## Recovery by email {#recover-by-email}

If you lost your authenticator and your recovery codes, do this on the sign-in page:

1. Enter your email and password. The password must be right first.
2. At the code step choose **Lost your authenticator and your recovery codes?**
3. Open the link we mail you. It works for 24 hours.
4. The page then says **Waiting 24 hours for your safety**. After the wait your two-factor login is removed and you sign in with your password.

You and the Owners of your organizations are mailed when it starts (platform administrators too if you own an organization). Anything that shows it is you cancels it: signing in with a code or a recovery code, or **Cancel: this was not me** in the mail. You can ask for at most 3 links in 24 hours. If your server requires two-factor login, you set it up again at the next sign-in.

## No platform-administrator reset {#no-super-admin-reset}

Nobody can reset another user's two-factor login, from the Platform area or on the server console: use the email recovery above. Only the platform account's own two-factor login is reset on the server console (`superadmin-reset-password --reset-two-factor`).

## Member reset {#owner-reset}

If a member loses their phone and recovery codes, the Owner can reset their two-factor login. Admins cannot. As Owner:

1. Go to **Organization** > **Members**.
2. Find the person in the list.
3. Open the actions menu on their row and choose **Reset two-factor login**, then **Confirm it's you** (see [Confirm it's you](/help/account-security#confirm)).

Rules:

- If the member also has access in another organization (a personal organization counts), the reset is refused: "member_has_other_access". The member recovers it themselves with [recovery by email](#recover-by-email).
- The reset is not instant. It starts the same 24 hour wait, and the member gets a mail with a cancel link. After the wait they sign in with their password and set up two-factor login again.
