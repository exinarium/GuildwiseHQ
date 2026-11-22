import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderPowerShell } from '../src/installer/render.ts';
import { have, shParams } from './helpers/installer-sh.ts';

/**
 * R20 [rv6-4], [rv7-11], R21 on Windows: the runner's own WSL distribution (no interop, no Windows PATH, no drives, systemd
 * on), the Docker Desktop integration check, the old-runner step inside your Ubuntu, and the default-distribution choice.
 * The functions run under PowerShell 7 when it is installed (Windows PowerShell 5.1 itself cannot run here).
 */
const win = {
  ...shParams,
  scriptUrl: 'https://hq.example.com/install/t/install.ps1',
  linuxScriptUrl: 'https://hq.example.com/install/t/install-linux-wsl.sh',
};
const ps = renderPowerShell(win).replace(/\r\n/g, '\n');
const dir = mkdtempSync(join(tmpdir(), 'aom-ps-'));
const scriptFile = join(dir, 'install.ps1');
writeFileSync(scriptFile, renderPowerShell(win));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const hasPwsh = have('pwsh', '-Version');

/** Loads the named functions (and the script's settings) from the rendered script, then runs `body` in pwsh. */
function pwsh(
  names: string[],
  body: string,
  env: Record<string, string> = {},
): { out: string; err: string; status: number | null } {
  const runner = join(dir, `run-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(
    runner,
    `$ErrorActionPreference = 'Stop'
$AppName = 'Guildwise HQ'
$DedicatedDistro = 'guildwise-runner'
$ForwardedVars = @('GUILDWISE_YES', 'GUILDWISE_DEVOPS_ORGS', 'GUILDWISE_SKIP_BASELINE')
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptFile}', [ref]$t, [ref]$e)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if (@(${names.map((n) => `'${n}'`).join(', ')}) -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
}
${body}
`,
  );
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, ...env },
  });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}

describe('the Windows installer script', () => {
  it.skipIf(!hasPwsh)('parses without errors', () => {
    const r = pwsh([], `"errors: $($e.Count)"`);
    expect(r.out).toBe('errors: 0');
  });

  it('looks for an older runner right after WSL2 is on, with the Linux rules (--legacy-only), before any Ubuntu set-up', () => {
    const at = ps.indexOf("Start-Step 'Looking for an older runner'");
    expect(at).toBeGreaterThan(ps.indexOf("Complete-Step 'WSL2 is on'"));
    expect(at).toBeLessThan(ps.indexOf("Start-Step 'Installing Ubuntu'"));
    const step = ps.slice(at, ps.indexOf("Start-Step 'Installing Ubuntu'"));
    expect(step).toContain('exec bash "$GUILDWISE_SCRIPT" --legacy-only');
    expect(step).toContain("$env:WSLENV = 'GUILDWISE_SCRIPT/p:GUILDWISE_LEGACY/u'");
    expect(step).toContain("'LEGACY_RESULT=(none|kept|quarantined|removed)'");
    expect(step).toContain('Stop-Install "Could not deal with the older runner');
    // a quarantined runner loses its keep-alive tasks and its distribution is stopped
    expect(step).toContain('Test-OurKeepAliveTask $task $LegacyDistro');
    expect(step).toContain('Unregister-ScheduledTask -TaskName $t');
    expect(step).toContain('& wsl.exe --terminate $LegacyDistro');
    // no restart request and nothing that enables Windows features in this step
    expect(step).not.toContain('Request-Restart');
    expect(step).not.toContain('Enable-WslFeatures');
  });

  it('chooses the dedicated distribution unless a kept runner lives in your Ubuntu or GUILDWISE_WSL_DISTRO says default', () => {
    expect(ps).toContain(
      "$WslMode = if ($script:LegacyResult -eq 'kept') { 'default' } else { 'dedicated' }",
    );
    expect(ps).toContain('$WslMode = [string]$env:GUILDWISE_WSL_DISTRO');
    expect(ps).toContain("if ($WslMode -eq 'dedicated') { Install-DedicatedDistro }");
    expect(ps).toContain('set GUILDWISE_LEGACY=quarantine');
    // the default distribution gets the plain warning, before Ubuntu is set up
    const warnAt = ps.indexOf(
      "Write-Warn 'No isolation from Windows: the runner can start Windows programs and write your Windows profile",
    );
    expect(warnAt).toBeGreaterThan(ps.indexOf("if ($WslMode -eq 'dedicated') { Install-DedicatedDistro }"));
    expect(warnAt).toBeLessThan(ps.indexOf("Start-Step 'Installing Ubuntu'"));
  });

  it('imports the pinned Ubuntu image, checked by sha256, as guildwise-runner and keeps your default distribution', () => {
    const fn = ps.slice(ps.indexOf('function Install-DedicatedDistro'), ps.indexOf('trap {'));
    expect(ps).toContain(
      "amd64 = @{ Url = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'; Sha256 = '2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934' }",
    );
    expect(ps).toContain("Sha256 = 'e113b8c49af3ab49b992b8e29550fc921e689f211abc338176f8243786173a32'");
    expect(fn).toContain('(Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()');
    expect(fn.indexOf('did not match its pinned checksum')).toBeLessThan(fn.indexOf('wsl.exe --import'));
    expect(fn).toContain('& wsl.exe --import $DedicatedDistro $dir $file --version 2');
    expect(fn).toContain('& wsl.exe --set-default $before');
    // isolation is written and takes effect (terminate) before the Linux installer runs inside
    const conf = fn.indexOf("Invoke-WslBash $DedicatedDistro 'root' (Get-DedicatedWslConfScript)");
    expect(conf).toBeGreaterThan(-1);
    expect(conf).toBeLessThan(fn.indexOf('& wsl.exe --terminate $DedicatedDistro'));
    expect(fn.indexOf('& wsl.exe --terminate $DedicatedDistro')).toBeLessThan(
      fn.indexOf('exec bash /root/guildwise-install.sh'),
    );
  });

  it('runs the Linux installer inside as root with the dedicated-user path, copied in without Windows drives', () => {
    const fn = ps.slice(ps.indexOf('function Install-DedicatedDistro'), ps.indexOf('trap {'));
    expect(fn).toContain('"\\\\wsl.localhost\\$DedicatedDistro\\root"');
    expect(fn).toContain('GUILDWISE_ALLOW_ROOT=1 GUILDWISE_RUNNER_USER=dedicated');
    expect(fn).toContain(
      '& wsl.exe -d $DedicatedDistro -u root --cd \'/root\' -- bash -c "echo $runB64 | base64 -d | bash"',
    );
    expect(fn).not.toMatch(/GUILDWISE_SCRIPT\/p/);
    // the default user is set only once the runner user exists
    expect(fn.indexOf('Get-DedicatedWslConfScript -WithUser')).toBeGreaterThan(
      fn.indexOf('exec bash /root/guildwise-install.sh'),
    );
    expect(fn).toContain(
      'The runner has no sudo inside $DedicatedDistro; its Docker is its own rootless engine there',
    );
  });

  it('easy-runner-setup [B3]: both paths tell setup the distro, so the copy-paste commands start with wsl -d <distro>', () => {
    const fn = ps.slice(ps.indexOf('function Install-DedicatedDistro'), ps.indexOf('trap {'));
    expect(fn).toContain('GUILDWISE_RUNNER_USER=dedicated GUILDWISE_WSL_DISTRO_NAME=$DedicatedDistro;');
    const shared = ps.slice(ps.indexOf('# ---- 7. the Linux installer'));
    expect(shared).toContain('$env:GUILDWISE_WSL_DISTRO_NAME = $Distro');
    expect(shared.indexOf('$env:GUILDWISE_WSL_DISTRO_NAME = $Distro')).toBeLessThan(
      shared.indexOf('$env:WSLENV ='),
    );
    expect(ps).toMatch(/\$ForwardedVars = @\([^)]*'GUILDWISE_WSL_DISTRO_NAME'/);
  });

  it('checks Docker Desktop before the Linux installer runs and again after (the distribution may have become the default)', () => {
    const fn = ps.slice(ps.indexOf('function Install-DedicatedDistro'), ps.indexOf('trap {'));
    const checks = [...fn.matchAll(/Assert-NoDockerIntegration \$DedicatedDistro/g)].map((m) => m.index ?? 0);
    expect(checks).toHaveLength(2);
    const run = fn.indexOf('exec bash /root/guildwise-install.sh');
    expect(checks[0]).toBeLessThan(run);
    expect(checks[1]).toBeGreaterThan(run);
    expect(ps).toContain('Docker Desktop > Settings > Resources > WSL integration, switch off $Distro');
    expect(ps).toContain('Join-Path $env:APPDATA "Docker\\$n"');
    expect(ps).toContain("@('settings-store.json', 'settings.json')");
  });
});

describe.skipIf(!hasPwsh)('Docker Desktop integration check (PowerShell)', () => {
  const verdict = (settings: string, isDefault: boolean) =>
    pwsh(
      ['Get-DockerIntegrationProblem'],
      `$s = [IO.File]::ReadAllText('${join(dir, 'settings.json')}')\n"[" + (Get-DockerIntegrationProblem $s 'guildwise-runner' $${isDefault}) + "]"`,
      {},
    );
  const check = (settings: string, isDefault: boolean) => {
    writeFileSync(join(dir, 'settings.json'), settings);
    return verdict(settings, isDefault).out;
  };

  it('passes without Docker Desktop, and when only other distributions are integrated', () => {
    expect(check('', false)).toBe('[]');
    expect(
      check('{"integratedWslDistros":["Ubuntu"],"enableIntegrationWithDefaultWslDistro":true}', false),
    ).toBe('[]');
  });

  it('refuses while the runner distribution is integrated (settings.json and the newer settings-store.json keys)', () => {
    expect(check('{"integratedWslDistros":["Ubuntu","guildwise-runner"]}', false)).toBe(
      "[Docker Desktop's WSL integration is on for guildwise-runner]",
    );
    expect(check('{"IntegratedWslDistros":["guildwise-runner"]}', false)).toBe(
      "[Docker Desktop's WSL integration is on for guildwise-runner]",
    );
  });

  it('refuses when the runner distribution is the default and the default is integrated', () => {
    expect(check('{"enableIntegrationWithDefaultWslDistro":true}', true)).toContain(
      'your default WSL distribution',
    );
    expect(check('{"EnableIntegrationWithDefaultWslDistro":true}', true)).toContain(
      'your default WSL distribution',
    );
    expect(check('{"enableIntegrationWithDefaultWslDistro":false}', true)).toBe('[]');
  });

  it('refuses when the settings cannot be read (it cannot be confirmed off)', () => {
    expect(check('{not json', false)).toContain('cannot be confirmed off');
  });
});

describe.skipIf(!hasPwsh)("the runner distribution's /etc/wsl.conf (PowerShell, then bash)", () => {
  const conf = (withUser: boolean) => {
    const target = join(dir, `wsl-${withUser}.conf`);
    const r = pwsh(
      ['Get-DedicatedWslConfScript'],
      `Get-DedicatedWslConfScript${withUser ? ' -WithUser' : ''}`,
    );
    expect(r.status, r.err).toBe(0);
    // the rendered script has CRLF line endings; Invoke-WslBash sends it with Unix ones (ConvertTo-Base64Unix)
    const sh = r.out.replace(/\r/g, '').replaceAll('/etc/wsl.conf', target);
    const b = spawnSync('bash', ['-c', sh], { encoding: 'utf8' });
    expect(b.stdout.trim()).toBe('wsl.conf written');
    return readFileSync(target, 'utf8');
  };
  const section = (ini: string, name: string) => {
    const m = new RegExp(`\\[${name}\\]\\n([^[]*)`).exec(ini);
    return (m?.[1] ?? '').trim().split('\n').filter(Boolean);
  };

  it('turns off Windows programs, the Windows PATH and the Windows drives, and turns systemd on', () => {
    const ini = conf(false);
    expect(section(ini, 'interop')).toEqual(['enabled=false', 'appendWindowsPath=false']);
    expect(section(ini, 'automount')).toEqual(['enabled=false', 'mountFsTab=false']);
    expect(section(ini, 'boot')).toEqual(['systemd=true']);
    expect(ini).not.toContain('[user]');
  });

  it('sets guildwise-runner as the default user once asked to', () => {
    expect(section(conf(true), 'user')).toEqual(['default=guildwise-runner']);
  });
});

describe.skipIf(!hasPwsh)('passing installer choices into the distribution (PowerShell, then bash)', () => {
  it('each set GUILDWISE_* choice arrives unchanged, whatever characters it holds; unset ones are not passed', () => {
    const value = `a b'c"d$(touch /tmp/x)\`e`;
    const r = pwsh(['Get-ForwardedExports', 'ConvertTo-Base64Unix'], 'Get-ForwardedExports', {
      GUILDWISE_DEVOPS_ORGS: value,
      GUILDWISE_YES: '1',
    });
    expect(r.status, r.err).toBe(0);
    expect(r.out).not.toContain('GUILDWISE_SKIP_BASELINE');
    const b = spawnSync('bash', ['-c', `${r.out} printf '%s|%s' "$GUILDWISE_DEVOPS_ORGS" "$GUILDWISE_YES"`], {
      encoding: 'utf8',
    });
    expect(b.stdout).toBe(`${value}|1`);
  });
});

