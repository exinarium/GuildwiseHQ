# Design: desk mail to the support address

Owner's request: "When any notification comes to the super user desk (question, report, etc) I want you to send an email to the support email chosen by the user."

## What "the super user desk" is

- A super admin (`users.kind = 'super_admin'`) never joins an organization and is refused by the app routes (`super_admin_platform_only`); the platform area deliberately shows organization metadata only. So **a super admin has no desk**, and there is no platform-level desk.
- The desk the operator works is the desk of their own **organizations** (as Owner or Admin, signing in with a normal account). Org-level and project items land there: questions, approvals, escalations, alerts, ratings (`desk_items.kind`).
- Chosen interpretation: **every new desk item on a desk the operator works** is mailed to the support address. The operator's desks are the organizations that have an active Owner or Admin whose login email is one of the support addresses (scope `operator`, the default). Scope `all` mails every organization's items; it is opt-in because it puts customers' item titles into the support mailbox, against the "metadata only" rule of the platform area.
- Support requests themselves (Contact us) already have their own mail to the same address and are not desk items.

## Behaviour

- Trigger: a polling pass (`deskMailTick`, scheduler, every 15 s) outside the event append transaction. It looks at `desk_items` with no row in `desk_mail_log`.
- Once only: `desk_mail_log(desk_item_id PK, state, batch_id, mailed_at)`, no foreign key and not a projection. The row is claimed (`ON CONFLICT DO NOTHING`) before sending, so two servers never both mail an item, and a projection rebuild (which re-creates `desk_items`) or a reboot never re-sends. A failed send (no address accepted the mail) releases the claim and is retried next pass. The migration marks every existing item as seen. Edits never mail (no event hook, only creation is observed). A re-opened item is not mailed.
- An item is skipped (marked `skipped`, never mailed later) when: desk mail is off, there is no address, it is below the minimum priority, out of scope, no longer open, or more than 6 hours old when first seen. Items still in triage wait until triage ends.
- Address: platform setting `support_email` (comma list), else `AOM_SUPPORT_EMAIL`; none means nothing is sent. Settings: `desk_mail_enabled` (default on), `desk_mail_min_priority` (`all`, `pinned`, `blocking`), `desk_mail_scope` (`operator`, `all`); `GET/PATCH /api/platform/settings`, Support page form.
- Throttle: up to 3 new items in one pass get one mail each; more are sent as ONE digest (up to 25 listed, "and N more"); at most 20 mails (a digest counts as one) per hour, the rest waits and is dropped after 6 hours.
- Content: kind, title, organization, project, priority (Normal / Urgent (pinned) / Blocking), a 280-character summary and a button to `<public origin>/desk#desk-item-<id>`. Credentials in the text (tokens, `password=...`, `Bearer ...`) are redacted; `data`, options and context are never included.
