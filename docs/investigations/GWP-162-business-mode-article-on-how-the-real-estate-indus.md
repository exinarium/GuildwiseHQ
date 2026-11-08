# Real estate industry article: findings on release/1.6.0 and placement

## Question

Before an article on the real estate industry bundle is written:

- (a) Does the bundle and its playbooks exist in the code, and under which names?
- (b) Have its playbooks run on pilot organisations?
- (c) Does an article for this industry already exist?
- (d) Where must a new article go so that it actually ships?

The card's rule: if the bundle or its playbooks do not exist, or have not run on a pilot, the card is blocked and no article is written.

All findings are from `origin/release/1.6.0`. The card branch (based on `main`) has identical content in every file listed below. `git diff HEAD origin/release/1.6.0` is empty for the rule packs, journey templates, business roles, brief playbooks, the blog launch set, the launch migration and the shared blog package.

## Findings

### (a) The bundle in code

No code object is called an "industry bundle". There is no bundle table, constant, type or UI screen. The word appears only in one rule-pack description. The pieces in the product that a real estate business would use are listed below. All of them except the rule pack and the journey template are generic business-mode pieces with no industry tie.

| Piece | Name in the product | Where | Real estate specific? |
| --- | --- | --- | --- |
| Rule pack | **Real estate** (id `real-estate`, kind `industry`, `industry: 'real_estate'`). Description: "Real estate (estate agencies, rentals): recommended rules for the release 1.4.0 industry bundle." | `packages/shared/src/ledger/rule-packs.ts:121-143`; installed from the Rule packs dialog, "Industry" group (`apps/web/src/components/RulePacksDialog.tsx:137`) | Yes |
| Rules in that pack | "price/value statements approved", "no marketing without consent", "legal notices human", "ID verification human", "FICA human sign-off". All are `agent_instruction` (agents are told; the server does not block a violation, `SERVER_CHECKS` is empty) | same file | Yes |
| Journey template | **Rentals: lead to monthly rent**, with steps Lead, Viewing, Application, Wait for forms and documents (5 days, 2 reminders, then escalate), Screening, Approval (project owner gate "Approve this application?"), Lease signed, Deposit and first-rent invoice, Move-in, Monthly rent (loops "Next month") | `packages/shared/src/journeys/templates.ts:52-101`; Journeys > New journey > template gallery | Yes (rentals only, not sales) |
| Business workflows used by that template | business-enquiry, business-follow-up, business-document-request, business-report, business-quote, business-reminder | `packages/shared/src/workflows/business.ts:5-12` | No, generic |
| Business roles | Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer, Marketing & Reputation, Operations Analyst, Personal Assistant | `packages/shared/src/roles/business.ts:61-110` | No, generic |
| Brief playbooks | **Morning plan**, **Weekly owner brief** (the only two) | `packages/shared/src/schedules/brief-playbooks.ts:28-66`, installed via `apps/server/src/commands/brief-playbooks.ts` | No, generic |
| Default ledger rule packs | Core rules, Outbound | rule-packs.ts | No, general |

Conclusion for (a): **the code has no real estate playbook and no real estate role.** The only industry-specific pieces are the Real estate rule pack and the Rentals journey template. Nothing in the code says which roles, playbooks and packs make up "the real estate bundle". That grouping is only described in the research files (`industry-roadmap.md` and the 2026-10-27 game plan), which the rule-pack sources cite. Those files are not on this workstation (ledger 61b40ee5 confirms it, and I re-checked both vault clones today: `projects/gwp` holds only `delivery/` and `graph/`).

`packages/shared/src/capabilities/pack-team.ts` (named on the card) is about hiring agents from capability packs. It holds no industry roles.

### (b) Pilot runs

**No evidence that any real estate playbook has run on a pilot organisation.** I searched the release/1.6.0 tree, both knowledge vaults and the card attachments for "pilot", "estate agen", "industry-roadmap" and "real estate". The only hits for "pilot" in the repo are test fixtures, the Boardroom feature, the licensing note D10 in `docs/design/organizations.md` and a design rationale in the GWP-30 report. None of them is a pilot run record. No pilot notes, run logs, outcomes or consent records exist on this workstation. Also, as (a) shows, there is no real-estate playbook that could have run. The generic Morning plan / Weekly owner brief and the Rentals journey might have been used by a pilot, but nothing here records that.

### (c) Existing article

