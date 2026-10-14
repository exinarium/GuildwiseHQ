import { formatCommandLine, type ShiftEnvironment } from '@aom/shared';
import { targetHosts } from './remote-target.ts';

/** What the runner knows of the environment right now (`RunManager.testEnvironment`). */
export interface EnvironmentView {
  state: string;
  sources: Array<{ name: string; branch: string; commit: string | null }>;
  services: Array<{
    name: string;
    state: string;
    health: string;
    ports: Array<{ name: string; port: number; url?: string }>;
  }>;
}

/**
 * The "Environment" section of a tester's instructions (docs/design/run-and-integration-tests.md 4.4): where the app runs,
 * how to reach it from the sandbox, which suites to run and how to report them. The role text says the same in general
 * terms; this is the shift's own facts.
 */
export function environmentNote(env: ShiftEnvironment, view?: EnvironmentView | null): string {
  const lines: string[] = ['## Environment'];
  if (env.mode === 'local') {
    lines.push(
      "The runner started this card's branch (rebased onto its base branch) on this workstation, and it is running now. It is stopped when you give your verdict.",
    );
    if (view) {
      for (const s of view.sources)
        lines.push(`- ${s.name}: branch ${s.branch} @ ${s.commit?.slice(0, 10) ?? '?'}`);
      for (const svc of view.services)
        lines.push(
          `- service ${svc.name} (${svc.state}${svc.health === 'passing' ? ', health ok' : ''}): ${
            svc.ports.map((p) => `${p.name} ${p.url ?? `http://localhost:${p.port}/`}`).join(', ') ||
            'no ports'
          }`,
        );
    }
    lines.push(
      'Run every command that talks to the app as `aom-env --timeout <minutes> -- <command>` (for example `aom-env --timeout 20 -- npx playwright test`). Inside it `http://localhost:<port>` is the app, with the same port numbers as above; nothing else on this machine is reachable. A command that outlives the timeout is killed.',
    );
  } else if (env.target) {
    const t = env.target;
    lines.push(
      `You test the deployed target "${t.name}" at ${t.url} (also in AOM_TARGET_URL). The runner starts nothing for you; only your tests change anything there.`,
      `Your shell reaches this target's host${targetHosts(t).length === 1 ? '' : 's'} (${targetHosts(t).join(', ') || 'none'}) and the package registries, nothing else. Requests go through the sandbox proxy: curl and browser pages (Playwright's chromium) use it by themselves, Node's fetch does when run as \`aom-env -- node ...\` (it sets NODE_USE_ENV_PROXY=1), and Playwright's \`request\` fixture needs \`proxy: { server: process.env.HTTPS_PROXY }\` in its config.`,
    );
    if (t.secretNames.length > 0)
      lines.push(
        `Test accounts: ${t.secretNames.join(', ')} are in the dotenv file named by AOM_ENV_SECRETS_FILE (load it in your test config). Never print, save or commit them.`,
      );
    if (!t.destructiveOk)
      lines.push(
        'This target does not allow tests that write or delete data: suites marked destructive are not run here; report them with `--status skipped`.',
      );
  }
  const required = env.suites.filter((s) => s.confirmed);
  const proposed = env.suites.filter((s) => !s.confirmed);
  if (required.length > 0) {
    lines.push('', 'Suites to run (each needs a passing result before `aom test pass`):');
    for (const s of required)
      lines.push(
        `- ${s.name} (${s.kind}${s.destructive ? ', destructive' : ''}, at most ${s.timeoutMin} min): \`${formatCommandLine(s.cmd)}\` in ${s.cwd === '.' ? 'the repository root' : s.cwd}${s.junit ? `, JUnit report ${s.junit}` : ''}`,
      );
    lines.push(
      '',
      `Report each run: \`aom test suite --name <suite> --status passed|failed|timeout|skipped${required.some((s) => s.junit) ? ' --junit <glob>' : ''} [--log <file>]\`. A failing suite is run ${env.flakyRetry === 1 ? 'once more' : `up to ${env.flakyRetry} more times`}; report every run: a pass after a failure counts as flaky. The result stays on the card.`,
    );
  } else {
    lines.push(
      '',
      'No suites are confirmed for this project yet. Read TESTING.md, then BUILD.md and the repository test config, run the integration and E2E tests you find, and report each with `aom test suite`. Suggest them for the project with `aom env suites propose --name <suite> --kind integration|e2e --cmd "<command>"`.',
    );
  }
  if (proposed.length > 0)
    lines.push(
      '',
      `Proposed but not confirmed (run them if they help; they are not required): ${proposed.map((s) => s.name).join(', ')}.`,
    );
  lines.push(
    '',
    '`aom env info` shows this again, `aom env logs <service>` what the app printed, `aom env restart` restarts the app at the same commit. Never print, save or commit passwords, tokens or keys you find in the environment; the runner removes known secret values from logs it attaches.',
  );
  return lines.join('\n');
}
