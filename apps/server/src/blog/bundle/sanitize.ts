import {
  type BlogContent,
  type BundlePost,
  type BundleRelease,
  type BundleShare,
  type BundleVideo,
  markdownLinks,
  renderMarkdownHtml,
  safeHref,
  stripCiteTags,
} from '@aom/shared';
import { contentErrors, contentWarnings } from '../../commands/blog.ts';

/**
 * The content checks of the article carry-over, applied at export and again at import. They mirror the blog renderer
 * (`renderMarkdownHtml`: an allow-list AST, every text escaped, links only http(s) or `/path`, images only uploaded blog
 * media): anything the renderer would have to neutralise blocks the item, so what is carried over renders exactly as written.
 * A body is never rewritten (the renderer strips `<cite>` tags itself, so those are allowed).
 */

export interface Finding {
  /** `post <slug>`, `release <version>`, `video <kind/ref/format>`, `share <post id>/<network>`. */
  item: string;
  /** `block`: the item is not carried over (the export and the import refuse). `record`: listed in the report only. */
  level: 'block' | 'record';
  message: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>/;
const EVENT_ATTR = /\son[a-z]{2,}\s*=\s*["'`]?/i;
const BAD_SCHEME = /\b(?:javascript|vbscript)\s*:|\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i;
const MD_LINK = /\[[^\]\n]+\]\(([^)\s]+)\)/g;
const MD_IMAGE = /!\[[^\]\n]*\]\(/;
const IMG_ALT = /!\[([^\]\n]*)\]/g;

/** Text the renderer shows as-is: raw HTML, handlers and script schemes are refused outright. */
function scanText(where: string, text: string, out: string[]): void {
  if (HTML_TAG.test(text)) out.push(`${where}: raw HTML tag`);
  if (EVENT_ATTR.test(text)) out.push(`${where}: an on*= event handler attribute`);
  if (BAD_SCHEME.test(text)) out.push(`${where}: a javascript:, vbscript: or data: URL`);
}

/** Findings for one article's content. */
export function checkPostContent(item: string, c: BlogContent): Finding[] {
  const blocks: string[] = [];
  const body = stripCiteTags(c.bodyMarkdown);
  scanText('body', body, blocks);
  scanText('title', c.title, blocks);
  scanText('summary', c.summary, blocks);
  for (const m of body.matchAll(MD_LINK))
    if (!safeHref(m[1] as string))
      blocks.push(`body: a link the renderer refuses (${(m[1] as string).slice(0, 80)})`);
  if (MD_IMAGE.test(body) || body.includes('/blog/media/'))
    blocks.push('body: image syntax or blog media (version 1 bundles carry no media)');
  if (CONTROL_OR_BIDI.test(c.title)) blocks.push('title: a control character or bidi override');
  if (CONTROL_OR_BIDI.test(c.summary)) blocks.push('summary: a control character or bidi override');
  for (const m of body.matchAll(IMG_ALT))
    if (CONTROL_OR_BIDI.test(m[1] as string)) blocks.push('image alt: a control character or bidi override');
  if (CONTROL_OR_BIDI.test(c.coverImage.alt)) blocks.push('cover alt: a control character or bidi override');
  // the renderer's own output, as the last word: nothing executable may come out of it
  const html = renderMarkdownHtml(c.bodyMarkdown);
  if (/<script|<iframe|\son\w+=|javascript:/i.test(html))
    blocks.push('rendered HTML holds a script, iframe or handler');

  const records: string[] = [];
  for (const w of contentWarnings(c)) records.push(`content warning: ${w}`);
  for (const e of contentErrors(c)) records.push(`content check (${e.field}): ${e.message}`);
  const canonical = c.seo?.canonicalUrl;
  if (canonical) {
    let host = 'an invalid URL';
    try {
      host = new URL(canonical).host;
    } catch {
      // recorded as invalid
    }
    records.push(`seo.canonicalUrl is ${host} (the renderer uses it only when it is the site's own origin)`);
  }
  const httpSources = c.sources.filter((s) => /^http:/i.test(s.url)).length;
  if (httpSources) records.push(`${httpSources} source URL(s) use http (allowed)`);
  const httpLinks = markdownLinks(c.bodyMarkdown).filter((l) => /^http:/i.test(l)).length;
  if (httpLinks) records.push(`${httpLinks} body link(s) use http (allowed)`);
  return [
    ...blocks.map((message) => ({ item, level: 'block' as const, message })),
    ...records.map((message) => ({ item, level: 'record' as const, message })),
  ];
}

