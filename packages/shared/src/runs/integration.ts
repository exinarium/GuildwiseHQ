import { z } from 'zod';
import { isSafeRelativeDir } from './plan.ts';

/**
 * Integration and E2E tests by the tester (docs/design/run-and-integration-tests.md section 4, backlog #59). The project
 * setting says whether the `test` stage runs against a running environment (`local`: the card's commit on the card's
 * workstation, `remote`: a deploy target), which suites there are, and how failures are treated.
 */

export const INTEGRATION_MODES = ['off', 'local', 'remote'] as const;
export const IntegrationModeSchema = z.enum(INTEGRATION_MODES);
export type IntegrationMode = z.infer<typeof IntegrationModeSchema>;

export const INTEGRATION_SUITE_KINDS = ['integration', 'e2e'] as const;
export const IntegrationSuiteKindSchema = z.enum(INTEGRATION_SUITE_KINDS);
export type IntegrationSuiteKind = z.infer<typeof IntegrationSuiteKindSchema>;

const Cmd = z.array(z.string().max(2000)).min(1).max(100);

/** One suite the tester runs: an argv array run from `cwd` of the repository, never through a shell. */
export const IntegrationSuiteSchema = z.object({
  /** The name the tester reports the result under (`aom test suite --name`). Unique within the project. */
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-/]*$/, 'use letters, digits, spaces and "_ . - /"'),
  repoId: z.uuid(),
  /** Relative to the repository (or the project folder of it). */
  cwd: z.string().max(300).default('.'),
  cmd: Cmd,
  kind: IntegrationSuiteKindSchema.default('integration'),
  /** The most the suite may run; `aom-env --timeout` enforces it and the result is `timeout`. */
  timeoutMin: z.number().int().min(1).max(120).default(20),
  /** Writes or deletes data: only runs against a target that allows it (remote mode). */
  destructive: z.boolean().default(false),
  /** Where the suite writes its JUnit report (glob relative to `cwd`): counts then come from the report. */
  junit: z.string().max(300).optional(),
  /** False: proposed by a tester (`aom env suites propose`), waiting for the owner to confirm it. */
  confirmed: z.boolean().default(true),
});
export type IntegrationSuite = z.infer<typeof IntegrationSuiteSchema>;

export const DEFAULT_KEEP_ON_FAILURE_MIN = 60;
export const DEFAULT_FLAKY_RETRY = 1;

export const IntegrationTestsSchema = z.object({
  mode: IntegrationModeSchema.default('off'),
  /** Remote mode: an existing deploy target with testing switched on. */
  deployTargetId: z.uuid().optional(),
  /** Local mode: which services to start (empty: all of the plan). */
  services: z.array(z.string().max(40)).max(20).default([]),
  suites: z.array(IntegrationSuiteSchema).max(30).default([]),
  /** A failed card's environment is kept this long for inspection (0: stop at once). */
  keepOnFailureMin: z.number().int().min(0).max(1440).default(DEFAULT_KEEP_ON_FAILURE_MIN),
  /** A failing suite is run again this many times; a pass on a retry is reported as flaky. */
  flakyRetry: z.number().int().min(0).max(3).default(DEFAULT_FLAKY_RETRY),
});
export type IntegrationTests = z.infer<typeof IntegrationTestsSchema>;

/** The setting every project has until its owner switches it on. */
export const INTEGRATION_TESTS_OFF: IntegrationTests = IntegrationTestsSchema.parse({});

/** Do integration tests apply to new cards of a project with this setting? */
export const integrationTestsOn = (s: Pick<IntegrationTests, 'mode'> | null | undefined): boolean =>
  !!s && s.mode !== 'off';

/** The suites a tester must report on: confirmed ones. */
export const requiredSuites = (s: Pick<IntegrationTests, 'suites'>): IntegrationSuite[] =>
  s.suites.filter((x) => x.confirmed);

