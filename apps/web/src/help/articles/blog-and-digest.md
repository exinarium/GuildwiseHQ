---
title: The blog and the weekly digest
summary: Where to read the Guildwise HQ blog, how to get (or stop) the weekly digest, and how the platform administrator runs the blog.
keywords: [blog, articles, digest, newsletter, unsubscribe, email, api key, blog writer, writer, monthly cap, kill switch, facebook, linkedin, x, twitter, bluesky]
order: 24
---

The Guildwise HQ blog has practical articles on AI agents and AI automation. The articles are written with AI assistance by the blog writer, an automatic job on the Guildwise server, and reviewed before they go public. Every article says so, and the author line is always "The Guildwise HQ team".

## Reading the blog {#reading}

- Inside the app, open **Help** and choose the **Blog** tab. You read the articles without leaving your work, and the search box on the Help centre also finds them under **From the blog**.
- On the public site, go to `/blog`. You can follow the **RSS** feed at `/blog/rss.xml`, and every article has a share link.

## The weekly digest {#digest}

Once a week, on Monday at 08:00 (Johannesburg time), you can get one email with the new articles. In a week with nothing new, nothing is sent.

- **Owners** of an organization get it unless they turn it off.
- **Everyone else** only gets it if they ask for it: tick the box when you accept an invitation, or turn it on in **Settings**.
- People whose organizations are all suspended are not mailed.
- Every digest has an **Unsubscribe** link, and your mail program may show its own unsubscribe button. The link opens a page where you press **Unsubscribe from the weekly digest** to confirm (or **Keep me subscribed**); opening the link alone changes nothing. You do not have to sign in. You can subscribe again from the page that follows, or in Settings.

To change your choice yourself, open **Settings** and use **Weekly blog digest**.

## Running the blog (platform administrator) {#platform-blog}

This part is for the platform administrator. The blog is managed under **Blog** and **API keys** in the platform area.

1. **Writer.** The **Writer** panel on the Blog page runs the blog for you. Switch it on (it is **off** by default) and it writes one or two articles a day (08:00 and 15:00, Johannesburg time): it takes the next topic from your list, researches it on the web, writes the article and sends it into the review queue. It uses the platform's Anthropic key (the one the landing assistant uses), so no workstation or agent is involved. You set:
   - **Articles per day** (1 or 2), the **topics** (one per line; it rotates through them and avoids what the blog already covers), and the **model** (Claude Haiku 4.5 by default).
   - The **monthly cap** in US dollars (default $10). The panel shows this month's spend, the number of runs and the cost of each run (tokens and web searches). Before each article the writer checks that this month's spend plus one more article fits under the cap; if not, it skips the article and you get one email that month.
   - **Write one now** writes an article straight away, even while the writer is off. It respects the cap and the blog kill switch, and shows you the queued article.
   - A model whose price is not known cannot be used until you enter its input and output price, so the cap stays meaningful.

   If a run fails (for example the article did not pass the checks, or the Anthropic service was unreachable) the panel shows the reason under *Last run*; the tokens that were used are still counted.
2. **API keys.** Only needed for outside tools that post through the blog API: create a key with the scopes it needs (`blog:write` is enough to submit posts). The key is shown once. Revoke it at any time. Each request is listed under *Recent requests*.
3. **Review queue.** Every post arrives *In review*. Open it to see it exactly as it will look, edit it, then **Approve and publish**, or **Reject** with a reason (an outside tool sees the reason and can revise; for the built-in writer the reason helps you decide what to change in the topics).
4. **Moderation.** You review every post for the first two weeks. After the date you set under *Auto-publish starts on*, a post that raised no warning publishes by itself once it has waited the *hold* (3 hours by default). Posts that were already waiting when that date arrives are released too, if they raised no warning: they publish after the same hold, counted from that date. Posts with a warning (for example links that are not in the sources) always wait for you.
5. **Kill switch.** *Switch the blog off* stops the writer and API tools creating posts and stops all publishing, the digest and social posts. Public articles stay readable. Switch it on again to carry on.
6. **Weekly digest.** Switch it on or off, send a test to yourself, and see what each week did.
7. **Social sharing.** Connect the Facebook Page, the LinkedIn organization, X and Bluesky. Published articles are shared automatically, with retries, using a caption per network (the article summary when a caption is missing). For X you paste four values from a developer app with "Read and write" access (API key, API secret, access token, access token secret; X charges for API use, so keep credit on the account). For Bluesky you paste the handle and an app password from Settings, App passwords. If a credential is refused, credit runs out or a token is about to expire you get an email, and sharing for that network pauses until you paste new values. Unpublishing an article does not remove what was already shared.

The blog API for outside tools is described in `docs/BLOG-API.md`.