**None.** `apps/server/src/blog/launch/` has exactly the four launch articles: `ai-automation-for-small-businesses-2026`, `from-idea-to-tested-change`, `keeping-humans-in-charge-of-ai-agents`, `what-is-an-ai-agent-team`. None of them is about an industry. Nothing on this workstation shows the published platform blog, so the super admin should check Platform > Blog for a hand-written real estate post before anything is written.

### (d) Where an article must go

Option 1: the launch set (`apps/server/src/blog/launch/*.md`). This **does not ship to existing installs.** `migrateBlogLaunch` (`apps/server/src/data-migrations/blog-launch.ts:55-60`) returns early when `blog-launch-2026-10` is already in `data_migrations`. Every install that has booted once, the hosted platform included, will never import a fifth file. It would appear only on brand-new installs. It also has these costs:
  - `apps/server/test/blog-launch.test.ts` asserts `toHaveLength(4)` five times (lines 48, 60, 62, 71, 81, 105), so the test must change. That clashes with the AC "blog-launch.test.ts still passes" in spirit.
  - `docs/BLOG-API.md:238` names the four articles and must change.
  - Launch posts carry the `launch` flag, so they are **not shared to social networks and not in the digest**. That is the wrong result for a marketing article.
  - Making it ship on existing installs would need a new data migration, which the card forbids ("do not change the launch migration logic").

Option 2: a manual post in Platform > Blog (super admin, origin `manual`, `MANUAL_POST_LIMITS`), or a `POST /api/v1/blog/posts` with a `blog:write` key (`docs/BLOG-API.md` "Submit"). This publishes on the live platform, goes through the normal review and share rules, and needs no code change, test change or migration. **This is the recommended placement.** The Markdown source can live in the repo as documentation, for example `docs/blog/industry/real-estate.md`, in the same frontmatter format as the launch files. A small shared test that runs it through `parseBlogArticle` and `contentWarnings` would cover the AC "passes parseBlogArticle without errors and without contentWarnings".

Tags: `business-mode` and `marketing` are **not** valid blog tags. `BLOG_TAGS` in `packages/shared/src/blog/constants.ts` is a fixed list (ai-agents, automation, llm-ops, case-study, how-to, industry-news), and a tag outside it fails the schema. The nearest are `case-study` (if the piece draws on a real pilot) or `how-to`, plus `automation`. The cover `defaultKey` must be one of the same keys.

## Comparison of the options for the card

| Option | What happens | Meets the card? |
| --- | --- | --- |
| A. Block until the pilots have run (recommended) | Card parked. The owner/BA supplies `industry-roadmap.md` (the bundle definition), anonymised pilot notes of a real estate organisation using these pieces, and the consent record. The article is then written and posted manually in Platform > Blog | Yes. This is the gate the card and the owner's 30 Oct note set ("once its playbooks run on pilots") |
| B. Re-scope to a "recommended setup" article now | The article names only built pieces (Real estate rule pack, Rentals journey template, the business roles and workflows, Morning plan / Weekly owner brief) and shows an illustrative week, clearly not drawn from a pilot | Needs the owner to drop the pilot walk-through AC and the gate. Risk: it presents a "bundle" the product does not show as one thing |
| C. Close the card | No article | Loses the article option the owner wants |

## Recommendation

**Option A: the card is blocked.** Gate (a) is only partly met: there is a rule pack and a journey template, but no real estate playbook or role. Gate (b) is not met: there is no evidence of pilot runs. By the card's own rule, no article is written now. GWP-163 (accounting) and GWP-164 (law) are in the same position: they have a rule pack each, no industry playbook, no journey template and no pilot evidence. The same question applies to them.

When unblocked, the build should look like this:

1. Read `industry-roadmap.md` for the bundle's intended contents. Name only pieces that exist under these exact product names: rule pack "Real estate" and its five rules; journey template "Rentals: lead to monthly rent" and its step labels; roles Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer, Marketing & Reputation, Operations Analyst, Personal Assistant; playbooks "Morning plan" and "Weekly owner brief"; rule packs "Core rules" and "Outbound". Describe the grouping as a recommendation ("these pieces work well together"), never as a plan or tier.
2. Say honestly that the rules are agent instructions. Guildwise does not block a violation itself (`ENFORCED_BY_EXPLAIN`), so the article must not claim the server enforces FICA sign-off.
3. Base the walk-through only on the supplied, anonymised pilot notes. Use no names, places, figures or details without recorded consent.
4. Write the source at `docs/blog/industry/real-estate.md` (launch frontmatter format: title, slug, summary, tags, cover, sources ≥3 as the launch test expects of launch files, seo, social captions). Tags from `BLOG_TAGS` only (`case-study` or `how-to`, plus `automation`). Every Markdown link must be in `sources`, so there is no contentWarning.
5. Add a test (for example `packages/shared/test/blog-industry-articles.test.ts`, or a server test if `contentWarnings` is needed from `apps/server/src/commands/blog.ts`). It parses the file with `parseBlogArticle` and asserts no warnings. Leave the launch set, `blog-launch.test.ts` and the migration untouched.
6. The super admin posts it in Platform > Blog. The tester checks the Help blog list and BlogArticleView.