/** Problems the schema cannot see (empty list: fine). `repoIds` are the project's repositories. */
export function validateIntegrationTests(s: IntegrationTests, repoIds: readonly string[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const x of s.suites) {
    const key = x.name.toLowerCase();
    if (names.has(key)) problems.push(`suite "${x.name}" appears twice`);
    names.add(key);
    if (!repoIds.includes(x.repoId))
      problems.push(`suite "${x.name}": the repository is not part of the project`);
    if (!isSafeRelativeDir(x.cwd))
      problems.push(`suite "${x.name}": the folder must stay inside the repository`);
    if (x.junit !== undefined && !isSafeRelativeDir(x.junit))
      problems.push(`suite "${x.name}": the report path must be relative and stay inside the folder`);
  }
  if (s.mode === 'remote' && !s.deployTargetId)
    problems.push('remote mode needs a deploy target (Project settings > Deploy targets)');
  return problems;
}

// ----------------------------------------------------------------------------------------------- results

export const SUITE_STATUSES = ['passed', 'failed', 'flaky', 'timeout', 'skipped'] as const;
export const SuiteStatusSchema = z.enum(SUITE_STATUSES);
export type SuiteStatus = z.infer<typeof SuiteStatusSchema>;

/** A suite result that lets the card pass: green, or green after a retry. A skipped suite does not block either. */
export const suiteStatusPasses = (s: SuiteStatus): boolean =>
  s === 'passed' || s === 'flaky' || s === 'skipped';

/** `aom test suite` as the runner sends it to the server (`test.suite` rpc). */
export const TestSuiteReportSchema = z.object({
  name: z.string().trim().min(1).max(60),
  status: SuiteStatusSchema,
  passed: z.number().int().min(0).max(10_000_000).default(0),
  failed: z.number().int().min(0).max(10_000_000).default(0),
  skipped: z.number().int().min(0).max(10_000_000).default(0),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .default(0),
  /** How many runs it took (2 when a retry was needed). */
  attempts: z.number().int().min(1).max(10).default(1),
  /** The first failing cases (names), from the JUnit report. */
  failures: z.array(z.string().max(300)).max(10).default([]),
  /** Commit under test, filled in by the runner from the environment. */
  commit: z.string().max(64).optional(),
  /** The log or report the runner attached to the card (redacted): its file name; the server finds the attachment. */
  attachmentName: z.string().max(200).optional(),
  attachmentId: z.uuid().optional(),
  note: z.string().max(2000).optional(),
});
export type TestSuiteReport = z.infer<typeof TestSuiteReportSchema>;

export const TestSuiteResultDtoSchema = z.object({
  id: z.uuid(),
  suite: z.string(),
  kind: IntegrationSuiteKindSchema.nullable(),
  envMode: z.enum(['local', 'remote']).nullable(),
  /** Remote: the name of the deploy target. */
  targetName: z.string().nullable(),
  commit: z.string().nullable(),
  status: SuiteStatusSchema,
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number().int(),
  attempts: z.number().int(),
  failures: z.array(z.string()),
  attachmentId: z.uuid().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TestSuiteResultDto = z.infer<typeof TestSuiteResultDtoSchema>;

// ------------------------------------------------------------------------------------------ API and brief

/** `GET /api/projects/:id/integration-tests`. */
export const IntegrationTestsResponseSchema = z.object({
  settings: IntegrationTestsSchema,
  repos: z.array(z.object({ repoId: z.uuid(), name: z.string() })),
  /** Deploy targets that can be tested (remote mode, backlog #59 phase 4). */
  targets: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      url: z.string(),
      testEnabled: z.boolean(),
      production: z.boolean(),
    }),
  ),
  /** The workstations' environments need a runner that can provision them; false when none of the project's can. */
  canProvision: z.boolean(),
});
export type IntegrationTestsResponse = z.infer<typeof IntegrationTestsResponseSchema>;

