# Accounting industry article: findings on release/1.6.0 and placement

## Question

Before an article on the accounting industry bundle is written:

- (a) Do the bundle and its playbooks exist in the code, and under which names?
- (b) Have its playbooks run on pilot organisations?
- (c) Does an article for this industry already exist?
- (d) Where must a new article go so that it ships?

The card's rule: if the bundle or its playbooks do not exist, or have not run on a pilot, the card is blocked and no article is written.

All findings are from `origin/release/1.6.0` (tip `5abe461d`). The card branch has the same content: `git diff HEAD origin/release/1.6.0` is empty for the rule packs, journey templates, business roles, business workflows, brief playbooks, the blog launch set, the launch migration and the shared blog package.

## Findings

### (a) The bundle in code

No code object is called an "industry bundle". There is no bundle table, constant, type or screen. The phrase appears only in the rule-pack description. These are the pieces an accounting firm would use:

| Piece | Name in the product | Where | Accounting specific? |
| --- | --- | --- | --- |
| Rule pack | **Accounting firms** (id `accounting`, kind `industry`, `industry: 'accounting'`). Description: "Accounting firms: recommended rules for the release 1.4.0 industry bundle." | `packages/shared/src/ledger/rule-packs.ts:145-165`. Installed from the Rule packs dialog, "Industry" group (`apps/web/src/components/RulePacksDialog.tsx`) | Yes |
| Rules in that pack | "bank-rec exception summary (read-only)", "FICA human sign-off", "Never: verify identity, file to SARS/courts". All three are `agent_instruction`: agents are told the rule, but the server does not block a violation (`SERVER_CHECKS` is empty) | same file | Yes |
| Journey template | **None for accounting.** The only template is "Rentals: lead to monthly rent" (real estate) | `packages/shared/src/journeys/templates.ts` | n/a |
| Business workflows | business-enquiry, business-follow-up, business-document-request, business-report, business-quote, business-reminder | `packages/shared/src/workflows/business.ts` | No, generic |
| Business roles | Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer ("Chase (documents), Remind (deadlines)"; never "verify identity or file to SARS/courts"), Marketing & Reputation, Operations Analyst (tools include "accounting read-only"), Personal Assistant | `packages/shared/src/roles/business.ts:60-110` | No, generic. Compliance Officer and Operations Analyst fit accounting best |
| Brief playbooks | **Morning plan**, **Weekly owner brief** (the only two) | `packages/shared/src/schedules/brief-playbooks.ts:32,50`, installed via `apps/server/src/commands/brief-playbooks.ts` | No, generic |
| Default rule packs | Core rules, Outbound | rule-packs.ts | No |

Conclusion for (a): **the code has no accounting playbook, no accounting role and no accounting journey template.** The only accounting-specific piece is the "Accounting firms" rule pack with three rules. Nothing in the code says which roles, playbooks and packs make up "the accounting bundle". That grouping is described only in the research files (`industry-roadmap.md` and the 2026-10-27 game plan, cited as `game-plan` in the rule sources). Those files are not on this workstation: both vault clones hold only `org/` and `projects/gwp/{delivery,graph}`, and there are no card attachments. Ledger 61b40ee5 confirms this.

`packages/shared/src/capabilities/pack-team.ts` (named on the card) handles hiring agents from capability packs. It holds no industry roles.

### (b) Pilot runs

**There is no evidence that any accounting playbook has run on a pilot organisation.** I searched the tree, both vaults and the card attachments for "pilot", "accounting", "accountant" and "industry-roadmap". None of the hits is a pilot run record, and there are no pilot notes, outcomes or consent records. As (a) shows, there is no accounting playbook that could have run.

### (c) Existing article

**None.** `apps/server/src/blog/launch/` holds exactly four launch articles (`ai-automation-for-small-businesses-2026`, `from-idea-to-tested-change`, `keeping-humans-in-charge-of-ai-agents`, `what-is-an-ai-agent-team`), and none is about an industry. The published platform blog cannot be seen from here. The super admin should check Platform > Blog for a hand-written accounting post before writing starts.

### (d) Where an article must go

