# Public Releases index: consistent release cards

## Question

The public `/releases` page shows release cards of different shapes and sizes. How should the index be restyled so that every card has the same width, height and internal layout, on desktop and phone, in light and dark theme, with WCAG 2 AA contrast, without touching the release data, the routes or the other public pages?

## Findings

### Where the page lives

- The page is rendered by `releasesIndexPage` in `apps/server/src/blog/render.ts` (line 274) and served by `GET /releases` in `apps/server/src/routes/blog-public.ts` (line 199) via `loadReleases(ctx)`. guildwise-cloud has no Releases page. Its blog writer only links to `/releases/<version>` on the HQ domain, so GuildwiseHQ is the right repository.
- All public pages share one inline `<style>` block (the `CSS` constant, lines 18-78) emitted by `layout()`. There is no JavaScript and the CSP allows only `'self'` scripts and `'self' data:` images.
- Theme: the public CSS switches tokens with `@media (prefers-color-scheme: dark)` on `:root`. It does not use `[data-theme]`. Tokens available: `--canvas --surface --sunken --line --fg --muted --brand --brand-fg --brand-soft --accent --side`.

### Why the cards differ today

The index emits `div.grid > article.card > div.body > h2 > a`, then one `<p>` and then `div.meta > time`. It reuses the blog `.card` rules, and those were written for blog cards that have a cover image.

1. **Summary length varies.** The summary is `whatsNew[0]?.title ?? sections.added[0] ?? intro`, cut at 160 characters in JS. There is no line clamp, so a card takes one to four lines of summary.
2. **Empty summaries.** When a release has no What's New entry and no Added item, `intro` is used, and it is often `""` (for example a release with only Fixed items). That leaves an empty `<p>` with a 10 px margin, so the card is shorter.
3. **The date moves.** The date comes after the summary, so its vertical position depends on the summary length. Headers and dates do not line up across a row.
4. **Raw Markdown.** Changelog items keep inline Markdown (`**bold**`, `` `code` ``, `[text](https://…)`). The index escapes them and shows the literal markup.
5. **Uneven rows.** The grid stretches each card in a row to the tallest one, but the content is not anchored. The extra space ends up below the date, so the cards look uneven even when their outer boxes match.

### Data facts that shape the design

- `Release` (`packages/shared/src/blog/social-post.ts`) has no cover field. Every release page uses the same image, `RELEASE_COVER(origin)` = `/blog/cover/release.png`. The index shows no image today.
- `ReleaseVersionSchema` enforces `^\d+\.\d+\.\d+$`, so a real version is short. A very long version can only come from a test fixture, but the design still has to tolerate it (AC 4).
- Contrast of the existing public tokens (the same values as the design system):

  | Token | Light on surface / canvas | Dark on surface / canvas |
  | --- | --- | --- |
  | `--fg` | 18.1 / 16.7 | 15.4 / 16.8 |
  | `--muted` | 7.7 / 7.1 | 8.3 / 9.1 |
  | `--brand` (links, focus ring) | about 6.9 / 6.4 | 8.4 / about 9.1 |

  Every text and focus colour this design uses already passes AA, and the focus ring passes 3:1 in both themes. No new colour is needed.

## Options

### A. Cover image on each card

| Option | Pros | Cons |
| --- | --- | --- |
| A1. Show `release.png` at 1200/630 on every card | Matches the blog cards | The same picture repeated N times adds no information. It costs N lazy image requests and doubles the card height. There is no per-release cover to show. |
| **A2. No image on index cards (chosen)** | Every card is identical by construction, so AC 4 cannot regress. Lighter page. | Less visual than the blog list |

A2 meets requirement 1 ("cover image, if shown") and AC 4. If per-release covers are added later, the subgrid layout below takes an extra row without other changes.

### B. Aligning headers and equal heights

| Option | Pros | Cons |
| --- | --- | --- |
| B1. Fixed heights for every block (version reserved for 2 lines, summary for 3 lines) | Works in every browser. All cards are identical across rows. | Every card with a one-line version has an empty line under it, which looks wasteful. |
| **B2. CSS subgrid: each card spans 4 rows of the parent grid (chosen)** | Version, date, summary and Read more rows line up across a row whatever their content. Space is reserved only when a card in that row needs it. Equal heights come from grid stretch. | Needs subgrid (Chrome/Edge 117+, Safari 16+, Firefox 71+; Baseline since September 2023). Older browsers use the B1 fallback through `@supports`. |
| B3. Flex column with `margin-top:auto` on the footer | Simple | The date still moves when the version wraps, so AC 2 fails with a long version. |

