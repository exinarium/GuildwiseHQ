# Law industry article: findings on release/1.6.0 and placement

## Question

Before an article on the law industry bundle ("Law firms") is written:

- (a) Do the bundle and its playbooks exist in the code, and under which names?
- (b) Have its playbooks run on pilot organisations?
- (c) Does an article for this industry already exist?
- (d) Where must a new article go so that it ships?

The card's rule: if the bundle or its playbooks do not exist, or have not run on a pilot, the card is blocked and no article is written.

All findings are from `origin/release/1.6.0`. `git diff HEAD origin/release/1.6.0` is empty for every path read below (rule packs, journey templates, business roles, workflows, brief playbooks, the blog launch set, the launch migration, the shared blog package and the server commands), so the card branch shows the same picture.

The sibling real estate card reached the same result, and the owner's answer on it (ledger 28ab23a7) says: keep the card blocked until the industry's playbooks have run on a pilot, and apply the same to the law card. This report confirms that the law gap is the same or wider.

## Findings

### (a) The bundle in code

No code object is called an "industry bundle": no table, constant, type or screen. The phrase appears only in the rule-pack descriptions. What exists for a law firm:

| Piece | Name in the product | Where | Law specific? |
| --- | --- | --- | --- |
| Rule pack | **Law firms** (id `law`, kind `industry`, `industry: 'law'`). Description: "Law firms: recommended rules for the release 1.4.0 industry bundle." | `packages/shared/src/ledger/rule-packs.ts:166-188`; installed from the Rule packs dialog, "Industry" group (`apps/web/src/components/RulePacksDialog.tsx`) | Yes |
| Rules in that pack | "partner decides", "fee-earner verifies every date", "AI never moves trust money", "LPA s86–87 trust", "AI citations reviewed". All are `agent_instruction`: agents are told in their brief; the server does not refuse a violation (`SERVER_CHECKS` is empty) | same file | Yes |
| Journey template | **None for law.** The only template is "Rentals: lead to monthly rent" (real estate) | `packages/shared/src/journeys/templates.ts` | n/a |
| Business roles | Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer, Marketing & Reputation, Operations Analyst, Personal Assistant | `packages/shared/src/roles/business.ts` | No, generic |
| Business workflows | business-enquiry, business-follow-up, business-document-request, business-report, business-quote, business-reminder | `packages/shared/src/workflows/business.ts` | No, generic |
| Brief playbooks | **Morning plan**, **Weekly owner brief** (the only two) | `packages/shared/src/schedules/brief-playbooks.ts`, installed by `apps/server/src/commands/brief-playbooks.ts` | No, generic |
| General rule packs | Core rules (includes "no legal/medical/tax advice"), Outbound | `rule-packs.ts` | No |
| Industry enum | `real_estate`, `accounting`, `law` on the ledger API | `packages/shared/src/api/ledger.ts:199` | Type only |

`packages/capabilities/playbooks` holds the delivery playbooks (prd, product-brief, user-guide, weekly-status and others); none is about law. `packages/shared/src/capabilities/pack-team.ts` (named on the card) handles hiring agents from capability packs and holds no industry roles.

Conclusion for (a): **the code has no law playbook, no law role and no law journey template.** The only law-specific piece is the "Law firms" rule pack. Which roles, playbooks and packs make up "the law bundle" is written only in `industry-roadmap.md` (cited as the source of three of the five rules), and that file is not on this workstation. I re-checked both vault clones today: `projects/gwp` holds only `delivery/` and `graph/`; ledger 61b40ee5 records the same gap.

### (b) Pilot runs

**No evidence that any law playbook has run on a pilot organisation.** I searched the release/1.6.0 tree, both knowledge vaults and the card attachments (none attached) for "pilot", "law firm", "legal", "attorney", "trust account" and "industry-roadmap". The repo hits are product text and test fixtures (for example `apps/web/src/test/rule-packs.test.tsx` uses the Law firms pack as fixture data). The only vault hits for "pilot" are "Copilot" in competitor research. There are no pilot notes, run logs, outcomes or consent records. And since (a) shows there is no law playbook, there is nothing that could have run.

### (c) Existing article

**None in code.** `apps/server/src/blog/launch/` holds exactly four articles: `ai-automation-for-small-businesses-2026`, `from-idea-to-tested-change`, `keeping-humans-in-charge-of-ai-agents`, `what-is-an-ai-agent-team`. None is about an industry; the word "legal" appears there only in general POPIA notes and the "not legal advice" footer. The published platform blog cannot be seen from this workstation, so the super admin should check Platform > Blog for a hand-written law post before anything is written.

### (d) Where an article must go

Same answer as the real estate card; the code paths are identical.

Option 1, the launch set (`apps/server/src/blog/launch/*.md`): **does not ship to existing installs.** `migrateBlogLaunch` (`apps/server/src/data-migrations/blog-launch.ts`) returns early once `blog-launch-2026-10` is in `data_migrations`, so a fifth file only reaches brand-new databases. It also:
- breaks `apps/server/test/blog-launch.test.ts`, which asserts `toHaveLength(4)` several times (the AC says that test still passes);
- needs `docs/BLOG-API.md` ("Launch articles") changed, since it names the four files;
- marks the post `launch`, so it is **not shared to social networks and not in the digest**, which is wrong for a marketing piece;
- would need a new data migration to reach existing installs, which the card forbids.

