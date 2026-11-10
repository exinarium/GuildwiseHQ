# Runner: a Claude chat message too big for argv fails to spawn (E2BIG)

## Question

A chat, mention or brief sent to a Claude Code agent goes on the command line as `claude -p <message>`. Linux refuses
a single argument over 128 KiB (`MAX_ARG_STRLEN`), so a long message fails with `spawn E2BIG` before Claude starts.
How do we send long chat messages on stdin, the way shift prompts already are, without changing anything for short
messages?

## Findings

All line numbers are for `apps/runner/src/adapters/claude-code.ts` on the current main branch.

| Path | Builder | Fallback to stdin | Spawn passes `cmd.stdin` |
| --- | --- | --- | --- |
| Shift | `buildClaudeCommand` (:180) | yes (:181, :184, :230) | yes, `startShiftSession` (:962) |
| Owner turn | `buildClaudeOwnerTurnCommand` (:302) | yes (:307, :310, :350) | yes, `startOwnerTurn` (:1118) |
| **Chat / mention / brief** | `buildClaudeChatCommand` (:244) | **no**, always `'-p', input.message` (:246-247) | **no**, `startChatSession` (:1076-1104) |

- `MAX_ARGV_PROMPT_BYTES = 64 * 1024` (:104) is already exported. Both existing fallbacks measure the size with
  `Buffer.byteLength(text)` (UTF-8 bytes) and compare with `>`, so exactly 64 KiB stays on argv.
- `ClaudeCommand.stdin?: string` (:83-89) already exists and needs no change.
- `spawnSession` (`apps/runner/src/adapters/process-session.ts:23`, :105) already supports `input`. When `input` is
  set it is written to the child's stdin and stdin is then closed (execa `input`). Without it stdin is `'ignore'`. **No
  change is needed in process-session.ts.**
- `claude -p` with no prompt argument reads the prompt from stdin. The shift path relies on this today, and the owner
  turn relies on it together with `--resume`, so a resumed chat on stdin is already proven.
- Other adapters: Codex (`codex.ts:422`), Gemini (`gemini.ts:278`) and OpenCode (`opencode.ts:225`) always send the
  prompt on stdin, for shifts and chats. The owner turn already has the fallback. **No follow-up card is needed.** The
  chat builder is the only Claude builder without the fallback.
- Tests that exist today:
  - `apps/runner/test/start-failure.test.ts`: the shift-path tests for this exact bug. One shows that a spawn with a
    huge argv returns `startFailed` with E2BIG. One checks the builder's small and big cases. One is an adapter-level
    test: a fake `claude` shell script runs `wc -c` on its stdin, with `AOM_CLAUDE_SMOKE=1` and `sandbox: 'off'`, and
    the test asserts the byte count equals the prompt's size. This is the template for the chat test.
  - `apps/runner/test/chat.test.ts:324` `describe('claude code chat adapter')`: an `input()` fixture for
    `ChatStartInput` and an exact-argv assertion for a short message (:341-372). This assertion is the regression
    guard for AC 2 and must stay as it is.
  - `apps/runner/test/owner-turn-command.test.ts:92`: the owner turn's stdin test.

## Options

1. **Copy the existing inline pattern into `buildClaudeChatCommand` and add the spawn line in `startChatSession`
   (recommended).** This is the same three edits as `buildClaudeOwnerTurnCommand` and `startOwnerTurn`: about four
   changed lines and no new abstraction. It meets AC 4 ("reuse the existing threshold and mechanism") literally.
2. Pull a shared helper such as `promptArgs(text): { argv: string[]; stdin?: string }` out of all three builders. That
   is tidier, but it touches the shift and owner-turn builders, and the card says not to change the shift path. The
   gain is small. Do not do it here.
3. Always send chat messages on stdin. This is rejected because it breaks AC 2: the argv of a short message must be
   identical to what it is now.

## Recommendation and design

Take option 1.

### Change 1: `buildClaudeChatCommand` (claude-code.ts:244)

```ts
export function buildClaudeChatCommand(input: ChatStartInput, cfg: ClaudeConfig): ClaudeCommand {
  const viaStdin = Buffer.byteLength(input.message) > MAX_ARGV_PROMPT_BYTES;
  const args = [
    '-p',
    ...(viaStdin ? [] : [input.message]),
    '--output-format',
    // ... everything else exactly as today ...
  ];
  // ... unchanged ...
  return {
    bin: cfg.bin,
    args,
    env: sessionEnv(/* unchanged */),
    ...(viaStdin ? { stdin: input.message } : {}),
  };
}
```

Update the doc comment above the function as well, for example: "`claude -p <message> ...` (section 14); a message
over `MAX_ARGV_PROMPT_BYTES` goes on stdin instead".

### Change 2: `startChatSession` spawn (claude-code.ts:1076)

Add one line after `inheritEnv: false,`. It is the same line as :962 and :1118:

```ts
      ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
```