/** `PUT /api/projects/:id/integration-tests`. */
export const SetIntegrationTestsRequestSchema = z.object({ settings: IntegrationTestsSchema });
export type SetIntegrationTestsRequest = z.infer<typeof SetIntegrationTestsRequestSchema>;

/** `POST /api/projects/:id/integration-tests/suites/:name/confirm`. */
export const ConfirmSuiteRequestSchema = z.object({ confirmed: z.boolean().default(true) });

/**
 * What the tester's shift knows about its environment (`brief.environment`). Local mode: the runner adds the live ports and
 * URLs from its own record of the environment. Remote mode: the target and the hosts the sandbox may reach.
 */
export const ShiftEnvironmentSchema = z.object({
  mode: z.enum(['local', 'remote']),
  /** Local: the run environment of this card. */
  envId: z.uuid().optional(),
  suites: z.array(IntegrationSuiteSchema).default([]),
  flakyRetry: z.number().int().min(0).max(3).default(DEFAULT_FLAKY_RETRY),
  /** Remote: the deploy target under test. */
  target: z
    .object({
      id: z.uuid(),
      name: z.string(),
      url: z.string(),
      hosts: z.array(z.string()).default([]),
      destructiveOk: z.boolean().default(false),
      /** Names (never values) of the secrets the runner holds for this target. */
      secretNames: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ShiftEnvironment = z.infer<typeof ShiftEnvironmentSchema>;

/**
 * Which confirmed suites still lack a passing result in this shift: `aom test pass` is refused while the list is not
 * empty. `results` are this shift's reports (the last one per suite counts).
 */
export function suitesWithoutPass(
  suites: readonly Pick<IntegrationSuite, 'name' | 'confirmed' | 'destructive'>[],
  results: ReadonlyArray<{ suite: string; status: SuiteStatus }>,
): string[] {
  const last = new Map<string, SuiteStatus>();
  for (const r of results) last.set(r.suite.toLowerCase(), r.status);
  return suites
    .filter((s) => s.confirmed)
    .filter((s) => {
      const st = last.get(s.name.toLowerCase());
      return st === undefined || !suiteStatusPasses(st);
    })
    .map((s) => s.name);
}


// ----------------------------------------------------------------------------------- test accounts of a target

/**
 * `env.secret.set` (durable command): one test-account value for a deploy target, encrypted in the browser with the runner's
 * public key (RSA-OAEP, like the sudo password). The server relays the ciphertext and empties the payload once the runner
 * answered; the value itself never reaches it.
 */
export const EnvSecretSetPayloadSchema = z.object({
  targetId: z.uuid(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
  keyId: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(2000),
});
export type EnvSecretSetPayload = z.infer<typeof EnvSecretSetPayloadSchema>;
export const EnvSecretClearPayloadSchema = z.object({
  targetId: z.uuid(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).optional(),
});
export const EnvSecretResultSchema = z.object({ stored: z.boolean(), error: z.string().max(500).optional() });
export type EnvSecretResult = z.infer<typeof EnvSecretResultSchema>;

/** `PUT /api/workstations/:id/target-secrets`: the browser's sealed value for one test account of one target. */
export const SetTargetSecretRequestSchema = z.object({
  targetId: z.uuid(),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
  keyId: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(2000),
});
export type SetTargetSecretRequest = z.infer<typeof SetTargetSecretRequestSchema>;

/** Which test accounts a workstation holds for the targets of a project: names and time, never values. */
export const TargetSecretStatusSchema = z.object({
  workstationId: z.uuid(),
  workstationName: z.string(),
  targetId: z.uuid(),
  name: z.string(),
  setAt: z.iso.datetime(),
});
export type TargetSecretStatus = z.infer<typeof TargetSecretStatusSchema>;
export const TargetSecretsResponseSchema = z.object({ secrets: z.array(TargetSecretStatusSchema) });
export type TargetSecretsResponse = z.infer<typeof TargetSecretsResponseSchema>;
