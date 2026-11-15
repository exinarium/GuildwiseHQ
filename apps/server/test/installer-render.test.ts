import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanName, oneLiner, psq, renderBash, renderPowerShell, shq } from '../src/installer/render.ts';

const base = {
  serverUrl: 'https://hq.example.com',
  pairingCode: 'ABCD-EFGH',
  sessionToken: 'tok_0123456789abcdefghij',
  workstationName: 'Desk',
  release: { version: '1.2.3', sha256: 'f'.repeat(64) },
  generatedAt: new Date('2026-10-07T08:00:00Z'),
  expiresAt: new Date('2026-10-07T08:30:00Z'),
};
const win = {
  ...base,
  scriptUrl: 'https://hq.example.com/install/t/install.ps1',
  linuxScriptUrl: 'https://hq.example.com/install/t/install-linux-wsl.sh',
};

describe('quoting', () => {
  it('shq makes any text one literal bash word', () => {
    expect(shq('plain')).toBe("'plain'");
    expect(shq("it's")).toBe("'it'\\''s'");
    const nasty = [
      '$(touch /tmp/pwned)',
      '`id`',
      '"; rm -rf ~; "',
      "a'b'c",
      '\\',
      'x\ny',
      '${HOME}',
      '!history',
    ];
    for (const s of nasty) {
      const r = spawnSync('bash', ['-c', `printf %s ${shq(s)}`], { encoding: 'utf8' });
      expect(r.stdout, s).toBe(s);
    }
  });

  it('psq doubles the quote and nothing else is special', () => {
    expect(psq("O'Brien")).toBe("'O''Brien'");
    expect(psq('$env:USERPROFILE `n "x"')).toBe('\'$env:USERPROFILE `n "x"\'');
  });

  it('cleanName drops control characters and caps the length', () => {
    expect(cleanName('  a\u0000b\nc\td  ')).toBe('a b c d');
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });
});

