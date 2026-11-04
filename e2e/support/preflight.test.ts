import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { canBind, exitCodeOf, formatReport, type Line, tcpReady } from './preflight.ts';

const ready: Line = { name: 'postgres', target: 'x', status: 'ready', detail: '' };
const bad: Line = { name: 'hosted build', target: 'http://localhost:4710', status: 'NOT READY', detail: 'refused', fix: 'ask DevOps' };
const skip: Line = { name: 'docker', target: 'd', status: 'skipped', detail: 'skipped (--no-docker)' };

test('exit code is 0 when all ready or skipped, 1 when any is not ready', () => {
  assert.equal(exitCodeOf([ready, skip]), 0);
  assert.equal(exitCodeOf([ready, bad]), 1);
});

test('report names the port and the fix of a not-ready line', () => {
  const out = formatReport([ready, bad, skip]);
  assert.match(out, /NOT READY\s+hosted build\s+http:\/\/localhost:4710/);
  assert.match(out, /fix: ask DevOps/);
  assert.match(out, /skipped\s+docker/);
});

test('tcpReady and canBind against live and closed ports', async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as net.AddressInfo).port;
  assert.equal(await tcpReady('127.0.0.1', port), true);
  assert.equal(await canBind(port), false);
  s.close();
  await new Promise((r) => s.once('close', r));
  assert.equal(await tcpReady('127.0.0.1', port, 500), false);
  assert.equal(await canBind(port), true);
});
