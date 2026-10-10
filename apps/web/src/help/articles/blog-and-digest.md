---
title: The blog and the weekly digest
summary: Where to read the Guildwise HQ blog, how to get (or stop) the weekly digest, and how the platform administrator runs the blog.
keywords: [blog, articles, digest, newsletter, unsubscribe, email, api key, writer agent, kill switch, facebook, linkedin]
order: 24
---

The Guildwise HQ blog has practical articles on AI agents and AI automation. The articles are written by an AI agent and reviewed before they go public. Every article says so, and the author line is always "The Guildwise HQ team".

## Reading the blog {#reading}

- Inside the app, open **Help** and choose the **Blog** tab. You read the articles without leaving your work, and the search box on the Help centre also finds them under **From the blog**.
- On the public site, go to `/blog`. You can follow the **RSS** feed at `/blog/rss.xml`, and every article has a share link.

## The weekly digest {#digest}

Once a week, on Monday at 08:00 (Johannesburg time), you can get one email with the new articles. In a week with nothing new, nothing is sent.

- **Owners** of an organization get it unless they turn it off.
- **Everyone else** only gets it if they ask for it: tick the box when you accept an invitation, or turn it on in **Settings**.
- People whose organizations are all suspended are not mailed.
- Every digest has an **Unsubscribe** link, and your mail program may show its own unsubscribe button. One click is enough, you do not have to sign in. You can subscribe again from the page that opens, or in Settings.

To change your choice yourself, open **Settings** and use **Weekly blog digest**.

## Running the blog (platform administrator) {#platform-blog}

This part is for the platform administrator. The blog is managed under **Blog** and **API keys** in the platform area.

1. **API keys.** Create a key for the writer agent with the scopes it needs (`blog:write` is enough to submit posts). The key is shown once. Revoke it at any time. Each request is listed under *Recent requests*.
2. **Review queue.** Every post arrives *In review*. Open it to see it exactly as it will look, edit it, then **Approve and publish**, or **Reject** with a reason (the agent sees the reason and can revise).
3. **Moderation.** You review every post for the first two weeks. After the date you set under *Auto-publish starts on*, a post that raised no warning publishes by itself once it has waited the *hold* (3 hours by default). Posts with a warning (for example links that are not in the sources) always wait for you.
4. **Kill switch.** *Switch the blog off* stops agents creating posts and stops all publishing, the digest and social posts. Public articles stay readable. Switch it on again to carry on.
5. **Weekly digest.** Switch it on or off, send a test to yourself, and see what each week did.
6. **Social sharing.** Connect the Facebook Page and the LinkedIn organization. Published articles are shared automatically, with retries. If a token is refused or about to expire you get an email, and sharing for that network pauses until you paste a new token. Unpublishing an article does not remove what was already shared.

The agent API and a ready-made writer prompt are in `docs/BLOG-API.md`.