describe('the default-distribution path (your own Ubuntu)', () => {
  const tail = ps.slice(ps.indexOf('# ---- 5. keep WSL alive'));
  it('uses the shared keep-alive and systemd functions, not its own copies', () => {
    expect(tail).toContain('Register-KeepAlive $Distro');
    expect(tail).toContain('Wait-Systemd $Distro $LinuxUser');
    expect(tail).not.toContain('Register-ScheduledTask');
    expect(tail).not.toContain('enable-linger');
    expect(ps.match(/\[System\.IO\.File\]::WriteAllLines\(\$wslConfig/g)).toHaveLength(1);
  });
  it('passes your installer choices on to the Linux installer (WSLENV), never values from the server', () => {
    const line = tail.split('\n').find((l) => l.startsWith('$env:WSLENV ='));
    expect(line).toContain("'GUILDWISE_RUNNER_USER/u'");
    expect(line).toContain('$ForwardedVars | ForEach-Object { "$_/u" }');
    for (const v of [
      'GUILDWISE_YES',
      'GUILDWISE_LEGACY',
      'GUILDWISE_DEVOPS_ORGS',
      'GUILDWISE_DOCKER',
      'GUILDWISE_DOCKER_SOCKET',
      'GUILDWISE_ACCEPT_SHARED_DAEMON',
      'GUILDWISE_SKIP_BASELINE',
    ])
      expect(ps).toMatch(new RegExp(`\\$ForwardedVars = @\\([^)]*'${v}'`));
    for (const gone of ['GUILDWISE_SUDO', 'GUILDWISE_APPROVE_APPS', 'GUILDWISE_WITH_DOCKER'])
      expect(ps).not.toMatch(new RegExp(`\\$ForwardedVars = @\\([^)]*'${gone}'`));
  });
});

describe.skipIf(!hasPwsh)('the whole Windows script (PowerShell parser)', () => {
  it('parses without errors', () => {
    const r = pwsh(
      [],
      `$t2 = $null; $e2 = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptFile}', [ref]$t2, [ref]$e2)
"errors=$($e2.Count)"; $e2 | ForEach-Object { $_.Message }`,
    );
    expect(r.out).toBe('errors=0');
  });
});

describe.skipIf(!hasPwsh)('keep-alive tasks of ours (PowerShell)', () => {
  it('matches only wsl.exe sleeping in the named distribution', () => {
    const cases: Array<[string, string, string, string]> = [
      ['wsl.exe', '-d Ubuntu --exec sleep infinity', 'Ubuntu', 'True'],
      ['wsl.exe', '-d Ubuntu-22.04 --exec sleep infinity', 'Ubuntu', 'False'],
      ['wsl.exe', '-d guildwise-runner --exec sleep infinity', 'Ubuntu', 'False'],
      ['wsl.exe', '-d Ubuntu --exec sleep infinity', '', 'True'],
      ['notepad.exe', '-d Ubuntu --exec sleep infinity', 'Ubuntu', 'False'],
      ['wsl.exe', '-d Ubuntu --exec bash', 'Ubuntu', 'False'],
    ];
    const body = cases
      .map(
        ([exe, args, distro]) =>
          `Test-OurKeepAliveTask ([pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = '${exe}'; Arguments = '${args}' }) }) '${distro}'`,
      )
      .join('\n');
    const r = pwsh(['Test-OurKeepAliveTask'], body);
    expect(r.out.split(/\r?\n/)).toEqual(cases.map((c) => c[3]));
  });
});