Option 2, a manual post in Platform > Blog (super admin, origin `manual`), or `POST /api/v1/blog/posts` with a `blog:write` key (`docs/BLOG-API.md`, "Submit"): publishes on the live platform with the normal review and share rules, and needs no code, test or migration change. **Recommended.** Keep the Markdown source in the repo as documentation at `docs/blog/industry/law.md`, in the same frontmatter format as the launch files, plus one test that parses it.

Tags: `business-mode` and `marketing` are **not** valid blog tags. `BLOG_TAGS` in `packages/shared/src/blog/constants.ts` is a fixed list (ai-agents, automation, llm-ops, case-study, how-to, industry-news); any other tag fails the schema. Nearest: `case-study` (a piece drawn from a real pilot) or `how-to`, plus `automation`. The cover `defaultKey` must be one of the same keys.

## Comparison of the options

| Option | What happens | Meets the card? |
| --- | --- | --- |
| A. Block until a law pilot has run (recommended; already decided for the sibling card in ledger 28ab23a7) | Card parked. The owner or BA supplies `industry-roadmap.md` (the bundle definition), anonymised notes of a law firm pilot using these pieces, and the consent record. Then the article is written and posted manually | Yes. It is the card's own gate and the owner's 30 Oct note ("once its playbooks run on pilots") |
| B. Re-scope to a "recommended setup" article now | Names only built pieces (Law firms rule pack, generic roles, workflows, Morning plan / Weekly owner brief) with an illustrative week, clearly not from a pilot | Drops the pilot walk-through AC and the gate: owner decision. For law it is thinner than real estate: no journey template, one rule pack |
| C. Close the card | No article | Loses the article option the owner wants: owner decision |

## Recommendation

**Option A: the card stays blocked.** Gate (a) is barely met (one rule pack; no law playbook, role or journey template). Gate (b) is not met (no pilot evidence). By the card's own rule no article is written now. Nothing is built on this card until the material below is attached.

To unblock, the owner or BA attaches to the card:
1. `industry-roadmap.md` (or its "Release 1.4.0, Law firms" section), for the bundle's intended contents;
2. anonymised notes of how the law pieces ran on a pilot organisation (what ran, over what period, what a person approved);
3. the pilot's consent record for anything to be published.

## Design for the build, once unblocked

1. **Source file:** `docs/blog/industry/law.md` in the launch frontmatter format (title, slug, summary, tags, cover, sources, seo, social captions). Copy the frontmatter shape from `apps/server/src/blog/launch/keeping-humans-in-charge-of-ai-agents.md`. Suggested slug `law-firm-ai-agents-recommended-setup` (check it does not collide with a published slug). Tags: `case-study` + `automation` (or `how-to` + `automation` if the pilot notes are thin). Every Markdown link in the body must appear in `sources`, so `contentWarnings` returns nothing.
2. **Names:** use only names that exist in release/1.6.0, exactly as the UI shows them: rule pack "Law firms" and its five rule titles; rule packs "Core rules" and "Outbound"; roles Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer, Marketing & Reputation, Operations Analyst, Personal Assistant; playbooks "Morning plan" and "Weekly owner brief". Use business-mode wording from `useOrgTerms` for any team or card terms. No law journey template exists, so none is named. If `industry-roadmap.md` lists a piece that is not in this list, it is left out, not described.
3. **Framing:** the bundle is "pieces that work well together for a law firm", a recommendation, never a plan, tier or product.
4. **Honesty about enforcement:** all five law rules are agent instructions (`ENFORCED_BY_EXPLAIN`). The article must not say Guildwise blocks trust-money movement or enforces LPA s86–87; it says agents are instructed and a person (partner / fee-earner) decides. Add the "general information, not legal advice" footer used by the launch articles.
5. **Walk-through:** a working week drawn only from the supplied, anonymised pilot notes: no firm names, people, places, matter details or figures without recorded consent.
6. **Test:** add one test, for example `apps/server/test/blog-industry-articles.test.ts` (server side because `contentWarnings` lives in `apps/server/src/commands/blog.ts`). It reads every file in `docs/blog/industry/`, runs `parseBlogArticle` (`packages/shared/src/blog/article.ts`) and asserts no errors, `contentWarnings(...)` is empty, and every tag is in `BLOG_TAG_KEYS`. The real estate and accounting cards reuse the same test. Leave the launch set, `blog-launch.test.ts`, the migration and the schema untouched.
7. **Publish:** the super admin pastes the article into Platform > Blog (or posts it with a `blog:write` key). The tester checks the Help blog list (title, date, tags) and BlogArticleView, on desktop and on a phone.

Risks: a published slug collision (check first); pilot consent scope (publish nothing beyond it); rule titles are terse research fragments ("partner decides"), so the article should explain them in plain words while quoting the title as the UI shows it.

## Acceptance criteria mapping

| AC | Status |
| --- | --- |
| Findings recorded on the card | Done: this report and the card note |
| Close if an article exists | Not applicable: none in code. Super admin confirms on Platform > Blog |
| Exactly one new article, parses clean | Blocked by the gate. Design steps 1 and 6 |
| Every named piece exists under that name | Names verified in (a) and listed in design step 2; only those may be used |
| Recommendation framing, pilot walk-through | Blocked: no pilot material. Design steps 3 and 5 |
| No customer names or unagreed pilot details | Blocked: needs the consent record. Design step 5 |
| Appears in the Help blog after publish | Manual post route (d), design step 7 |
| Launch articles unchanged, blog-launch.test.ts passes | Guaranteed by not using the launch set |