### C. Keyboard and link model (one focusable target per card)

| Option | Pros | Cons |
| --- | --- | --- |
| C1. Version heading link, stretched over the card. "Read more" is plain text. | Heading navigation lands on a link | The card asks for a visible Read more *link*. Its accessible name would be only the version. |
| **C2. "Read more" is the only link, stretched over the card with `::after`. Its name includes the version through visually hidden text. (chosen)** | One tab stop per card in DOM order (which is visual order). The whole card is a large touch target. The link name ("Read more about Guildwise HQ 1.5.0") starts with its visible label (WCAG 2.5.3). Screen readers can tell the links apart. | Summary text cannot be selected with the mouse, which is acceptable for a teaser. The full text is on the release page. |
| C3. Heading link and Read more link | Familiar | Two tab stops per card, which breaks "single focusable link target" |

### D. Summary text

The release data stays unchanged. Only the card's choice and display of text changes, inside `render.ts`.

- Keep the current source order but use `||`, so empty strings fall through, and add the remaining sections: `whatsNew[0]?.title || sections.added[0] || intro || sections.changed[0] || sections.fixed[0] || ''`. Existing non-empty summaries stay exactly the same. Only cards that were empty gain text.
- Strip inline Markdown to plain text before escaping (links become their text; `**`, `__` and backticks are removed; whitespace is collapsed). This fixes finding 4.
- The visible truncation becomes CSS (`line-clamp: 3` with an ellipsis), as the card requires. The JS cut goes from 157+`...` to `fitText(text, 300)` (the existing helper, which cuts at a word boundary). It only limits payload size. At the widest one-column card (about 560 px of text) three lines hold about 220 characters, so a long summary is always clamped by CSS, never by the JS cut.
- A release with no text at all shows the muted placeholder "See the release notes for the full list of changes." in the same clamped, reserved box (class `rel-summary is-empty`). The card size does not change.

## Recommendation (design to build)

A2 + B2 (with the B1 fallback) + C2 + D. Change `apps/server/src/blog/render.ts` only (markup of `releasesIndexPage` and scoped CSS appended to `CSS`), and add tests.

### Markup (per release)

```ts
// render.ts, near fitText
const plainInline = (s: string): string =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const releaseSummary = (r: Release): string =>
  fitText(
    plainInline(
      r.whatsNew[0]?.title || r.sections.added[0] || r.intro || r.sections.changed[0] || r.sections.fixed[0] || '',
    ),
    300,
  );

function releaseCard(r: Release): string {
  const name = `Guildwise HQ ${r.version}`;
  const summary = releaseSummary(r);
  return `<article class="rel-card"><h2 class="rel-version">${esc(name)}</h2>
<p class="rel-date"><time datetime="${esc(r.date)}">${esc(fmtDate(r.date))}</time></p>
<p class="rel-summary${summary ? '' : ' is-empty'}">${esc(summary || 'See the release notes for the full list of changes.')}</p>
<p class="rel-more"><a href="/releases/${esc(r.version)}">Read more<span class="vh"> about ${esc(name)}</span></a><span aria-hidden="true"> &rarr;</span></p></article>`;
}
// releasesIndexPage: `<div class="releases-index">${releases.map(releaseCard).join('')}</div>` (h1, lead, empty state, meta unchanged)
```

Notes:
- The h2 is plain text, no longer a link. The existing assertions (`'Guildwise HQ 1.9.0'`, `'/releases/1.9.0'` in `social-release.test.ts`) still hold.
- Move `fitText` above its first use or keep it as a hoisted `function`. Today it is a `const` declared after `releasePage`, which works only because it is called at runtime. Either way is fine.
- Use the new class names `releases-index` / `rel-*` instead of `grid` / `card`, so none of the blog `.card` rules apply and nothing else on the site is affected.

### CSS (append to the `CSS` constant; existing tokens only, no new hex values)