With no stdin payload, the spawn options have no `input` key, so short chats spawn exactly as before (stdin is
`'ignore'`).

### Not changed

`startChat`, `process-session.ts`, `ClaudeCommand`, the shift and owner-turn builders, the server, and the
release-docs writer.

### Risks

- **Back-compat of short messages:** guarded by the existing exact-argv test (chat.test.ts:345) and the new boundary
  test.
- **Resume with stdin:** already in production on the owner-turn path. Low risk.
- **macOS and Windows:** their argv limits are larger in total (macOS `ARG_MAX` is 1 MiB, Windows has a 32 K
  character command line). The 64 KiB byte threshold works on Linux and macOS. On Windows, 64 KiB of ASCII is about 64 K
  characters, which is over the 32 K-character limit. That gap already exists on the shift path and is not in this
  card's scope. Using the same constant keeps the chat path no worse than the shift path. A Windows-specific threshold
  would be a separate follow-up, and only if Windows runners report it.
- **Release:** the fix only reaches runners that update to the release that contains it. Say so in the PR.

## Acceptance criteria mapped to the design and tests

| AC | Where it is met | Test |
| --- | --- | --- |
| 1. Over 64 KiB: no argv element holds the message; `stdin` is set | Change 1 | chat.test.ts, new "big message" test |
| 2. 64 KiB or less: `-p <message>`, no stdin, argv unchanged | Change 1 (the `viaStdin` false branch) | existing exact-argv test chat.test.ts:341 (unchanged) plus `expect(first.stdin).toBeUndefined()` |
| 3. More than 128 KiB: every argv element ≤ `MAX_ARGV_PROMPT_BYTES`, and `stdin` equals the message exactly | Change 1 | new test: `HUGE` of about 200 KiB; `args.every((a) => Buffer.byteLength(a) <= MAX_ARGV_PROMPT_BYTES)`; `stdin` `toBe(HUGE)`; `args[0] === '-p'`, `args[1] === '--output-format'` |
| 4. Boundary and multi-byte | Change 1 (`Buffer.byteLength`, `>`) | `'x'.repeat(MAX)` stays on argv as `args[1]`; `'x'.repeat(MAX + 1)` goes to stdin; `'é'.repeat(MAX / 2 + 1)` (fewer characters than MAX, more than MAX bytes) goes to stdin; you can also add `'€'.repeat(...)` (3 bytes per character) |
| 5. The chat spawn writes stdin; no E2BIG | Change 2 | adapter-level test modelled on start-failure.test.ts:86 (see below) |
| 6. Runner unit tests and typecheck pass | — | `pnpm --filter @aom/runner test` and `pnpm --filter @aom/runner typecheck` |

### Adapter-level test for AC 5

Put this in `start-failure.test.ts` next to the shift test, or in a new `chat-stdin.test.ts`:

```ts
it('the Claude adapter starts a chat with a huge message (fake claude reads it from stdin)', async () => {
  const t = tmp();
  const received = join(t, 'received.txt');
  const bin = join(t, 'fakeclaude');
  writeFileSync(bin, `#!/bin/sh\nwc -c > ${received}\necho '{"type":"system"}'\nexit 0\n`);
  chmodSync(bin, 0o755);
  const cwd = join(t, 'scratch'); mkdirSync(cwd, { recursive: true });
  const paths = runnerPaths(join(t, 'data'));
  const sandbox = await ensureSandbox(paths, A, 'Rev');
  const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }), paths);
  // AOM_CLAUDE_SMOKE=1 around the call, restored in finally (same as the shift test)
  const session = await adapter.startChat({
    chatId: 'c1', message: HUGE, cwd, sandbox, env: {}, readOnly: true,
    agent: { agentId: A, name: 'Rev', roleKey: 'reviewer', seniority: 'senior', runtime: 'claude-code',
             model: 'sonnet', skills: [], permissions: reviewer.permissions, isDevops: false },
  } as never);
  expect((await drain(session)).at(-1)).toMatchObject({ kind: 'exit', code: 0 });
  expect(Number(readFileSync(received, 'utf8').trim())).toBe(Buffer.byteLength(HUGE));
});
```

Without change 2, this test fails: either E2BIG (if only change 1 is missing) or a byte count of 0 (if only change 2
is missing, because stdin is `'ignore'`). So it proves the wiring. To also cover "no payload means no stdin", a second
case with a short message can have the fake script write `wc -c` and assert `0`. stdin is ignored, so `wc` sees EOF at
once.

## Regression check (callers)

- `buildClaudeChatCommand` has one production caller, `startChatSession` (:1067). The test caller is
  `chat.test.ts`.
- `startChatSession` is only called from `startChat` (:1009). Every chat kind (plain chat, CEO chat, DevOps chat,
  intake, mention-that-works, brief) goes through this one spawn, so the one-line change covers all of them.
- The shift and owner-turn paths are untouched. Their tests in `start-failure.test.ts` and
  `owner-turn-command.test.ts` must stay green.