export const checkPost = (p: BundlePost): Finding[] => checkPostContent(`post ${p.slug}`, p.content);

/** A release announcement: plain text fields only (titles and captions are never HTML). */
export function checkRelease(r: BundleRelease): Finding[] {
  const item = `release ${r.ref}`;
  const out: string[] = [];
  const c = r.content;
  const texts: Array<[string, string]> = [
    ['title', c.title],
    ['summary', c.summary],
    ...Object.entries(c.captions ?? {}).map(
      ([k, v]) => [`caption ${k}`, String(v ?? '')] as [string, string],
    ),
  ];
  for (const [where, text] of texts) {
    scanText(where, text, out);
    if (CONTROL_OR_BIDI.test(text)) out.push(`${where}: a control character or bidi override`);
  }
  return out.map((message) => ({ item, level: 'block' as const, message }));
}

export function checkVideo(v: BundleVideo): Finding[] {
  const item = `video ${v.kind}/${v.ref}/${v.format}`;
  const out: string[] = [];
  for (const [where, text] of [
    ['title', v.meta.title],
    ['description', v.meta.description],
  ] as const) {
    scanText(where, text, out);
    if (CONTROL_OR_BIDI.test(text.replace(/[\n\r\t]/g, ' ')))
      out.push(`${where}: a control character or bidi override`);
  }
  return out.map((message) => ({ item, level: 'block' as const, message }));
}

/** The post id each network gives back, and the hosts its post URLs live on (https only). */
export const SHARE_RULES: Record<string, { id: RegExp; hosts: string[] }> = {
  youtube: {
    id: /^[A-Za-z0-9_-]{6,20}$/,
    hosts: ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'],
  },
  facebook: {
    id: /^[0-9]{5,40}(_[0-9]{5,40})?$/,
    hosts: ['www.facebook.com', 'facebook.com', 'm.facebook.com'],
  },
  x: { id: /^[0-9]{5,30}$/, hosts: ['x.com', 'twitter.com'] },
  bluesky: {
    id: /^at:\/\/did:[a-z0-9]+:[A-Za-z0-9._:-]{1,100}\/app\.bsky\.feed\.post\/[a-z0-9]{1,30}$/,
    hosts: ['bsky.app'],
  },
  instagram: { id: /^[0-9]{5,30}$/, hosts: ['www.instagram.com', 'instagram.com'] },
  linkedin: {
    id: /^urn:li:(share|ugcPost|activity):[0-9]{5,30}$/,
    hosts: ['www.linkedin.com', 'linkedin.com'],
  },
  tiktok: { id: /^[0-9]{5,30}$/, hosts: ['www.tiktok.com', 'tiktok.com'] },
};

export function checkShare(s: BundleShare): Finding[] {
  const item = `share ${s.postId}/${s.network}`;
  const rule = SHARE_RULES[s.network];
  const out: string[] = [];
  if (!rule) out.push('unknown network');
  else {
    if (!rule.id.test(s.externalId)) out.push(`external id does not look like a ${s.network} post id`);
    if (s.url !== null) {
      let ok = false;
      try {
        const u = new URL(s.url);
        ok = u.protocol === 'https:' && rule.hosts.includes(u.hostname) && !u.username && !u.password;
      } catch {
        ok = false;
      }
      if (!ok) out.push(`url is not https on a ${s.network} host`);
    }
  }
  if (s.network === 'youtube' && s.detail.videoId && s.detail.videoId !== s.externalId)
    out.push('detail.videoId differs from the external id');
  return out.map((message) => ({ item, level: 'block' as const, message }));
}

export const blocking = (f: Finding[]): Finding[] => f.filter((x) => x.level === 'block');
