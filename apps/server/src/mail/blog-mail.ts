import { blogTagLabel, type PublicBlogPost } from '@aom/shared';
import { brandedMail, esc, type MailBlock } from './layout.ts';
import type { MailMessage } from './mailer.ts';

/** Mails of the blog: the weekly digest and the alert about a social network. */

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

export const YOUTUBE_AUDIT_FORM_URL = 'https://support.google.com/youtube/contact/yt_api_form';

export function socialAlertMail(opts: {
  to: string;
  network: string;
  reason: string;
  origin: string;
}): MailMessage {
  const name =
    { facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', youtube: 'YouTube' }[
      opts.network
    ] ?? opts.network;
  const video = opts.network === 'youtube';
  return brandedMail({
    to: opts.to,
    subject: video ? 'YouTube uploads need attention' : `Blog sharing to ${name} needs attention`,
    preheader: video ? 'YouTube uploads are paused or failing' : `${name} sharing is paused or failing`,
    heading: video ? 'YouTube uploads need attention' : `${name} sharing needs attention`,
    origin: opts.origin,
    body: [
      video
        ? 'Uploading approved videos to YouTube is not working, so they wait in the queue.'
        : `Sharing blog posts to ${name} is not working, so new articles are not being posted there.`,
      { facts: [['Problem', opts.reason]] },
      video
        ? 'Open the platform blog settings, paste a fresh refresh token for the YouTube channel and the waiting videos are uploaded.'
        : 'Open the platform blog settings, reconnect the account and the waiting posts are shared (those published in the last 48 hours).',
    ],
    cta: { label: 'Open the social settings', url: `${opts.origin}/platform/blog` },
  });
}

/** YouTube kept an uploaded video private: the API project has not passed the compliance audit. */
export function videoLockedMail(opts: {
  to: string;
  title: string;
  videoUrl: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: 'YouTube kept an uploaded video private',
    preheader: 'The API project needs the YouTube compliance audit',
    heading: 'A video was uploaded but is private',
    origin: opts.origin,
    body: [
      'YouTube locks videos uploaded through an API project that has not passed the compliance audit to private. The video was uploaded and is waiting in YouTube Studio; it will not become public by itself and no more videos are uploaded until you decide.',
      {
        facts: [
          ['Video', opts.title],
          ['YouTube', opts.videoUrl],
        ],
      },
      `Request the audit with Google's form (${YOUTUBE_AUDIT_FORM_URL}), or make the video public by hand in YouTube Studio.`,
    ],
    cta: { label: 'Open the video queue', url: `${opts.origin}/platform/blog?tab=videos` },
  });
}

/** Something about the video schedule needs the owner (a slipped slot, an offline render worker, a full disk). */
export function videoAlertMail(opts: {
  to: string;
  heading: string;
  reason: string;
  origin: string;
}): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: opts.heading,
    preheader: opts.reason.slice(0, 100),
    heading: opts.heading,
    origin: opts.origin,
    body: [{ facts: [['What happened', opts.reason]] }],
    cta: { label: 'Open the video queue', url: `${opts.origin}/platform/blog?tab=videos` },
  });
}

/** The blog writer stopped for the month: its spend plus one more run would pass the monthly cap. */
export function writerCapMail(opts: { to: string; reason: string; origin: string }): MailMessage {
  return brandedMail({
    to: opts.to,
    subject: 'The blog writer reached its monthly cap',
    preheader: 'No more articles are written until next month or until you raise the cap',
    heading: 'The blog writer reached its monthly cap',
    origin: opts.origin,
    body: [
      'The blog writer skipped a scheduled article because it would pass its monthly spending cap. It writes nothing more this month unless you raise the cap. You get this notice once a month.',
      { facts: [['Why', opts.reason]] },
    ],
    cta: { label: 'Open the blog writer', url: `${opts.origin}/platform/blog` },
  });
}
