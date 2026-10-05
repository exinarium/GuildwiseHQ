import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const E2E_DIR = process.env.AOM_E2E_DIR ?? '/tmp/aom-e2e';
export const PORT = Number(process.env.AOM_E2E_PORT ?? 4601);
export const BASE_URL = `http://localhost:${PORT}`;
export const DB_NAME = process.env.AOM_E2E_DB ?? 'aom_e2e';
export const PG_ADMIN_URL = 'postgres://aom:aom@127.0.0.1:5433/postgres';
export const DATABASE_URL = `postgres://aom:aom@127.0.0.1:5433/${DB_NAME}`;
export const MAILPIT_API = process.env.AOM_MAILPIT_API ?? 'http://127.0.0.1:8025';
export const SMTP_URL = process.env.AOM_E2E_SMTP_URL ?? 'smtp://127.0.0.1:1025';

export const ADMIN = { email: 'admin@e2e.test', name: 'E2E Admin', password: 'admin-password-12345' };
export const MEMBER = { email: 'member@e2e.test', name: 'E2E Member', password: 'member-password-12345' };
export const OTHER = { email: 'other@e2e.test', name: 'E2E Other', password: 'other-password-12345' };

/** M3 specs: one user for the DevOps/vault flows, an owner and a guest for project sharing. */
export const DEVOPS = { email: 'devops@e2e.test', name: 'E2E DevOps', password: 'devops-password-12345' };
export const SHARER = { email: 'sharer@e2e.test', name: 'E2E Sharer', password: 'sharer-password-12345' };
export const GUEST = { email: 'guest@e2e.test', name: 'E2E Guest', password: 'guest-password-12345' };

/** M5 feeds spec. */
export const FEEDER = { email: 'feeder@e2e.test', name: 'E2E Feeder', password: 'feeder-password-12345' };

/** M6 research spec. */
export const SCHOLAR = { email: 'scholar@e2e.test', name: 'E2E Scholar', password: 'scholar-password-12345' };

export const paths = {
  server: join(ROOT, 'apps/server/dist/main.mjs'),
  runnerBin: join(ROOT, 'apps/runner/dist/aom-runner.mjs'),
  webDist: join(ROOT, 'apps/web/dist'),
  origin: join(E2E_DIR, 'origin/toy.git'),
  repoRoot: join(E2E_DIR, 'repos'),
  toyClone: join(E2E_DIR, 'repos/toy'),
  runnerData: join(E2E_DIR, 'runner'),
  /** Data dir of an extra runner (M3 specs). */
  runnerHome: (name: string) => join(E2E_DIR, `runner-${name}`),
  /** Temp dir for git vault fixtures (bare origin + clones); never pushed anywhere real. */
  vaults: join(E2E_DIR, 'vaults'),
  pids: join(E2E_DIR, 'pids.json'),
  serverLog: join(E2E_DIR, 'server.log'),
  runnerLog: join(E2E_DIR, 'runner.out.log'),
};

/** M4: the user of the tester / bug loop specs (own runner, own project TST). */
export const TESTER = { email: 'tester@e2e.test', name: 'E2E Tester', password: 'tester-password-12345' };

/** M7 intake spec: own user, own runner (mock), projects INT and OTH on the toy repo, a BA and two builders. */
export const INTAKER = { email: 'intaker@e2e.test', name: 'E2E Intaker', password: 'intaker-password-12345' };
/** M9 HR board spec: the owner of the HR project and an additional manager of it. */
export const HR = { email: 'hr@e2e.test', name: 'E2E HR', password: 'hr-password-12345' };
export const HRGUEST = {
  email: 'hrguest@e2e.test',
  name: 'E2E HR Guest',
  password: 'hrguest-password-12345',
};

/** M8 outbox spec: own user, own runner (mock, fake gh, fake Jira), project OUT on the toy repo, a BA, a builder, a reviewer. */
export const OUTBOXER = {
  email: 'outboxer@e2e.test',
  name: 'E2E Outboxer',
  password: 'outboxer-password-12345',
};

/** M10 organization designer spec: the owner of the organization and an additional manager of its project. */
export const DESIGNER = {
  email: 'designer@e2e.test',
  name: 'E2E Designer',
  password: 'designer-password-12345',
};
export const DESIGNGUEST = {
  email: 'designguest@e2e.test',
  name: 'E2E Design Guest',
  password: 'designguest-password-12345',
};

/** Sandbox spec: own user and a mock runner that reports `unsandboxed` (AOM_RUNNER_MOCK_SANDBOX, test only). */
export const SANDBOXER = {
  email: 'sandboxer@e2e.test',
  name: 'E2E Sandboxer',
  password: 'sandboxer-password-12345',
};

/** Workability spec: own user, own runner (mock), project WRK on the toy repo, a builder and ONE senior reviewer. */
export const WORKER = { email: 'worker@e2e.test', name: 'E2E Worker', password: 'worker-password-12345' };

/** Phases spec: own user, own runner (mock), project PHS on the toy repo, a BA, a builder, a reviewer and a tester. */
export const PHASER = { email: 'phaser@e2e.test', name: 'E2E Phaser', password: 'phaser-password-12345' };

/** BA reporter spec (docs/design/phases.md Part B): own user, own runner (mock), project RPT, a BA and a builder. */
export const REPORTER = {
  email: 'reporter@e2e.test',
  name: 'E2E Reporter',
  password: 'reporter-password-12345',
};

/** Repository hygiene spec (docs/design/phases.md addendum): own user, own runner (mock), project HYG on its own repo `notes-app`. */
export const HYGIENER = {
  email: 'hygiener@e2e.test',
  name: 'E2E Hygiener',
  password: 'hygiener-password-12345',
};
