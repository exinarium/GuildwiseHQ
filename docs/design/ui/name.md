# Name

Only user-facing branding changes. Package names (`@aom/*`), the `aom` CLI, `aom-runner`, env vars (`AOM_*`), DB names and the repo folder stay as they are.

## What the name has to do

The product is a floor of AI agents that a single manager runs: hire and fire, assign work through stages, answer questions at a desk, read the shift log. The name should feel like *a person in charge of a crew*, be short (5 to 8 letters), easy to say aloud, work as a lowercase wordmark, and not collide with a well-known developer product.

## Five candidates

| # | Name | Rationale | Collision check (by reasoning, no web access) |
| --- | --- | --- | --- |
| 1 | **Muster** | To muster is to call the crew together for roll call, and to "pass muster" is to survive inspection, which is exactly the Review and Test stages. One word covers hiring, assembling and quality. Reads well as `muster` in lowercase and as an `M` monogram. | No major dev product. Generic English word, so expect small unrelated hits (npm package names, local scheduling tools). Owner should still run an npm, domain and trademark search. |
| 2 | **Brigade** | The kitchen brigade: named stations (spec, build, review, test, finalize) passing work along "the pass" under one head. Strong metaphor for the board. | "Brigade" is a political-engagement app and a civic-tech network. Not a dev tool, but it is a known name. Longer wordmark, less ownable. |
| 3 | **Gaffer** | British for the boss of a crew. Friendly, short, memorable. | "Gaffer" is a VFX software suite and a GCHQ graph database. Developer-adjacent collision, so rejected. |
| 4 | **Guildhall** | The hall where a guild of specialists is run; fits roles, HR board and the desk. | Nine letters, heavy; "Guild" is used by an ML experiment tracker. Feels corporate rather than lively. |
| 5 | **Rota** | A rota is the shift roster; agents work in shifts, and the tool is mostly about who is on. Very short, easy as an icon. | Common word with several scheduling products named Rota; weak as a brand because the product is more than scheduling. |

Rejected on sight: Foreman (a well-known server lifecycle tool and a Ruby process manager), Stagehand (a popular browser automation SDK), Wrangler (Cloudflare CLI), Apiary (API docs product), Hivemind (overused), Dispatch (too generic).

## Pick: **Muster**

Why:

1. **Metaphor fits every feature.** Roll call (hire and the HR board), the gathering of a crew (the board), "pass muster" (review and test gates), "muster" as an inventory of people (the roster).
2. **It is visual.** The `M` is two peaks that converge on one point. That point is the manager's node: the whole logo says "many agents, one person steering". See `logo.svg`.
3. **Short and sayable.** Two syllables, lowercase wordmark has clean geometry (all round-cap strokes, no complex letterforms).
4. **Tone.** Slightly military/maritime, calm and competent, not cute. Fits a self-hosted tool for one serious operator.

Tagline options (use one in the login panel): "Run your crew of agents." / "Your crew. Your call." / "Many agents. One desk."

## Where the name appears (for the builder)

- `index.html` `<title>`: `Muster`. Per page: `Board · WEB · Muster`.
- Sidebar header, login brand panel, accept-invite page, 404.
- Email subjects/bodies in `apps/server` (invitation mail) may still say "Agent Org Manager"; flag to the owner, out of scope for the web app.
- README and USER-GUIDE headings: owner decision, not part of this UI work.
- Keep a plain-text "Agent Org Manager" mention in the About/footer line of the login page only if the owner wants continuity ("Muster, formerly Agent Org Manager"). Decision for the owner.
