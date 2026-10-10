import { blogTagLabel, type PublicBlogPost } from '@aom/shared';
import { brandedMail, esc, type MailBlock } from './layout.ts';
import type { MailMessage } from './mailer.ts';

/** Mails of the blog: the weekly digest and the alert about a social network (docs/design/blog-prd.md). */

const utm = (url: string, campaign: string) =>
  `${url}${url.includes('?') ? '&' : '?'}utm_source=digest&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}`;

export function digestMail(opts: {
  to: string;
  name: string;
  digestId: string;
  posts: PublicBlogPost[];
  origin: string;
  unsubscribeUrl: string;
}): MailMessage {
  const n = opts.posts.length;
  const body: MailBlock[] = [
    `Hello ${opts.name || 'there'}, here ${n === 1 ? 'is the new article' : `are the ${n} new articles`} from the Guildwise HQ blog this week.`,
  ];
  for (const p of opts.posts) {
    const link = utm(p.url, opts.digestId);
    body.push({
      html: `<strong><a href="${esc(link)}" style="color:#3446d9">${esc(p.title)}</a></strong><br>${esc(p.summary)}<br><span style="font-size:13px;color:#4b5365">${esc(p.tags.map(blogTagLabel).join(', '))} &middot; ${p.readingMinutes} min read</span>`,
      text: `${p.title}\n${p.summary}\n${link}`,
    });
  }
  body.push({
    small:
      'You get this mail because you are an Owner of a Guildwise HQ organization or asked for it in your settings. Guildwise HQ, guildwisehq.com.',
  });
  const mail = brandedMail({
    to: opts.to,
    subject:
      n === 1
        ? `New on the Guildwise HQ blog: ${opts.posts[0]?.title}`
        : `${n} new articles on the Guildwise HQ blog`,
    preheader: opts.posts[0]?.summary ?? 'New articles on AI agents and automation',
    heading: 'New on the Guildwise HQ blog',
    origin: opts.origin,
    body,
    cta: { label: 'See all articles', url: utm(`${opts.origin}/blog`, opts.digestId) },
    note: `Do not want these mails? Unsubscribe: ${opts.unsubscribeUrl}`,
  });
  return {
    ...mail,
    headers: {
      'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export function socialAlertMail(opts: {
  to: string;
  network: string;
  reason: string;
  origin: string;
}): MailMessage {
  const name = opts.network === 'facebook' ? 'Facebook' : 'LinkedIn';
  return brandedMail({
    to: opts.to,
    subject: `Blog sharing to ${name} needs attention`,
    preheader: `${name} sharing is paused or failing`,
    heading: `${name} sharing needs attention`,
    origin: opts.origin,
    body: [
      `Sharing blog posts to ${name} is not working, so new articles are not being posted there.`,
      { facts: [['Problem', opts.reason]] },
      'Open the platform blog settings, reconnect the account and the waiting posts are shared (those published in the last 48 hours).',
    ],
    cta: { label: 'Open the social settings', url: `${opts.origin}/platform/blog` },
  });
}
