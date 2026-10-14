import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startForwards } from '../src/runs/forward.ts';
import { AOM_ENV_SCRIPT, writeShims } from '../src/shims.ts';
import { findJunitFiles, parseJunit, readJunit } from '../src/testing/junit.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const SAMPLE = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="api" tests="4" failures="1" skipped="1" time="2.5">
    <testcase classname="api.auth" name="logs in" time="0.5"/>
    <testcase classname="api.auth" name="rejects a bad password" time="0.25"></testcase>
    <testcase classname="api.items" name="creates &amp; lists" time="1.0"><failure message="boom">stack</failure></testcase>
    <testcase classname="api.items" name="later" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;

describe('JUnit reports', () => {
  it('counts passed, failed and skipped cases and names the failures', () => {
    const c = parseJunit(SAMPLE);
    expect(c).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
    expect(c.failures).toEqual(['api.items > creates & lists']);
    expect(c.seconds).toBeCloseTo(1.75);
  });

  it('counts an error element as a failure and ignores a skipped case that also failed', () => {
    const c = parseJunit(
      '<testsuite><testcase name="a"><error/></testcase><testcase name="b"><skipped/><failure/></testcase></testsuite>',
    );
    expect(c).toMatchObject({ passed: 0, failed: 2, skipped: 0 });
  });

  it('adds up every file a glob names, inside the folder only', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'reports', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'reports', 'a.xml'), SAMPLE);
    writeFileSync(join(dir, 'reports', 'deep', 'b.xml'), SAMPLE);
    writeFileSync(join(dir, 'reports', 'notes.txt'), 'x');
    const outside = tmp();
    writeFileSync(join(outside, 'secret.xml'), SAMPLE);
    symlinkSync(join(outside, 'secret.xml'), join(dir, 'reports', 'link.xml'));
    expect(findJunitFiles(dir, 'reports/**/*.xml')).toHaveLength(2);
    const total = readJunit(dir, 'reports/**/*.xml');
    expect(total).toMatchObject({ passed: 4, failed: 2, skipped: 2, files: 2 });
    expect(() => readJunit(dir, 'nothing/*.xml')).toThrow(/no report matches/);
    expect(() => findJunitFiles(dir, '../x.xml')).toThrow(/cannot use/);
    expect(() => findJunitFiles(dir, '/etc/passwd')).toThrow(/relative/);
  });

  it('refuses files that are not JUnit reports', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x.xml'), '<note>hello</note>');
    expect(() => readJunit(dir, 'x.xml')).toThrow(/none is a JUnit report/);
  });
});

const listen = (server: net.Server | http.Server, port = 0): Promise<number> =>
  new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );

describe('environment forwarders', () => {
  it('connect a Unix socket to the environment port and nothing else, and refuse a port that left', async () => {
    const app = http.createServer((_q, s) => s.end('hello from the app'));
    const port = await listen(app);
    const live = new Set([port]);
    const agentTmp = tmp('aom-fwd-');
    const fw = await startForwards(agentTmp, [port, 3128], () => live);
    try {
      expect(fw.sockets.map((s) => s.port)).toEqual([port]); // 3128 is the sandbox proxy bridge: never forwarded
      const get = () =>
        new Promise<string>((resolve, reject) => {
          const c = net.connect(fw.sockets[0]?.socket as string);
          let data = '';
          c.on('data', (d) => {
            data += d;
          });
          c.on('close', () => resolve(data));
          c.on('error', () => resolve(data)); // refused: the forwarder hangs up before the request is written
          c.write('GET / HTTP/1.0\r\n\r\n');
        });
      expect(await get()).toContain('hello from the app');
      live.clear(); // the environment stopped
      expect(await get()).toBe('');
    } finally {
      fw.close();
      app.close();
    }
  });
});

describe('aom-env', () => {
  const run = (dir: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(dir, 'aom-env'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 60_000,
    });
  /** Asynchronous: the forwarders live in this process, a synchronous spawn would block them. */
  const runAsync = (dir: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('bash', [join(dir, 'aom-env'), ...args], {
        env: { PATH: process.env.PATH ?? '', ...env },
      });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d) => {
        stdout += d;
      });
      c.stderr.on('data', (d) => {
        stderr += d;
      });
      c.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  it('runs the command with its exit status and rejects bad usage', async () => {
    const dir = tmp();
    await writeShims(dir);
    expect(run(dir, ['--', 'bash', '-c', 'echo hi; exit 3'])).toMatchObject({ status: 3, stdout: 'hi\n' });
    expect(run(dir, ['--timeout', 'x', '--', 'true']).status).toBe(2);
    expect(run(dir, ['--timeout', '5']).status).toBe(2);
    expect(AOM_ENV_SCRIPT).toContain('timeout --kill-after=15');
  });

  it('starts a socat per forward so the command reaches the app on its own port', async () => {
    if (spawnSync('socat', ['-V']).status !== 0) return; // socat is a sandbox prerequisite; skip where it is absent
    const dir = tmp();
    await writeShims(dir);
    const app = http.createServer((_q, s) => s.end('app-body'));
    const appPort = await listen(app);
    const agentTmp = tmp('aom-fwd-');
    const fw = await startForwards(agentTmp, [appPort], () => new Set([appPort]));
    try {
      // The command looks for the app on another port (outside a network namespace the real port is taken by the app itself).
      const free = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as net.AddressInfo).port;
          s.close(() => resolve(p));
        });
      });
      const sock = fw.sockets[0]?.socket as string;
      const r = await runAsync(
        dir,
        [
          '--timeout',
          '1',
          '--',
          'bash',
          '-c',
          `exec 3<>/dev/tcp/127.0.0.1/${free}; printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3; cat <&3`,
        ],
        { AOM_ENV_FORWARDS: `${free}=${sock}` },
      );
      expect(r.stdout).toContain('app-body');
    } finally {
      fw.close();
      app.close();
    }
  });

  it('kills a command that outlives --timeout', async () => {
    const dir = tmp();
    await writeShims(dir);
    // timeout takes whole minutes: prove the hang protection with the smallest, through a stub `timeout` that is fast.
    const stub = tmp();
    writeFileSync(join(stub, 'timeout'), '#!/bin/sh\nshift 2\nexit 124\n', { mode: 0o755 });
    const r = run(dir, ['--timeout', '1', '--', 'sleep', '100'], {
      PATH: `${stub}:${process.env.PATH ?? ''}`,
    });
    expect(r.status).toBe(124);
    expect(r.stderr).toContain('timeout');
  });
});
