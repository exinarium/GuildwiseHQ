# DiceBear 10 upgrade: design (outcome B, stay on 9.x)

The findings and evidence are in [GWP-191-dicebear-v10-upgrade.md](GWP-191-dicebear-v10-upgrade.md), which is the
note the acceptance criteria ask for. This file is the build design that follows from it.

## Question

Can `@dicebear/core`, `@dicebear/lorelei`, `@dicebear/notionists` and `@dicebear/open-peeps` move from `^9.4.2` to
v10 with every stored seed still giving the same face?

## Findings (summary)

- The three style packages **have no v10 release**. In v10 all styles ship as JSON in `@dicebear/styles`, and
  `@dicebear/core` 10 replaces `createAvatar` with `new Avatar(new Style(def), options)`. `backgroundType` and
  `radius` became `backgroundColorFill` and `borderRadius`, and v10 refuses the old names.
- v10 has a new key-based PRNG. **Every seed tested** (15 renders: 5 seeds, including a server-format seed, a non-ASCII
  seed and a long seed, in each of the 3 styles) gives a different face. At 128 px, 72–97 % of pixels differ (17 % in
  one notionists case). 0 of 21 SVGs are byte-equal.
- Forcing the 9.x choices into 10.x through `*Variant`/`*Probability`/`*Color` gives faces that look alike but are not
  pixel-equal (0.3–4.6 % of pixels differ, all along outlines). It would also mean copying about 400 lines of 9.x
  internals into our code. No supported option restores the 9.x output.
- Core 10 is about 42 KB larger gzipped (it bundles validators).
- The repo has **no** Dependabot hold. Dependabot PR #12 bumped only core to 10.7.0. That broke rendering, and
  612534f4 put core back to `^9.4.2`. Without a hold, the PR comes back.

## Options

See the note. 1) Stay on 9.x LTS, add a fixture test and a major hold. 2) A 9.x compatibility layer on 10.x. 3) Accept
new faces (owner decision). 4) Re-seeding (cannot keep faces, rejected).

## Recommendation

**Outcome B (option 1).** No package, lockfile, `faces.ts`, shared, server or data change. The builder adds:

### 1. Fixed-seed render test with 9.x fixtures (guards stored faces)

New `apps/web/src/test/faces-render.test.ts` and fixture `apps/web/src/test/fixtures/faces-v9.json`.

