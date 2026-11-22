import { describe, expect, it } from 'vitest';
import { SetupOffersWireSchema } from '../src/protocol/security.ts';
import {
  LOCAL_CLI_RE,
  localCliOk,
  localCommandOk,
  localStepText,
  redactUrlPassword,
  urlHasPassword,
} from '../src/security/local-steps.ts';

const CLI = 'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner';
const ORG = '0b8f3c2a-1d4e-4f5a-9b6c-7d8e9f0a1b2c';
const AGENT = '1c9a4d3b-2e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('local command grammar [S3]', () => {
  it('accepts every verb with typed arguments', () => {
    for (const c of [
      `${CLI} approve a1b2c3d4e5`,
      `${CLI} deny a1b2c3d4e5`,
      `${CLI} devops grant ${ORG} --agent ${AGENT}`,
      `${CLI} repo allow-scripts https://github.com/acme/website.git`,
      `${CLI} repo allow-scripts ssh://git@example.com:22/acme/site.git`,
      `${CLI} formatter pin ${'a'.repeat(64)}`,
      `${CLI} passkey trust AbC_-123`,
      `${CLI} approvals pair K7M2-Q9`,
      `${CLI} extras install yt-dlp`,
      `${CLI} setup`,
      `${CLI} pending`,
      `${CLI} approvals devices`,
      `${CLI} signing add-key --key-id 0123456789ABCDEF --key-file <key-file>`,
      'sudo -u guildwise-runner-uat -H /home/guildwise-runner-uat/.local/bin/guildwise-runner setup',
      'wsl -d Guildwise -- /home/me/.local/bin/guildwise-runner approve a1b2c3d4e5',
      'wsl -d guildwise-runner -u guildwise-runner -- /home/guildwise-runner/.local/bin/guildwise-runner approve a1b2c3d4e5',
      'wsl -d Ubuntu -u guildwise-runner-uat -- /home/guildwise-runner-uat/.local/bin/guildwise-runner setup',
      '/Users/me/.local/bin/guildwise-runner pending',
      'guildwise-runner pending',
    ])
      expect(localCommandOk(c), c).toBe(true);
  });

  it('refuses shell metacharacters, quotes and spaces inside arguments', () => {
    for (const c of [
      `${CLI} approve a1b2c3d4e5; rm -rf ~`,
      `${CLI} approve a1b2c3d4e5 | sh`,
      `${CLI} approve $(id)`,
      `${CLI} approve 'a1b2c3d4e5'`,
      `${CLI} approve "a1b2c3d4e5"`,
      `${CLI} repo allow-scripts https://x.example/a b`,
      `${CLI} repo allow-scripts https://x.example/$(id)`,
      `${CLI} repo allow-scripts https://x.example/\`id\``,
      `${CLI}  setup`,
      `${CLI} setup `,
      `${CLI} setup\n`,
      `${CLI} setup && curl evil`,
    ])
      expect(localCommandOk(c), c).toBe(false);
  });

  it('refuses an argument starting with - and a wrong type per verb', () => {
    expect(localCommandOk(`${CLI} repo allow-scripts --help`)).toBe(false);
    expect(localCommandOk(`${CLI} approve --pin`)).toBe(false);
    expect(localCommandOk(`${CLI} devops grant ${ORG} --agent --help`)).toBe(false);
    expect(localCommandOk(`${CLI} devops grant ${ORG} --pin ${AGENT}`)).toBe(false);
    expect(localCommandOk(`${CLI} approve ${ORG}`)).toBe(false);
    expect(localCommandOk(`${CLI} formatter pin abc`)).toBe(false);
    expect(localCommandOk(`${CLI} approvals pair k7m2-q9`)).toBe(false);
    expect(localCommandOk(`${CLI} approvals pair K7M0-Q9`)).toBe(false);
    expect(localCommandOk(`${CLI} unknown verb`)).toBe(false);
    expect(localCommandOk(`${CLI} setup extra`)).toBe(false);
  });

  it('refuses a CLI part that is not a guildwise-runner path', () => {
    for (const c of [
      'sudo -u root -H /home/x/.local/bin/guildwise-runner setup',
      'sudo /home/x/.local/bin/guildwise-runner setup',
      '/home/x/../../tmp/guildwise-runner setup',
      '/tmp/evil setup',
      'bash -c guildwise-runner setup',
      'relative/guildwise-runner setup',
      'wsl -d bad;name -- /home/x/guildwise-runner setup',
      'wsl -d Ubuntu -u root -- /home/x/.local/bin/guildwise-runner setup',
      'wsl -d Ubuntu -u guildwise-runner /home/x/.local/bin/guildwise-runner setup',
      'wsl -d Ubuntu -e sh -- /home/x/.local/bin/guildwise-runner setup',
      'wsl -d Ubuntu -u guildwise-runner -u root -- /home/x/.local/bin/guildwise-runner setup',
    ])
      expect(localCommandOk(c), c).toBe(false);
    expect(localCliOk(CLI)).toBe(true);
    expect(LOCAL_CLI_RE.test(CLI)).toBe(true);
    expect(localCliOk(`${CLI} setup`)).toBe(false);
  });

  it('has a plain sentence for each kind and falls back to the held one', () => {
    expect(localStepText('devops.grant')).toMatch(/DevOps helper/);
    expect(localStepText('deploy.exec')).toBe(localStepText('held'));
  });
});

describe('repository addresses with a password (zero known vulnerabilities)', () => {
  it('are detected in URL and scp form; a bare user name is not a password', () => {
    for (const u of [
      'https://alice:pw@github.com/acme/web',
      'ssh://git:pw@host:22/a/b',
      'https://:pw@host/x',
      'alice:pw@github.com:acme/web.git',
    ])
      expect(urlHasPassword(u), u).toBe(true);
    for (const u of ['https://github.com/acme/web', 'ssh://git@host:22/a/b', 'git@github.com:acme/web.git'])
      expect(urlHasPassword(u), u).toBe(false);
  });

  it('never pass the command grammar, and the wire schema drops them', () => {
    expect(localCommandOk(`${CLI} repo allow-scripts https://alice:pw@github.com/acme/web`)).toBe(false);
    expect(localCommandOk(`${CLI} repo allow-scripts ssh://git@github.com/acme/web`)).toBe(true);
    const wire = { orgs: [], repos: [{ url: 'https://alice:pw@github.com/acme/web', name: 'web' }] };
    expect(SetupOffersWireSchema.safeParse(wire).success).toBe(false);
  });

  it('text that must name an address shows *** instead of the password', () => {
    const t = redactUrlPassword(
      '{"remoteUrl": "https://alice:s3cret@git.example/v.git", "x": "alice:pw@host:a/b"}',
    );
    expect(t).not.toContain('s3cret');
    expect(t).not.toContain(':pw@');
    expect(t).toContain('https://alice:***@git.example/v.git');
  });
});
