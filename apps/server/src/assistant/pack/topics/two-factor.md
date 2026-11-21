### Two-factor login
Setting up two-factor authentication, recovery codes, enforcement, recovery by email and member resets.
- Setting up: To set up two-factor login on your own account:
- Recovery codes: When you turn on two-factor login, you receive ten recovery codes, shown once. Each code can be used once if you lose your phone or cannot access your authenticator app.
- Enforcement: The Owner can require two-factor login for everyone in the organization. This means every Member and Admin must set it up themselves. You need it on your own account first, otherwise the switch refuses.
- Turning off: To turn off two-factor login on your own account:
- Recovery by email: If you lost your authenticator and your recovery codes, do this on the sign-in page:
- No platform-administrator reset: Nobody can reset another user's two-factor login, from the Platform area or on the server console: use the email recovery above. Only the platform account's own two-factor login is reset on the server console (superadmin-reset-password --reset-two-factor).
- Member reset: If a member loses their phone and recovery codes, the Owner can reset their two-factor login. Admins cannot. As Owner:
