# What's new entries

Each file in this folder is one entry of the "What's new in Guildwise HQ" popup. The popup shows a user the entries
they have not seen yet (newest first) after they sign in, and the Help page ("What's new") lists all of them.

Add **one file per user-facing feature**, named `YYYY-MM-DD-short-slug.md`. The file name (without `.md`) is the
entry's id: it is what the server remembers as "seen", so never rename a file after it has shipped.

```
---
title: Short feature name (max 60 chars)
date: 2026-10-10
audience: all        # one of: all | owner | admin | superadmin
help: /help/<article-slug>   # optional deep link to the help article, shown as "Learn more"
---
One to three plain-language sentences: what changed and why it helps. No git jargon.
```

- `audience`: `all` everyone; `owner` Owners only; `admin` Owners and Admins; `superadmin` platform administrators
  only. A user's role in the organization they are working in decides what they see.
- `date`: entries dated before a user's account was created are never shown to that user (they get the tour instead).
- `help`: must start with `/help/`; a `#anchor` is allowed.
- The body supports the same small markdown as the help articles: `**bold**`, `*italic*`, `` `code` ``, links, lists.
- This README is not an entry. The entries are bundled at build time (Vite `import.meta.glob`).