```css
.releases-index{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));column-gap:20px;row-gap:0;margin-top:24px}
.rel-card{position:relative;min-width:0;display:grid;grid-row:span 4;grid-template-rows:subgrid;row-gap:0;margin:0 0 20px;padding:18px 18px 16px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.rel-card:hover{border-color:var(--muted)}
.rel-version{margin:0 0 4px;font-size:1.15rem;line-height:1.35;color:var(--fg);overflow-wrap:anywhere}
.rel-date{margin:0 0 10px;font-size:.85rem;line-height:1.4;color:var(--muted)}
.rel-summary{margin:0 0 14px;font-size:.95rem;line-height:1.5;color:var(--muted);min-height:4.5em;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
.rel-summary.is-empty{font-style:italic}
.rel-more{align-self:end;margin:0;font-size:.95rem;font-weight:600;color:var(--brand)}
.rel-more a{color:var(--brand);text-decoration:underline;text-underline-offset:3px}
.rel-more a::after{content:"";position:absolute;inset:0;border-radius:12px}
.rel-more a:focus-visible{outline:none}
.rel-more a:focus-visible::after{outline:2px solid var(--brand);outline-offset:2px}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@supports not (grid-template-rows:subgrid){.rel-card{display:flex;flex-direction:column}.rel-version{min-height:2.7em}.rel-more{margin-top:auto}}
```

Why each rule:
- **Columns.** The content area of `.wrap` is 1000 px wide at most. `minmax(min(100%,280px),1fr)` gives 3 columns at 1440 and 1024 px, 2 at 768 px (and down to about 660 px), and 1 full-width column at 375-414 px. `min(100%, …)` prevents horizontal overflow on narrow screens, and `min-width:0` plus `overflow-wrap:anywhere` keep a long version inside the card. `auto-fill` with `1fr` keeps every card in a row the same width, even when the last row is not full.
- **Rows.** Each card spans 4 implicit rows (version, date, summary, more) and adopts them through `subgrid`. The tallest version in a row sets that row's version track, so dates and summaries start at the same offset in every card of the row (AC 2). Grid stretch gives equal heights (AC 1, AC 3).
- **Gaps.** The parent `row-gap` is 0 because a subgrid's tracks include the parent's gutters. The space between card rows comes from `margin-bottom:20px` on the card, which the subgrid adds to its last track. The gap between cards stays 20 px, as on the blog.
- **Summary box.** `min-height:4.5em` (3 × 1.5) plus a 3-line clamp makes the summary box the same size for empty, short and long summaries (AC 3, AC 4). The ellipsis comes from `line-clamp`. The global `p{text-wrap:pretty}` rule is harmless here.
- **Focus.** The focus ring is drawn on the stretched `::after`, so it goes around the whole card: 2 px of `--brand` with a 2 px offset, on the canvas (6.4:1 light, about 9:1 dark). `outline:none` is only set on the link itself, where the `::after` outline replaces it. In forced-colors mode the outline is still drawn.
- **Theme.** Every colour is a `var(--…)` token. The dark-theme override of `:root` already flips them, so no theme-specific rules are needed (AC 7).
- **Touch.** The whole card is the target (far more than 44 px). Nothing depends on hover, and no form field is involved.

### Files

| File | Change |
| --- | --- |
| `apps/server/src/blog/render.ts` | `plainInline`, `releaseSummary`, `releaseCard`; `releasesIndexPage` emits `div.releases-index`; scoped CSS appended to `CSS`. `layout()`, `releasePage`, `listPage`, `card`, `postPage`, `rssFeed` and `sitemap` stay unchanged. |
| `apps/server/test/releases-index-render.test.ts` (new) | Pure render tests (below) |
| `apps/server/test/social-release.test.ts` | In "public release pages" (which already seeds 1.9.0): assert that `/releases` contains `class="releases-index"`, `class="rel-card"` and `href="/releases/1.9.0">Read more<span class="vh"> about Guildwise HQ 1.9.0</span>`. blog-public.test.ts seeds no releases. Use this suite, or seed with `useReleaseSource` in blog-public.test.ts in the same way. |
| No change | `releases.ts`, `blog-public.ts`, routes, URLs, `PageMeta`, SEO tags, JSON-LD, RSS, sitemap |

### Tests for the builder (unit, vitest; apps/server suites need the aom_test Postgres from vitest.config.ts)

