import {
  BLOG_AUTHOR,
  BLOG_TAGS,
  blogTagLabel,
  escapeHtml as esc,
  type PublicBlogPost,
  type PublicBlogPostFull,
  renderMarkdownHtml,
} from '@aom/shared';

/**
 * Plain HTML templates of the public blog (docs/design/blog-prd.md section 6). Server-rendered per request (the
 * landing page is prerendered at build time and cannot follow a post every few hours). No JavaScript, no external
 * resources: the app's CSP (`script-src 'self'`, `img-src 'self' data:`) is respected, styles are one inline block.
 */

const CSS = `
:root{--canvas:#f5f6f8;--surface:#fff;--sunken:#eef0f4;--line:#e2e5ea;--fg:#12161f;--muted:#4b5365;--brand:#3446d9;--brand-fg:#fff;--brand-soft:#e8ebfd;--accent:#d4f24a;--side:#0d1220}
@media (prefers-color-scheme:dark){:root{--canvas:#0b0e14;--surface:#131822;--sunken:#1a2030;--line:#262d3b;--fg:#eceff5;--muted:#a9b2c3;--brand:#9daeff;--brand-fg:#0d1220;--brand-soft:#1d2447}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--fg);font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--brand)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header.site{background:var(--surface);border-bottom:1px solid var(--line)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:var(--fg);text-decoration:none}
.brand img{height:28px;width:auto;display:block}
.brand .dark{display:none}
@media (prefers-color-scheme:dark){.brand .light{display:none}.brand .dark{display:block}}
nav.site a{margin-left:18px;color:var(--fg);text-decoration:none;font-size:15px;font-weight:500}
nav.site a:hover{color:var(--brand)}
nav.site a.cta{background:var(--brand);color:var(--brand-fg);padding:8px 14px;border-radius:8px}
main{padding:36px 0 64px}
h1{font-size:2.1rem;line-height:1.2;margin:0 0 12px;letter-spacing:-.02em}
h2{font-size:1.5rem;margin:2em 0 .5em;line-height:1.3}h3{font-size:1.2rem;margin:1.6em 0 .4em}h4{margin:1.4em 0 .3em}
.lead{color:var(--muted);font-size:1.1rem;margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:20px;margin-top:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;height:auto;aspect-ratio:1200/630;object-fit:cover;display:block;background:var(--sunken)}
.card .body{padding:16px 18px 18px}
.card h2{font-size:1.15rem;margin:0 0 8px;line-height:1.35}
.card h2 a{color:var(--fg);text-decoration:none}.card h2 a:hover{color:var(--brand)}
.card p{margin:0 0 10px;color:var(--muted);font-size:.95rem;line-height:1.5}
.meta{font-size:.85rem;color:var(--muted)}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.tags a{display:inline-block;background:var(--brand-soft);color:var(--brand);border-radius:999px;padding:2px 10px;font-size:.8rem;text-decoration:none}
.tags a.on{background:var(--brand);color:var(--brand-fg)}
.pager{display:flex;justify-content:space-between;margin-top:32px}
article{max-width:720px;margin:0 auto}
article img.cover{width:100%;height:auto;aspect-ratio:1200/630;border-radius:12px;margin:20px 0;background:var(--sunken)}
article pre{background:var(--sunken);padding:14px;border-radius:8px;overflow:auto;font-size:.9rem}
article code{background:var(--sunken);padding:1px 5px;border-radius:4px;font-size:.92em}
article pre code{background:none;padding:0}
article blockquote{margin:1em 0;padding:2px 16px;border-left:4px solid var(--brand);color:var(--muted)}
.table-wrap{overflow:auto}table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
.sources{font-size:.95rem;color:var(--muted)}
.disclosure{background:var(--sunken);border-radius:8px;padding:12px 14px;font-size:.9rem;color:var(--muted);margin:28px 0}
.cta-box{background:var(--side);color:#eceff5;border-radius:12px;padding:22px 24px;margin:32px 0}
.cta-box a.btn{display:inline-block;background:var(--accent);color:#0d1220;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none}
footer.site{border-top:1px solid var(--line);background:var(--surface);padding:24px 0;font-size:.9rem;color:var(--muted)}
footer.site a{color:var(--muted);margin-right:16px}
img,video{max-width:100%}h1,h2,h3,p,li{overflow-wrap:anywhere;text-wrap:balance}p,li{text-wrap:pretty}
@media (max-width:640px){
.wrap{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
body{font-size:16px}main{padding:24px 0 48px}h1{font-size:clamp(1.65rem,7.4vw,2.1rem)}h2{font-size:1.35rem}
header.site .wrap{height:60px;gap:8px}.brand img{height:24px}
nav.site{display:flex;align-items:center}nav.site a{margin-left:4px;padding:0 10px;min-height:44px;display:inline-flex;align-items:center}
nav.site a.cta{margin-left:8px;padding:0 14px}
.tags a{padding:12px 14px;font-size:.85rem}.tags{gap:8px}
.pager a,.cta-box a.btn,button{display:inline-flex;align-items:center;min-height:44px}
.cta-box{padding:20px 18px}
footer.site{padding:20px 0 max(20px,env(safe-area-inset-bottom))}footer.site a{display:inline-flex;align-items:center;min-height:44px;margin-right:18px}
article table{font-size:.9rem}
}
form.inline{display:inline}button{font:inherit;cursor:pointer;background:var(--brand);color:var(--brand-fg);border:0;border-radius:8px;padding:9px 16px}
`;

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  ogType?: 'website' | 'article';
  image?: string;
  noindex?: boolean;
  publishedTime?: string;
  modifiedTime?: string;
  jsonLd?: unknown;
  rss?: boolean;
}