**Launch set (`apps/server/src/blog/launch/*.md`): rejected.**
- It does not reach existing installs. `migrateBlogLaunch` returns early once `blog-launch-2026-10` is in `data_migrations` (`apps/server/src/data-migrations/blog-launch.ts:60`), so the hosted platform and every install that has booted once never import a new file.
- `apps/server/test/blog-launch.test.ts` asserts `toHaveLength(4)` six times (lines 48, 60, 62, 71, 81, 105), and `docs/BLOG-API.md` names the four articles. Both would have to change.
- Launch posts carry the `launch` flag. They are not shared to social networks and not included in the digest, which is wrong for a marketing article.
- Shipping it to existing installs would need a new data migration, and the card forbids that.

**Manual post in Platform > Blog (origin `manual`), or `POST /api/v1/blog/posts` with a `blog:write` key: recommended.** It goes live on the platform, follows the normal review and share rules, and needs no product code or migration. The Markdown source lives in the repo as documentation at `docs/blog/industry/accounting.md`, in the launch frontmatter format. A small test runs it through `parseBlogArticle` and `contentWarnings`.

**Tags:** `business-mode` and `marketing` are not valid. `BLOG_TAGS` (`packages/shared/src/blog/constants.ts`) is a fixed list: ai-agents, automation, llm-ops, case-study, how-to, industry-news. Use `case-study` (if pilot-based) or `how-to`, plus `automation`. The cover `defaultKey` must be one of these keys.

This matches the owner's answer to the GWP-162 question (ledger 28ab23a7), which says to apply the same to GWP-163.

## Options

| Option | Result | Meets the card? |
| --- | --- | --- |
| A. Block until accounting playbooks have run on a pilot (recommended, owner already decided for the group) | Card parked. The owner or BA attaches `industry-roadmap.md`, anonymised pilot notes and the consent record. The article is then written and posted manually | Yes: this is the card's gate |
| B. Re-scope to a "recommended setup" article with an illustrative week | Names only the built pieces | Drops the pilot AC and the gate. This is the owner's call, not the architect's |
| C. Close | No article | Loses the article the owner wants |

## Recommendation and design

**Gate not met: the card stays blocked (option A), per ledger 28ab23a7.** No article is written and no file other than this report changes now. When the inputs are attached, build as follows:

1. Read `industry-roadmap.md` for the bundle's intended contents. Name only pieces that exist under these exact product names: rule pack "Accounting firms" and its three rules; roles Front Desk, Follow-up Assistant, Billing Clerk, Compliance Officer, Marketing & Reputation, Operations Analyst, Personal Assistant; playbooks "Morning plan" and "Weekly owner brief"; rule packs "Core rules" and "Outbound"; the business card types (enquiry, follow-up, document request, report, quote, reminder). Do not mention a journey template: none exists for accounting. If the roadmap names an accounting playbook that the code lacks, leave it out. Describe the grouping as "these pieces work well together", never as a plan or tier.
2. Be honest about enforcement. The rules are agent instructions, and Guildwise does not itself block a violation. Do not claim the server enforces FICA sign-off or blocks SARS filing. Say the agent is instructed never to do these and that a person signs off.
3. Base the walk-through only on the supplied anonymised pilot notes. Use no names, places, figures or client details without recorded consent.
4. Write the source at `docs/blog/industry/accounting.md` in the launch frontmatter format (title, slug, summary, tags, cover, at least 3 sources, seo, social captions). Tags come from `BLOG_TAGS` only. Every Markdown link must appear in `sources`, so no contentWarning fires.
5. Add a test, for example `packages/shared/test/blog-industry-articles.test.ts`, or a server test if `contentWarnings` from `apps/server/src/commands/blog.ts` is needed. It parses every `docs/blog/industry/*.md` with `parseBlogArticle` and asserts no warnings, and can be shared with GWP-162 and GWP-164. Leave the launch set, `blog-launch.test.ts` and the migration untouched.
6. The super admin posts the article in Platform > Blog. The tester checks the Help blog list and BlogArticleView.

## Acceptance criteria mapping

| AC | Status |
| --- | --- |
| Findings recorded on the card | Done: this report, the handoff summary and the brief |
| Close if an article exists | Not applicable: none exists in code. The super admin confirms on Platform > Blog |
| Exactly one new article, parses clean | Blocked by the gate. Design steps 4-5 |
| Every named piece exists under that name | Names verified in table (a). Use only those |
| Recommendation framing + pilot walk-through | Blocked: there is no pilot material |
| No customer or pilot data without consent | Blocked: needs the consent record |
| Appears in the Help blog after publish | Manual post route (d), tester check |
| Launch articles unchanged, blog-launch.test.ts passes | Guaranteed by not using the launch set |