New `releases-index-render.test.ts`, calling `releasesIndexPage('https://aom.test', releases)` with fixtures built in the test:
1. **Same skeleton.** Use four releases: a normal one, one with a 400-character What's New title, one with nothing (`whatsNew: []`, empty sections, `intro: ''`), and one with a long version (`'123456789.987654321.123456789012'`, cast past the schema). Split the output on `<article class="rel-card">` and, for each card, assert the ordered pattern `h2.rel-version` → `p.rel-date > time[datetime]` → `p.rel-summary` → `p.rel-more > a[href="/releases/<v>"]`.
2. **Accessible name.** Each link contains `Read more<span class="vh"> about Guildwise HQ <v></span>`.
3. **Long summary.** The rendered summary is at most 300 characters, ends in `...` and is not cut mid-word. The CSS contains `-webkit-line-clamp:3` and `line-clamp:3` on `.rel-summary`.
4. **Empty summary.** The card has `rel-summary is-empty` and the placeholder text.
5. **Fallback order.** whatsNew title, then the first Added item, then intro, then Changed, then Fixed. Markdown is stripped (`[blog page](https://x)` becomes `blog page`; `**b**` becomes `b`; `` `c` `` becomes `c`).
6. **Escaping.** A title `A <b>x</b> & "q"` renders as `A &lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;`, with no raw `<b>`.
7. **No new colours (AC 7).** Collect every `#[0-9a-f]{3,6}` in the page's `<style>` and assert that the set is a subset of the colours used today: `#f5f6f8 #fff #eef0f4 #e2e5ea #12161f #4b5365 #3446d9 #e8ebfd #d4f24a #0d1220 #0b0e14 #131822 #1a2030 #262d3b #eceff5 #a9b2c3 #9daeff #1d2447`.
8. **Other pages unaffected.** `releasePage(...)` and `listPage(...)` output contain no `rel-card` or `releases-index` markup. The existing `blog-rss.test.ts`, `releases.test.ts`, `release-changelog-parity.test.ts`, `blog-public.test.ts` and `social-release.test.ts` pass unchanged.

### Acceptance criteria → design

| AC | Covered by |
| --- | --- |
| Same width and height per row at 1440/1024/768/375 | `auto-fill` + `1fr` columns; grid stretch; subgrid rows. Browser check by testers. |
| Version and date aligned within 1 px | Subgrid version and date tracks shared across the row; `@supports` fallback with a reserved 2-line version |
| Long summary clamped with ellipsis and Read more, card not taller | `line-clamp:3` + fixed `min-height:4.5em`; JS cut only at 300 characters; Read more always present. Unit tests 1 and 3. |
| No summary or no cover: same size and header position | No cover on any card (A2); placeholder in the reserved summary box. Unit test 4. |
| Read more opens the release page; name includes the version | `a[href=/releases/<v>]` with `.vh` text. Unit test 2 and the route assertion. |
| 375 px: one column, no horizontal scroll | `min(100%,280px)`, `min-width:0`, `overflow-wrap:anywhere` |
| Theme tokens only, switching theme updates the cards | Only `var(--…)`; unit test 7 |
| axe: 0 colour-contrast, no new serious or critical issues | Token ratios in the Findings table; one link per card with a unique name; heading order kept (h1 → h2) |
| Keyboard order and visible focus ring | One link per card in DOM order (= visual order); `::after` outline in `--brand`, at least 3:1 |
| Other pages unchanged, existing tests pass | New class names only; shared rules untouched; unit test 8 |

### Risks

- **Subgrid with card margin and padding.** Per the spec, a subgrid's padding and margin are added to its first and last tracks. Chrome, Safari and Firefox implement this. Testers check row alignment at the four widths. If one engine misbehaves, the fallback is to set the parent `row-gap:20px` and remove the card margin, which makes the inner rows 20 px apart and needs compensating negative margins. That fix is uglier, so try the margin approach first.
- **`-webkit-box` inside a grid item.** This is supported everywhere and is the standard way to clamp lines. The unprefixed `line-clamp` is added for the future.
- **Stretched link.** Text inside the card cannot be selected. That is acceptable for a teaser card.
- **The CSS block grows by about 1.3 KB on every public page.** The rules are inert outside the index. ETags change once on deploy, as they do for any CSS change.
- **Release text is still escaped with `esc()`.** `plainInline` runs before `esc` and only removes characters, so it cannot introduce markup.

### Left to testers

The Playwright and axe checks in the card's test plan (bounding boxes at four widths in both themes, `scrollWidth`, clamp `scrollHeight > clientHeight`, axe in light and dark (`page.emulateMedia({ colorScheme })`), tab order and focus ring, screenshots) need a running server and are not unit tests.