describe('rendered scripts', () => {
  it('embed the server URL, one-time code, token and release, and nothing else', () => {
    const sh = renderBash('linux', base);
    expect(sh).toContain("SERVER_URL='https://hq.example.com'");
    expect(sh).toContain("PAIRING_CODE='ABCD-EFGH'");
    expect(sh).toContain("SESSION_TOKEN='tok_0123456789abcdefghij'");
    expect(sh).toContain("RELEASE_VERSION='1.2.3'");
    expect(sh).toContain(`RELEASE_SHA256='${'f'.repeat(64)}'`);
    expect(sh).toContain('expires 2026-10-07T08:30:00.000Z');
    expect(sh).not.toMatch(/aomr_|aom_session|set-cookie|ANTHROPIC_API_KEY=sk-/i);
  });

  it('escape a hostile workstation name in bash and PowerShell', () => {
    const name = 'Pieter\'s $(rm -rf ~) `id` "q"\nnext';
    const sh = renderBash('linux', { ...base, workstationName: name });
    expect(sh).toContain(`DEFAULT_NAME=${shq(cleanName(name))}`);
    expect(sh).toContain("DEFAULT_NAME='Pieter'\\''s $(rm -rf ~) `id` \"q\" next'");
    const ps = renderPowerShell({ ...win, workstationName: name });
    expect(ps).toContain("$DefaultName = 'Pieter''s $(rm -rf ~) `id` \"q\" next'");
  });

  it('a hostile server URL stays inside its quotes', () => {
    const sh = renderBash('macos', { ...base, serverUrl: "https://x.test/'; touch /tmp/p; '" });
    expect(sh).toContain("SERVER_URL='https://x.test/'\\''; touch /tmp/p; '\\'''");
    const r = spawnSync(
      'bash',
      [
        '-c',
        `${sh
          .split('\n')
          .filter((l) => l.startsWith('SERVER_URL='))
          .join('\n')}\nprintf %s "$SERVER_URL"`,
      ],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout).toBe("https://x.test/'; touch /tmp/p; '");
  });

  it('the Windows script is ASCII with CRLF line endings and carries the links', () => {
    const ps = renderPowerShell(win);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for non-ASCII bytes
    expect(ps).not.toMatch(/[^\u0000-\u007f]/);
    expect(ps.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    expect(ps).toContain("$ScriptUrl = 'https://hq.example.com/install/t/install.ps1'");
    expect(ps).toContain("$LinuxScriptUrl = 'https://hq.example.com/install/t/install-linux-wsl.sh'");
    expect(ps).toContain('vmIdleTimeout=-1');
    expect(ps).toContain('systemd=true');
    expect(ps).toContain('$RunnerTaskName = "$AppName runner"');
    expect(ps).toContain("$OldTaskName = 'WSL Boot'");
    expect(ps).toContain('Unregister-ScheduledTask -TaskName $OldTaskName');
    expect(ps).toContain('--exec\\s+sleep\\s+infinity'); // only our own old task is removed
    expect(ps).toContain('RunOnce');
  });

  it('the Windows script stays ASCII for a name with typographic quotes and accents, and keeps them intact', () => {
    const ps = renderPowerShell({ ...win, workstationName: 'Pieter\u2019s Caf\u00e9 \ud83d\ude00' });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for non-ASCII bytes
    expect(ps).not.toMatch(/[^\u0000-\u007f]/);
    expect(ps).toContain(
      "$DefaultName = ('Pieter' + [char]8217 + 's Caf' + [char]233 + ' ' + [char]55357 + [char]56832)",
    );
    expect(psq("it's \u2018x\u2019")).toBe("('it''s ' + [char]8216 + 'x' + [char]8217)");
    expect(psq('plain')).toBe("'plain'");
  });

  it('the Windows script never pipes text to wsl.exe (PowerShell would append a carriage return)', () => {
    const ps = renderPowerShell(win);
    expect(ps).not.toMatch(/\|\s*&\s*wsl\.exe/);
    expect(ps).toContain('base64 -d | bash');
    expect(ps).toContain('base64 -d | chpasswd');
    // the elevated copy is told whose profile it is for
    expect(ps).toContain('$env:USERPROFILE');
  });

  it('Windows step 2 decides by whether WSL2 works and asks for a restart at most twice', () => {
    const ps = renderPowerShell(win).replace(/\r\n/g, '\n');
    const step2 = ps.slice(
      ps.indexOf("Start-Step 'Turning on WSL2"),
      ps.indexOf("Start-Step 'Installing Ubuntu'"),
    );
    // ready = VirtualMachinePlatform on and wsl.exe --status answers; the legacy feature alone decides nothing
    expect(ps).toContain("$states['VirtualMachinePlatform'] -eq 'Enabled' -and $code -eq 0");
    expect(ps).toContain('& wsl.exe --status');
    expect(step2).toContain('wsl.exe --install --no-distribution');
    // the legacy feature never appears next to a restart request: it is only in the list the helpers loop over
    expect(step2).not.toContain('Subsystem-Linux');
    // count branches: first run installs, the run after one restart enables itself, from two restarts on nothing is tried
    expect(step2).toContain('if ($wslRestarts -eq 0) {');
    expect(step2).toContain('} elseif ($wslRestarts -eq 1) {');
    expect(step2.match(/Enable-WslFeatures/g)).toHaveLength(2);
    // a PC with both features on whose wsl.exe has no --status is not stopped when version 2 can be set
    expect(step2).toContain('--set-default-version 2');
    expect(step2).toContain('$wsl.Ready = $true');
    // a declined restart prompt does not use up the allowance; an enabling error ends in the same message
    expect(step2).toContain('-not (Test-RestartedSince)');
    expect(ps).toContain('restartBootTime');
    expect(ps).toContain('$script:WslEnableError = "Enabling $f failed');
    expect(step2).not.toContain('$missing');
    expect(ps).toContain('Enable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart -All');
    // a restart only when one is pending or the features were just enabled, and never a third time
    expect(step2).toContain('($wsl.Pending -or $changed) -and $wslRestarts -lt 2');
    expect(step2.match(/Request-Restart/g)).toHaveLength(1);
    expect(step2).toContain("Set-StateValue 'wslRestarts' ($wslRestarts + 1)");
    // still not ready: stop with the state of each feature and the last line of wsl.exe --status
    expect(step2).toContain('Stop-Install "WSL2 is still not ready. $detail." $todo');
    expect(step2).toContain('$detail = $wsl.Summary');
    expect(ps).toContain('wsl.exe --status said: $last');
    expect(step2).toContain('BIOS/UEFI');
    expect(step2).toContain('wsl --install');
    // the record exists and is cleared when step 2 completes
    expect(ps).toContain('wslRestarts = 0');
    expect(step2).toMatch(/\nSet-StateValue 'wslRestarts' 0\n& wsl\.exe --update/);
  });

  it('Windows step 3 asks for a restart for Ubuntu at most once', () => {
    const ps = renderPowerShell(win).replace(/\r\n/g, '\n');
    const step3 = ps.slice(ps.indexOf("Start-Step 'Installing Ubuntu'"), ps.indexOf('# ---- 4.'));
    expect(ps).toContain('ubuntuRestartRequested = $false');
    expect(step3).toContain('if ((Get-State).ubuntuRestartRequested -and (Test-RestartedSince))');
    expect(step3).toContain("Set-StateValue 'ubuntuRestartRequested' $true");
    expect(step3).toContain('wsl.exe -l -q returned');
    expect(step3.match(/Request-Restart/g)).toHaveLength(1);
    expect(step3.indexOf('Stop-Install')).toBeLessThan(step3.indexOf('Request-Restart'));
    expect(step3).toContain("Set-StateValue 'ubuntuRestartRequested' $false");
  });

  it('one-line commands quote the URL', () => {
    expect(oneLiner('linux', 'https://a/b')).toBe("curl -fsSL 'https://a/b' | bash");
    expect(oneLiner('macos', 'https://a/b')).toBe("curl -fsSL 'https://a/b' | bash");
    expect(oneLiner('windows', 'https://a/b')).toBe(
      "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm 'https://a/b' | iex",
    );
  });
});

describe('script quality', () => {
  const dir = mkdtempSync(join(tmpdir(), 'installers-'));
  const files = { linux: renderBash('linux', base), macos: renderBash('macos', base) };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.sh`), text);
  const have = (cmd: string) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

  it.each(['linux', 'macos'])('%s installer is valid bash', (name) => {
    const r = spawnSync('bash', ['-n', join(dir, `${name}.sh`)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!have('shellcheck'))('the installers pass shellcheck', () => {
    const r = spawnSync('shellcheck', ['-x', '-s', 'bash', join(dir, 'linux.sh'), join(dir, 'macos.sh')], {
      encoding: 'utf8',
    });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });

  it('every installer ends by calling main as its last line (safe for curl | bash)', () => {
    for (const text of Object.values(files)) expect(text.trimEnd().split('\n').pop()).toBe('main "$@"');
  });

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('command names', () => {
  it('the Linux and macOS installers link both guildwise-runner and its alias aom-runner', () => {
    for (const os of ['linux', 'macos'] as const) {
      const script = renderBash(os, base);
      expect(script, os).toContain('"${BIN_DIR}/guildwise-runner"');
      expect(script, os).toContain('"${BIN_DIR}/aom-runner"');
    }
  });
});
