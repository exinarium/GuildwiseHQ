# Design: sending support mail from the support address

Owner's request: "If the email is support@guildwisehq.com that sends the auto respond, the super user comments on the ticket should be sent from that email."

## Current state

- One transport, one From: `createMailer(AOM_SMTP_URL, AOM_MAIL_FROM)` (`mail/mailer.ts`). Default `Guildwise HQ <noreply@aom.local>`; production sets it to a `noreply@` address. There is no envelope-sender override: nodemailer derives the SMTP envelope sender (MAIL FROM / Return-Path) from the From address.
- The autoresponder (`supportReceivedMail`) and the super admin's ticket reply (`supportReplyMail`, `replyToTicket`) both go out From `AOM_MAIL_FROM` with `Reply-To` = the first address of the platform setting `support_email` (else `AOM_SUPPORT_EMAIL`). So the customer sees `noreply@...` as sender and a reply lands in the support mailbox, not in the ticket.
- The notifications to staff (`supportNewMail`, `supportFollowUpMail`,) go From `AOM_MAIL_FROM` with Reply-To = the customer.
- No Message-ID, In-Reply-To or References are set (nodemailer generates a random Message-ID), so mail programs thread only by subject (`Re: [SUP-123] ...`). There is no inbound mail: the ticket only learns of the customer's answer through the web form (signed-in users) or not at all (visitors).

## Built (small, safe)

`AOM_SUPPORT_FROM` (optional, e.g. `Guildwise HQ Support <support@guildwisehq.com>`). When set, the autoresponder and the super admin's replies use it as From (`MailMessage.from` overrides the mailer's From for that message). Unset: unchanged behaviour. Staff notifications and all other mail keep `AOM_MAIL_FROM`. Tests: `apps/server/test/support-from.test.ts`. Not built: using the `support_email` setting itself as From (see recommendation), threading headers, inbound mail.

## What the owner must do before setting it

Sending as `support@guildwisehq.com` only works if the relay accepts that sender and receivers can authenticate it, or mail is rejected or lands in spam.

1. **Relay allows the sender.** The account behind `AOM_SMTP_URL` must be allowed to send as `support@guildwisehq.com`:
   - Google Workspace SMTP relay or smtp.gmail.com: the address must be the account or a verified "Send mail as" alias; otherwise Google rewrites From to the account.
   - Microsoft 365: the mailbox needs "Send As" permission on the support mailbox (a shared mailbox works), SMTP AUTH enabled for the account; otherwise it is rejected or rewritten.
   - Amazon SES: verify the domain `guildwisehq.com` (Easy DKIM) or just the address; leave the sandbox; any address on a verified domain may be used.
   - Postmark: add and confirm a Sender Signature for the address or authenticate the domain (DKIM + Return-Path).
   - Mailgun: add and verify the sending domain (it sends as any address on it).
2. **DNS for `guildwisehq.com`** (one SPF record only, merged):
   - SPF: include the provider (`v=spf1 include:_spf.google.com ~all`, `include:spf.protection.outlook.com`, `include:amazonses.com`, `include:spf.mtasv.net`, `include:mailgun.org`), covering the envelope sender domain.
   - DKIM: publish the provider's DKIM CNAME/TXT records; sign with `d=guildwisehq.com` so it aligns with the From domain.
   - DMARC: `_dmarc.guildwisehq.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@guildwisehq.com"` first, tighten to `quarantine` after a clean week. DMARC passes when SPF or DKIM passes and aligns with the From domain; with a third-party relay, DKIM alignment is the reliable one (SPF often aligns only if a custom Return-Path/MAIL FROM domain on `guildwisehq.com` is configured).
3. Set `AOM_SUPPORT_FROM="Guildwise HQ Support <support@guildwisehq.com>"` in the production env, send a ticket to yourself and check the headers (`Authentication-Results`: spf=pass, dkim=pass, dmarc=pass) in Gmail's "Show original".
4. The support mailbox should exist (customers will reply to it). With From = support@, drop the separate Reply-To or keep it identical.

## Threading

To make the customer see one conversation, add to every mail of a ticket: a stable `Message-ID` per message (`<SUP-123.<message-uuid>@guildwisehq.com>`), `In-Reply-To` the previous message of the ticket and `References` the chain, and a constant subject core `[SUP-123]`. Effort: about half a day (store the Message-ID per `support_messages` row, extend `MailMessage` with `headers`, tests). Without it the existing `Re: [SUP-n] subject` subject keeps most clients threading acceptably.

## Customer replies coming back into the ticket (inbound)

Today a reply by email reaches only the support mailbox. Options:

- **Provider inbound webhook** (Postmark Inbound, Mailgun Routes, SES + SNS/S3, SendGrid Inbound Parse): MX of a `reply.guildwisehq.com` subdomain (or the plus-addresses) to the provider, which POSTs parsed JSON to `POST /api/support/inbound` (signed). Best fit: no polling, handles attachments. Effort: 2 to 3 days.
- **IMAP polling** of the support mailbox (Google/M365): a scheduler job reads unseen mail, matches it to a ticket, marks it read. Works with any mailbox, but needs credentials stored as secrets, OAuth for Google/M365 (basic auth is going away), and is slower. Effort: 3 to 4 days.
- **Matching**: a plus-address `support+SUP-123@guildwisehq.com` as Reply-To (survives clients that drop subjects; Google Workspace and M365 support plus-addressing) plus a fallback match on `[SUP-123]` in the subject and on `In-Reply-To`. Verify the sender equals the ticket's contact email (or the ticket's user), strip quoted history and signatures, ignore auto-replies (`Auto-Submitted`, `Precedence: bulk`, empty Return-Path) so an out-of-office never loops with the autoresponder, and add the message as a `user` message that reopens the ticket (same effect as `userFollowUp`).
- This also changes the autoresponder note "nothing more is needed from you" and the rule "there is no inbound mail" in `supportReceivedMail`.

## Recommendation

1. Do the DNS/provider checklist, then set `AOM_SUPPORT_FROM` (already built, safe to deploy first: unset is unchanged).
2. Add the threading headers (half a day) together with Reply-To `support+SUP-n@...`.
3. Add inbound via a provider webhook when ticket volume justifies it (2 to 3 days); until then replies go to the support mailbox and are answered from the inbox UI.
4. Keep `support_email` (where staff are notified) separate from the From address: the From is deployment config tied to DNS, the notification list is an operator preference that can hold several people. Using the setting as From would let a typo in the UI break deliverability.