## Re-check, 2026-11-08 (second design pass)

The card came back to design with nothing new attached. Re-checked against `origin/release/1.6.0` at 285e8e1d:

- `git diff HEAD origin/release/1.6.0` is still empty for the rule packs, journey templates, business roles, brief playbooks, the blog launch set, the launch migration and the shared blog package.
- `git grep -i "real estate|estate agen"` on release/1.6.0 finds only `packages/shared/src/ledger/rule-packs.ts`, its test and the ledger API type. There is still no real estate playbook or role.
- There is still no `industry-roadmap.md`, game plan, pilot notes or consent record in either knowledge vault, and the card has no attachments.

The decision on the card (keep blocked until the owner or BA attaches the roadmap, anonymised pilot notes and the consent record) still applies. The findings, placement and build design above are unchanged. The card must not go to build until that material is attached.

## Re-check, 2026-11-08 (third design pass)

The card came back to design again with nothing new attached. Re-checked against `origin/release/1.6.0` at 5471bd37:

- The 10 commits since 285e8e1d cover intake ticket references in prompts and drafts, per-kind relay body limits and the Business view Test services panel. In the relevant areas only `apps/server/src/commands/drafts.ts`, `leak-check.ts` and `outbox.ts` changed, and none of them touches rule packs, roles, playbooks, journey templates or the blog.
- `git grep -i "real estate|estate agen|real_estate"` on release/1.6.0 still finds only `packages/shared/src/ledger/rule-packs.ts`, the ledger API type and two investigation docs. There is still no real estate playbook or role.
- Neither knowledge vault mentions `industry-roadmap.md`, real estate or pilots, and the card has no attachments.

Nothing in the findings, placement or build design changes. Each time the "keep blocked" question is answered, the card returns to design, so another design pass cannot move it on. What it needs is an owner action: attach the inputs, re-scope (option B), or close (option C).

## Owner decision, 2026-11-08 (fourth design pass): close with no article

The owner answered the open question (ledger 75e14977): "Owner closes GWP-162 (and GWP-163/164) without an article, or moves them back to the backlog until pilots exist." That is option C from the comparison above.

What this means for the card:

- **No article is written.** Nothing is added to `docs/blog/industry/`, the launch set, the migration, the schema, the tests or guildwise-cloud. Nothing is posted in Platform > Blog.
- The build design in "Recommendation" (steps 1-6) is kept only as a reference in case a new card is raised after real estate pilots have run. It is **not** to be built under GWP-162.
- The card closes with no content change. The only commits on the card branch are this report.
- The same decision applies to GWP-163 (accounting) and GWP-164 (law).

If the topic is raised again, a new card needs these before design: `industry-roadmap.md` (Real estate section), anonymised pilot notes showing the pieces in use, and the pilot consent record.

## Acceptance criteria mapping

Final status after the owner's decision: AC 1 (findings recorded) is met by this report. The remaining ACs no longer apply because the owner closed the card without an article. AC 8 holds trivially: launch articles and `blog-launch.test.ts` are untouched.

| AC | Status |
| --- | --- |
| Findings recorded on the card | Done: this report and the card comment |
| Close if an article exists | Not applicable: none exists in code. The super admin should confirm on Platform > Blog |
| Exactly one new article, parses clean | Blocked (gate). Design: step 4-5 above |
| Every named piece exists under that name | Names verified in the table in (a). Only those may be used |
| Recommendation framing + pilot walk-through | Blocked: there is no pilot material |
| No customer names / pilot details without consent | Blocked: needs the consent record |
| Appears in the Help blog after publish | Manual post route (d), tester check |
| Launch articles unchanged, blog-launch.test.ts passes | Guaranteed by not using the launch set |