const jsonLd = (o: unknown): string => JSON.stringify(o).replace(/</g, '\\u003c');

function layout(origin: string, meta: PageMeta, content: string): string {
  const img = meta.image ?? `${origin}/og-image.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(meta.canonical)}">
${meta.noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
${meta.rss === false ? '' : `<link rel="alternate" type="application/rss+xml" title="Guildwise HQ blog" href="${esc(origin)}/blog/rss.xml">`}
<meta property="og:site_name" content="Guildwise HQ"><meta property="og:type" content="${meta.ogType ?? 'website'}">
<meta property="og:title" content="${esc(meta.title)}"><meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(meta.canonical)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
${meta.publishedTime ? `<meta property="article:published_time" content="${esc(meta.publishedTime)}">` : ''}
${meta.modifiedTime ? `<meta property="article:modified_time" content="${esc(meta.modifiedTime)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}"><meta name="twitter:image" content="${esc(img)}">
${meta.jsonLd ? `<script type="application/ld+json">${jsonLd(meta.jsonLd)}</script>` : ''}
<style>${CSS}</style></head><body>
<header class="site"><div class="wrap"><a class="brand" href="/" aria-label="Guildwise HQ, home"><img class="light" src="/brand/logo-hq.svg" alt="Guildwise HQ"><img class="dark" src="/brand/logo-hq-dark.svg" alt="" aria-hidden="true"></a>
<nav class="site" aria-label="Main"><a href="/">Home</a><a href="/blog">Blog</a><a class="cta" href="/login">Sign in</a></nav></div></header>
<main><div class="wrap">${content}</div></main>
<footer class="site"><div class="wrap"><a href="/blog">Blog</a><a href="/blog/rss.xml">RSS</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/contact">Contact</a><br>Guildwise HQ. Many hands. One master.</div></footer>
</body></html>`;
}

const coverUrl = (origin: string, key: string) => `${origin}/blog/cover/${key}.png`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

function tagList(tags: string[], active?: string): string {
  return `<ul class="tags">${tags.map((t) => `<li><a href="/blog/tag/${esc(t)}"${t === active ? ' class="on"' : ''}>${esc(blogTagLabel(t))}</a></li>`).join('')}</ul>`;
}

function card(origin: string, p: PublicBlogPost): string {
  return `<article class="card"><a href="/blog/${esc(p.slug)}" tabindex="-1" aria-hidden="true"><img src="${esc(coverUrl(origin, p.coverImage.defaultKey))}" alt="" loading="lazy" width="1200" height="630"></a>
<div class="body">${tagList(p.tags)}<h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2><p>${esc(p.summary)}</p>
<div class="meta"><time datetime="${esc(p.publishedAt)}">${esc(fmtDate(p.publishedAt))}</time> &middot; ${p.readingMinutes} min read</div></div></article>`;
}

export function listPage(
  origin: string,
  o: { posts: PublicBlogPost[]; total: number; page: number; perPage: number; tag?: string | undefined },
): string {
  const pages = Math.max(1, Math.ceil(o.total / o.perPage));
  const base = o.tag ? `/blog/tag/${o.tag}` : '/blog';
  const title = o.tag ? `${blogTagLabel(o.tag)} articles` : 'Blog';
  const desc = o.tag
    ? `Articles about ${blogTagLabel(o.tag).toLowerCase()} from the Guildwise HQ blog.`
    : 'Practical articles on AI agents and AI automation from the Guildwise HQ team.';
  const canonical = `${origin}${base}${o.page > 1 ? `?page=${o.page}` : ''}`;
  const filter = `<ul class="tags"><li><a href="/blog"${o.tag ? '' : ' class="on"'}>All</a></li>${BLOG_TAGS.map((t) => `<li><a href="/blog/tag/${t.key}"${t.key === o.tag ? ' class="on"' : ''}>${esc(t.label)}</a></li>`).join('')}</ul>`;
  const html = `<h1>${esc(title)}</h1><p class="lead">${esc(desc)}</p>${filter}
${o.posts.length ? `<div class="grid">${o.posts.map((p) => card(origin, p)).join('')}</div>` : '<p>No articles yet. Check back soon.</p>'}
<nav class="pager" aria-label="Pages"><span>${o.page > 1 ? `<a rel="prev" href="${base}${o.page > 2 ? `?page=${o.page - 1}` : ''}">&larr; Newer</a>` : ''}</span><span>${o.page < pages ? `<a rel="next" href="${base}?page=${o.page + 1}">Older &rarr;</a>` : ''}</span></nav>`;
  return layout(
    origin,
    {
      title: `${title} | Guildwise HQ`,
      description: desc,
      canonical,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        name: 'Guildwise HQ blog',
        url: `${origin}/blog`,
        publisher: { '@type': 'Organization', name: 'Guildwise HQ' },
      },
    },
    html,
  );
}

export function postPage(
  origin: string,
  post: PublicBlogPostFull,
  seo: {
    metaTitle?: string | undefined;
    metaDescription?: string | undefined;
    canonicalUrl?: string | undefined;
    noindex?: boolean | undefined;
  },
  disclosure: { model?: string | undefined; agentName?: string | undefined },
): string {
  const canonical =
    seo.canonicalUrl && new URL(seo.canonicalUrl).origin === new URL(origin).origin
      ? seo.canonicalUrl
      : `${origin}/blog/${post.slug}`;
  const image = coverUrl(origin, post.coverImage.defaultKey);
  const sources = post.sources.length
    ? `<h2>Sources</h2><ol class="sources">${post.sources.map((s) => `<li><a href="${esc(s.url)}" rel="nofollow noopener noreferrer" target="_blank">${esc(s.title)}</a></li>`).join('')}</ol>`
    : '';
  const by = [disclosure.agentName, disclosure.model].filter(Boolean).join(', ');
  const html = `<article><p class="meta"><a href="/blog">&larr; All articles</a></p>
<h1>${esc(post.title)}</h1>
<p class="meta">${esc(BLOG_AUTHOR)} &middot; <time datetime="${esc(post.publishedAt)}">${esc(fmtDate(post.publishedAt))}</time> &middot; ${post.readingMinutes} min read</p>
${tagList(post.tags)}
<img class="cover" src="${esc(image)}" alt="${esc(post.coverImage.alt)}" width="1200" height="630">
${renderMarkdownHtml(post.bodyMarkdown)}
${sources}
<p class="disclosure">This article was written by an AI agent for Guildwise HQ${by ? ` (${esc(by)})` : ''} and is reviewed against its sources.</p>
<div class="cta-box"><strong>Many hands. One master.</strong><p>Guildwise HQ lets one person run an organization of AI agents, with a board, a desk for decisions and a full record of the work.</p><a class="btn" href="/">See how Guildwise HQ works</a></div>
</article>`;
  return layout(
    origin,
    {
      title: seo.metaTitle || `${post.title} | Guildwise HQ`,
      description: seo.metaDescription || post.summary,
      canonical,
      ogType: 'article',
      image,
      ...(seo.noindex ? { noindex: true } : {}),
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.summary,
        datePublished: post.publishedAt,
        dateModified: post.updatedAt,
        image: [image],
        mainEntityOfPage: canonical,
        author: { '@type': 'Organization', name: BLOG_AUTHOR },
        publisher: {
          '@type': 'Organization',
          name: 'Guildwise HQ',
          logo: { '@type': 'ImageObject', url: `${origin}/apple-touch-icon.png` },
        },
      },
    },
    html,
  );
}

export function messagePage(origin: string, title: string, text: string, extra = ''): string {
  return layout(
    origin,
    {
      title: `${title} | Guildwise HQ`,
      description: text,
      canonical: `${origin}/blog`,
      noindex: true,
      rss: false,
    },
    `<article><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>${extra}<p><a href="/blog">Go to the blog</a></p></article>`,
  );
}

const xml = (s: string) => esc(s);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};
const mimeOf = (url: string) =>
  MIME[(url.split(/[?#]/)[0]?.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()] ?? 'image/png';

/** Makes root-relative `href`/`src` attributes absolute so the body works outside our site. */
export function absolutizeHtml(origin: string, html: string): string {
  return html.replace(
    /(\s(?:href|src)=)(["'])(\/(?!\/)[^"']*)\2/gi,
    (_m, a, q, u) => `${a}${q}${origin}${u}${q}`,
  );
}

export const cdata = (s: string) => `<![CDATA[${s.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

export function rssFeed(origin: string, posts: Array<PublicBlogPostFull>): string {
  const last = posts[0]?.updatedAt ?? new Date(0).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<title>Guildwise HQ blog</title><link>${xml(origin)}/blog</link>
<description>Practical articles on AI agents and AI automation from the Guildwise HQ team.</description>
<language>en</language><lastBuildDate>${new Date(last).toUTCString()}</lastBuildDate>
<atom:link href="${xml(origin)}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${posts
  .map((p) => {
    const image = p.coverImage?.defaultKey ? coverUrl(origin, p.coverImage.defaultKey) : '';
    const body = absolutizeHtml(
      origin,
      `${image ? `<img src="${esc(image)}" alt="${esc(p.coverImage.alt)}" width="1200" height="630">\n` : ''}${renderMarkdownHtml(p.bodyMarkdown)}`,
    );
    const media = image
      ? `<enclosure url="${xml(image)}" type="${mimeOf(image)}" length="0"/><media:content url="${xml(image)}" medium="image"/>`
      : '';
    return `<item><title>${xml(p.title)}</title><link>${xml(p.url)}</link><guid isPermaLink="true">${xml(p.url)}</guid>
<pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate><dc:creator>${xml(p.author || 'Guildwise Research Desk')}</dc:creator><description>${xml(p.summary)}</description>${p.tags.map((t) => `<category>${xml(blogTagLabel(t))}</category>`).join('')}${media}
<content:encoded>${cdata(body)}</content:encoded></item>`;
  })
  .join('\n')}
</channel></rss>`;
}

export function sitemap(origin: string, posts: PublicBlogPost[], tags: string[]): string {
  const url = (loc: string, lastmod?: string) =>
    `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[url(`${origin}/`), url(`${origin}/blog`, posts[0]?.updatedAt), ...tags.map((t) => url(`${origin}/blog/tag/${t}`)), ...posts.map((p) => url(p.url, p.updatedAt)), url(`${origin}/privacy`), url(`${origin}/terms`), url(`${origin}/trust`), url(`${origin}/popia`), url(`${origin}/contact`)].join('\n')}
</urlset>`;
}
