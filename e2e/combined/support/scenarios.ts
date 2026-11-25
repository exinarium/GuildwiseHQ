/**
 * Every scenario id of the combined run and how it is handled (DESIGN section 5, 6). The reporter prints one line per id:
 *  auto      a spec must report it; a missing id is a FAIL (crash, typo), never omitted
 *  owner     needs a human or the real machine: listed with the reason, steps in COMBINED-QA.md
 *  pending   a later build (group C or D) has not landed; shown so it cannot be forgotten
 *  covered   proven by a unit or server test, which the run does not repeat
 */
export type Handling =
  | { kind: 'auto'; title: string }
  | { kind: 'owner'; title: string; reason: string }
  | { kind: 'pending'; title: string; build: string }
  | { kind: 'covered'; title: string; by: string };

export const SCENARIOS: Record<string, Handling> = {
  A1: {
    kind: 'auto',
    title: 'DevOps installs: toolchain registered, builder `aom devops install npm add` (stub npm)',
  },
  A2: {
    kind: 'auto',
    title: 'CEO override request: refused, HEAD unchanged, refused refs kept, no desk alert',
  },
  A3: { kind: 'auto', title: 'Sabotage (stash.lock): HEAD back at the old head' },
  A4: { kind: 'auto', title: 'Not fully reverted: exactly one desk alert naming the folder' },
  A5: {
    kind: 'auto',
    title:
      'Concurrency: other cards are reviewed, merged and built during a DevOps request: no revert, no violation, no alert',
  },
  'A5-mention': {
    kind: 'owner',
    title: '@mention with edit on a third card during a long DevOps request',
    reason: 'the chat edit turn needs the CEO/chat runtime (real Claude); steps in COMBINED-QA.md',
  },
  A6: { kind: 'auto', title: 'Stop / usage limit right after a write: reverted all the same' },
  A7: {
    kind: 'auto',
    title:
      'Architect with placeholder stubs (scripted lane): no architect_edited_non_docs, no stubs in WIP or diff',
  },
  'A7-L2': {
    kind: 'auto',
    title: 'Architect lane 2: real claude + real bwrap + fake API, runner functions on its worktree',
  },
  A8: {
    kind: 'auto',
    title: 'GIT-1: committed stubs removed by the builder: no tree_revert; finalize after main moved',
  },
  A9: {
    kind: 'auto',
    title: 'Empty repository: one desk item, one click makes the first commit, second click refused',
  },
  A10: {
    kind: 'auto',
    title: 'Commit as: prompt prefilled, no no_commit_identity, New card prompt when none',
  },
  B1: { kind: 'auto', title: 'Install off: exactly one hold (approvals page, Desk item, blocked card)' },
  B2: { kind: 'auto', title: 'Local No ends the request: no retry, no second hold' },
  B3: { kind: 'auto', title: 'vault.configure held item names its target' },
  C1: {
    kind: 'auto',
    title:
      'AC1 the tidy-up examines the repository and leaves main, develop, release and unpushed branches alone (a server NAMING a protected branch is a unit-test item)',
  },
  C2: {
    kind: 'covered',
    title: 'AC2 saved ref before remote delete',
    by: 'runner unit tests of runner-authority-fixes',
  },
  C3: {
    kind: 'auto',
    title:
      'AC3 the approval settings are sealed: an outside edit makes everything ask, policy accept is the way back',
  },
  C4: {
    kind: 'auto',
    title:
      'AC4 a toolchain DevOps registers waits for the owner (Desk step with the exact command); agents get it only after',
  },
  C5: {
    kind: 'covered',
    title: 'AC5 scan shift IPC refusals',
    by: 'runner unit tests of runner-authority-fixes',
  },
  C6: { kind: 'covered', title: 'AC6 lifecycle scripts', by: 'runner unit tests of runner-authority-fixes' },
  C7: {
    kind: 'covered',
    title: 'AC7 closed Desk notice not re-created',
    by: 'server test of runner-authority-fixes',
  },
  C8: {
    kind: 'covered',
    title: 'AC8 no widening of sandbox, guard or authority',
    by: 'existing runner/server/shared suites',
  },
  C9: {
    kind: 'auto',
    title: 'AC9 a DevOps shift that moves a card branch is put back and kept off the branch',
  },
  C10: {
    kind: 'owner',
    title: 'AC10 a CEO full-power turn cannot write in a card worktree, or start inside one',
    reason:
      'the full-power turn is a real Claude turn in the outer box (needs a Claude login); steps in COMBINED-QA.md',
  },
  C11: {
    kind: 'owner',
    title: 'AC11 a DevOps chat change in a card worktree is reverted and reported',
    reason:
      'a DevOps chat turn is a real Claude turn; the same after-shift fence is proven on shifts by A2-A4 and C9; steps in COMBINED-QA.md',
  },
  C12: {
    kind: 'auto',
    title:
      'AC12 each DevOps switch (install, Docker, paths) and the policy and card-folder fences are enforced by the runner guard',
  },
  D1: {
    kind: 'auto',
    title: 'DevOps in the inner box needs no click: a request runs, nothing waits on this computer',
  },
  D2: {
    kind: 'auto',
    title: 'One yes covers one exact job: the identical request runs outside the box with no new yes',
  },
  D3: {
    kind: 'auto',
    title:
      'A changed job asks again (and names the change); an unchanged re-dispatch does not; a local No ends it; a stale yes is refused (409)',
  },
  D4: {
    kind: 'auto',
    title:
      'The tidy-up is a fixed routine: no question when ticked, one yes when not; protected branches untouched',
  },
  D5: {
    kind: 'auto',
    title:
      'The local limit caps every Desk grant (Docker, folders); private folders refused; raising it locally gives Docker',
  },
  D6: {
    kind: 'auto',
    title:
      'When the box cannot start: refused with a plain reason and one devops.box step; works again after the fix',
  },
  D7: {
    kind: 'auto',
    title:
      'The tool-download tick (row 8): without it an environment prepare with installs asks once, with it nothing asks',
  },
  'D-box': {
    kind: 'owner',
    title:
      'The real box: Docker through the gatekeeper, the outer box network, relayed subscription login, CEO full power outside',
    reason:
      'bwrap, the egress and model proxies and Docker need a real Claude login and the real machine; steps in COMBINED-QA.md',
  },
  E1: {
    kind: 'auto',
    title:
      'F4: accept without consent gives no hire, a member pairing does not serve the joined org; with consent it does',
  },
  E2: {
    kind: 'owner',
    title: 'Start-up refusal of a root-equivalent runner user: exit 78, reason on the workstation page',
    reason:
      'needs a root-equivalent user (docker group or passwordless sudo): this account is neither, and the check must not start a real runner',
  },
  E3: {
    kind: 'owner',
    title: 'The installer refuses a tampered --from-file release',
    reason: 'needs the root step of the installer (sudo)',
  },
  E4: {
    kind: 'owner',
    title: 'GPU: card shows nvenc, preview renders, AOM_VIDEO_GPU=off gives cpu + one mail, revoke gives 401',
    reason: 'needs the GPU render worker on the UAT machine',
  },
  E5: {
    kind: 'owner',
    title:
      'Browser look at Platform > Security (three locked toggles), the step-up dialog, the workstation page',
    reason: 'the UAT CA is untrusted in the harness; the locked toggles are a hosted-build setting',
  },
  E6: {
    kind: 'auto',
    title:
      'The approvals page refuses a second browser until it is paired (host, form post, forged sign-in too)',
  },
  'E6-cli': {
    kind: 'owner',
    title: 'The copy-paste commands paste and run; yt-dlp sits in the runner home',
    reason:
      '`approve` needs a person typing yes at a terminal by design; yt-dlp is installed by the real installer',
  },
  E7: {
    kind: 'auto',
    title:
      'Reconnect after a server restart; same-account re-link keeps the workstation; another account is refused',
  },
  'E7-grant': {
    kind: 'owner',
    title: 'A stale DevOps grant is remapped after a reinstall',
    reason: 'needs the real reinstall (unit-covered by setup-stale-grant.test.ts)',
  },
  E8: {
    kind: 'owner',
    title: 'F3 umask on a --runner-user current install',
    reason: 'needs the real installer',
  },
  'O-reinstall': {
    kind: 'owner',
    title: 'Reinstall with the sudo installer, choices screen, pairing code',
    reason: 'needs sudo, the real service user and docker-svc',
  },
  'O-claude': {
    kind: 'owner',
    title: 'Real Claude: Forge installs a real Node; placeholders under a real shift',
    reason: 'needs a real Claude login and the real machine',
  },
  'O-npm': {
    kind: 'owner',
    title: 'Real-network `npm add left-pad`',
    reason: 'the egress proxy refuses loopback by design; needs the real network',
  },
  'O-passkey': {
    kind: 'owner',
    title: 'Browser passkey approvals',
    reason: 'real authenticator (automatable later with a virtual one; not in A/B scope)',
  },
  'O-uat': {
    kind: 'owner',
    title: 'UAT deploy, exposure checks, live runner reconnect',
    reason: 'the harness never touches UAT or the live runner',
  },
};

export const idsInTitle = (title: string): string[] =>
  [...title.matchAll(/\[([A-E]\d{0,2}(?:-L2)?)\]/g)].map((m) => m[1] as string);
