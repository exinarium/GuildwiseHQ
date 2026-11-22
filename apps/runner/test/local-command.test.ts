import { localCommandOk } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { BARE_CLI, detectWslDistro, localCli, localCommand, runnerCli } from '../src/policy/local-command.ts';

describe('local-command renderer', () => {
  it('dedicated user: sudo -u with the absolute bin path (sudo secure_path never finds the bare command)', () => {
    const cli = localCli({ username: 'guildwise-runner', home: '/home/guildwise-runner' });
    expect(cli).toBe('sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner');
    expect(localCommand(cli, 'approve', ['a1b2c3d4e5'])).toBe(`${cli} approve a1b2c3d4e5`);
  });

  it('a named instance uses its own user', () => {
    const cli = localCli({ username: 'guildwise-runner-uat', home: '/home/guildwise-runner-uat' });
    expect(cli).toBe(
      'sudo -u guildwise-runner-uat -H /home/guildwise-runner-uat/.local/bin/guildwise-runner',
    );
    expect(localCommandOk(`${cli} setup`)).toBe(true);
  });

  it('current user and macOS: the absolute bin path only', () => {
    expect(localCli({ username: 'anna', home: '/home/anna' })).toBe('/home/anna/.local/bin/guildwise-runner');
    const mac = localCli({ username: 'guildwise-runner', home: '/Users/guildwise-runner' });
    expect(mac).toBe('sudo -u guildwise-runner -H /Users/guildwise-runner/.local/bin/guildwise-runner');
  });

  it('WSL: a wsl -d prefix', () => {
    const cli = localCli({ username: 'anna', home: '/home/anna', wslDistro: 'Guildwise' });
    expect(cli).toBe('wsl -d Guildwise -- /home/anna/.local/bin/guildwise-runner');
    expect(localCommandOk(`${cli} pending`)).toBe(true);
    expect(detectWslDistro({ WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toBe('Ubuntu-24.04');
    expect(detectWslDistro({ WSL_DISTRO_NAME: 'bad name' })).toBeUndefined();
    expect(detectWslDistro({})).toBeUndefined();
  });

  it('WSL with the dedicated runner user (dedicated distro and shared Ubuntu): `wsl -d <distro> -u <user> --` [B3]', () => {
    const dedicated = localCli({
      username: 'guildwise-runner',
      home: '/home/guildwise-runner',
      wslDistro: 'guildwise-runner',
    });
    expect(dedicated).toBe(
      'wsl -d guildwise-runner -u guildwise-runner -- /home/guildwise-runner/.local/bin/guildwise-runner',
    );
    expect(localCommand(dedicated, 'approve', ['a1b2c3d4e5'])).toBe(`${dedicated} approve a1b2c3d4e5`);
    const shared = localCli({
      username: 'guildwise-runner-uat',
      home: '/home/guildwise-runner-uat',
      wslDistro: 'Ubuntu',
    });
    expect(shared).toBe(
      'wsl -d Ubuntu -u guildwise-runner-uat -- /home/guildwise-runner-uat/.local/bin/guildwise-runner',
    );
    expect(localCommandOk(`${shared} setup`)).toBe(true);
  });

  it('demo videos (mock runtime only) show a demo runner user, never the real home', () => {
    expect(runnerCli(undefined, { AOM_RUNNER_MOCK: '1', AOM_MOCK_RUNNER_USER: 'guildwise-runner' })).toBe(
      'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner',
    );
    // ignored outside the mock runtime, and for anything that is not a runner user name
    expect(runnerCli(undefined, { AOM_MOCK_RUNNER_USER: 'guildwise-runner' })).not.toContain(
      '/home/guildwise-runner/',
    );
    expect(runnerCli(undefined, { AOM_RUNNER_MOCK: '1', AOM_MOCK_RUNNER_USER: 'root' })).not.toContain(
      '/home/root',
    );
  });

  it('a home that would need quoting falls back to the bare command', () => {
    expect(localCli({ username: 'anna', home: '/home/an na' })).toBe(BARE_CLI);
  });

  it('refuses to render an argument outside the grammar', () => {
    const cli = localCli({ username: 'anna', home: '/home/anna' });
    expect(localCommand(cli, 'repo allow-scripts', ['--help'])).toBeNull();
    expect(localCommand(cli, 'approve', ['x; rm -rf ~'])).toBeNull();
  });
});