- Seeds (at least 5; use exactly these so the note's evidence matches): `agent-ada`, `k3x9q2mz`, `0a1b2c3d`,
  `Zoë Ångström-Ñúñez 李雷`, `a-very-long-seed-value-0123456789abcdefghijklmnopqrstuvwxyz-0123` (64 characters, the
  `AvatarSeedSchema` maximum; the scratch evidence used a 66-character version of this seed, and the result is the
  same). Optionally add one real seed from `randomAvatarSeed` with a fixed `random` stub.
- For each of `AVATAR_STYLES` (import it from `@aom/shared`, do not hard-code the list): `await loadFaceStyle(style)`,
  then `faceUri(seed, style)`. Decode the SVG with `decodeURIComponent(uri.slice(uri.indexOf(',') + 1))`. Compare
  `sha256(svg)` and `svg.length` with the fixture entry `{ style, seed, sha256, length }`. Also assert that the URI
  starts with `data:image/svg+xml;` and that the SVG starts with `<svg`.
- Store hashes, not the full SVGs (about 180 KB). Use `createHash` from `node:crypto`; it works under the vitest jsdom
  environment.
- Build the fixture once on the **current 9.x lockfile** (for example, write the test so a missing fixture prints the
  computed JSON, then commit the output and remove that branch). Do **not** use `toMatchSnapshot`: `vitest -u` would
  re-baseline it silently.
- Failure message: name the style and seed, and say that the change alters stored faces and needs an owner decision
  (link the note).
- `faces.ts` keeps module-level caches. They are harmless here because each (style, seed) key is computed once.

```ts
import { createHash } from 'node:crypto';
import { AVATAR_STYLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { faceUri, loadFaceStyle } from '../lib/faces.ts';
import fixture from './fixtures/faces-v9.json';

const svgOf = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
describe('generated faces stay the same for stored seeds', () => {
  for (const style of AVATAR_STYLES) {
    it(`${style} matches the 9.x reference`, async () => {
      await loadFaceStyle(style);
      for (const ref of fixture.filter((f) => f.style === style)) {
        const svg = svgOf(faceUri(ref.seed, style) ?? '');
        expect({ seed: ref.seed, sha256: createHash('sha256').update(svg).digest('hex'), length: svg.length })
          .toEqual({ seed: ref.seed, sha256: ref.sha256, length: ref.length });
      }
    });
  }
});
```

Also assert that the fixture has at least 5 seeds per style, so an emptied fixture cannot pass.

### 2. Dependabot major hold with a comment (`.github/dependabot.yml`, npm entry)

```yaml
    ignore:
      # DiceBear 10 draws a different face for every stored avatar seed (new seed algorithm, and the styles moved to
      # @dicebear/styles), and a core-only bump breaks rendering. Stay on 9.x until that is decided:
      # docs/investigations/GWP-191-dicebear-v10-upgrade.md
      - dependency-name: '@dicebear/*'
        update-types: ['version-update:semver-major']
```

Only majors are held, so 9.x minor and patch updates (and their security fixes) still come in the grouped PR. Put
`ignore` after `groups` in the `npm` block. Run `actionlint` only if it is configured for this file (it is for
workflows). There is no test that reads `dependabot.yml`. Check the YAML parses, for example with
`node -e "require('yaml')"` if the package is available, or by eye.

### 3. Docs

The note `docs/investigations/GWP-191-dicebear-v10-upgrade.md` is written. The builder adds only the measured
production-build size of the avatar chunks, if wanted (they are unchanged).

### Follow-up for the owner (not in this card)

Decide whether to accept new faces in order to use DiceBear 10/11 (option 3 in the note). It is filed as a backlog
suggestion.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/test/faces-render.test.ts` | new |
| `apps/web/src/test/fixtures/faces-v9.json` | new (15 entries) |
| `.github/dependabot.yml` | add the `ignore` block |
| `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/lib/faces.ts`, `packages/shared/**`, `apps/server/**` | **no change** |

## Risks

- Fixture hashes captured on a different 9.x patch: capture with the locked `core@9.4.3` / styles `9.4.2` (frozen
  lockfile install). A future 9.x patch that changes markup fails the test. That is intended, and it is visible.
- JSON import: `tsconfig.base.json` sets `resolveJsonModule: true`, and other web tests already import JSON, so
  `import fixture from './fixtures/faces-v9.json'` typechecks.
- Lint (biome) may want the fixture formatted. Run the repo's lint script.

## Acceptance criteria

| AC | How it is met |
| --- | --- |
| Investigation note with API, option names per style, output format, seed determinism and evidence | `GWP-191-dicebear-v10-upgrade.md` (tables for API, options, components per style, output and size; seeds and the pixel and markup results) |
| Outcome A items (versions, fixture test passing on v10, hold removed, deployed checks) | Not applicable: outcome B. v10 cannot keep faces (evidence in the note). The fixture test is still added on 9.x, as test plan step 1. |
| Outcome B: no package change, the note says why and what is needed, the hold stays with a comment linking the note | No package or lockfile change. The note's "Recommendation" section lists the decisions needed. The hold did not exist, so it is **added** (major-only `ignore`) with the comment linking the note. |
| No stored seed, `AvatarStyle` value or endpoint change, no migration | None of those files are touched. |
| Tests | `faces-render.test.ts` (new), plus the existing `lib.test.ts` and `avatar-picker.test.tsx`, typecheck and lint for apps/web. No E2E or visual change, because rendering is unchanged. |
