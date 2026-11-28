#!/usr/bin/env node
// gate-fixes-2 F5: records what the REAL docker CLI and compose send, for docker-proxy-cli-bodies.test.ts.
//
// A recording relay is the fake socket server: it listens on a unix socket in a fresh /tmp/gwcap-<pid>/ and splices every
// connection to the local daemon, logging the client-to-daemon bytes (a relay, not a stub: compose needs real answers to
// reach its creates). Every command runs with DOCKER_HOST=unix://<relay>, cwd /tmp/gwcap-<pid>, and gwcap* names only;
// cleanup is by exact name, never by a glob. No dependencies: `node capture.mjs [upstream-socket]`.
//
// Each fixture: {command, requests:[{method,path}], bodies:[{method,path,body}]}, written next to this file.
import { spawn } from 'node:child_process';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const upstream = process.argv[2] ?? '/var/run/docker.sock';
const work = `/tmp/gwcap-${process.pid}`;
const bindDir = '/tmp/gwcap-bind';
mkdirSync(work);
mkdirSync(bindDir, { recursive: true });
const relayPath = join(work, 'relay.sock');

/** Connections per fixture name: each an array of client-to-daemon chunks. */
const logs = new Map();
let current = null;
const relay = createServer((client) => {
  const chunks = [];
  if (current) logs.get(current).push(chunks);
  const up = connect(upstream);
  client.on('data', (c) => {
    chunks.push(Buffer.from(c));
    up.write(c);
  });
  up.on('data', (c) => client.write(c));
  client.on('end', () => up.end());
  up.on('end', () => client.end());
  client.on('error', () => up.destroy());
  up.on('error', () => client.destroy());
});
await new Promise((r) => relay.listen(relayPath, r));

/** Parses one connection's bytes into HTTP requests; stops after an upgrade (the rest is a raw stream). */
function parse(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const end = buf.indexOf('\r\n\r\n', i);
    if (end < 0) break;
    const head = buf.subarray(i, end).toString('latin1').split('\r\n');
    const [method, path] = (head[0] ?? '').split(' ');
    const h = {};
    for (const line of head.slice(1)) {
      const c = line.indexOf(':');
      h[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    let j = end + 4;
    let body = Buffer.alloc(0);
    if (h['transfer-encoding']?.toLowerCase() === 'chunked') {
      const parts = [];
      for (;;) {
        const le = buf.indexOf('\r\n', j);
        const n = Number.parseInt(buf.subarray(j, le).toString('latin1'), 16);
        j = le + 2;
        if (!n) {
          j += 2;
          break;
        }
        parts.push(buf.subarray(j, j + n));
        j += n + 2;
      }
      body = Buffer.concat(parts);
    } else if (h['content-length']) {
      const n = Number(h['content-length']);
      body = buf.subarray(j, j + n);
      j += n;
    }
    out.push({ method, path, body: body.toString('utf8') });
    i = j;
    if ((h.connection ?? '').toLowerCase() === 'upgrade' || h.upgrade) break;
  }
  return out;
}

const env = { ...process.env, DOCKER_HOST: `unix://${relayPath}`, DOCKER_CLI_HINTS: 'false' };
delete env.DOCKER_CONTEXT;
const sh = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (c) => (o += c));
    p.stderr.on('data', (c) => (o += c));
    p.on('close', (code) => resolve({ code, out: o }));
  });

const BODY_PATHS = [
  /\/containers\/create$/,
  /\/containers\/[^/]+\/exec$/,
  /\/networks\/create$/,
  /\/volumes\/create$/,
  /\/networks\/[^/]+\/connect$/,
];
async function record(name, command) {
  current = name;
  logs.set(name, []);
  const r = await sh(command);
  current = null;
  await new Promise((res) => setTimeout(res, 300));
  const reqs = logs.get(name).flatMap((chunks) => parse(Buffer.concat(chunks)));
  const fixture = {
    command,
    exit: r.code,
    requests: reqs.map(({ method, path }) => ({ method, path })),
    bodies: reqs
      .filter((q) => q.method === 'POST' && BODY_PATHS.some((re) => re.test(q.path.split('?')[0])))
      .map(({ method, path, body }) => ({ method, path, body: body ? JSON.parse(body) : null })),
  };
  writeFileSync(join(here, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: exit ${r.code}, ${reqs.length} requests, ${fixture.bodies.length} bodies`);
  if (r.code !== 0) console.log(r.out.slice(-2000));
}

const compose = `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test
    ports:
      - "127.0.0.1:15433:5432"
    volumes:
      - gwcapdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 1s
      timeout: 3s
      retries: 30
  waiter:
    image: postgres:16
    entrypoint: ["sleep", "300"]
    depends_on:
      db:
        condition: service_healthy
volumes:
  gwcapdata: {}
`;
writeFileSync(join(work, 'compose.test-services.yml'), compose);

try {
  await record('run', 'docker run --rm postgres:16 true');
  await record('create', 'docker create --name gwcap-a postgres:16 true');
  await record(
    'run-tty',
    'script -qc "stty rows 24 cols 80; docker run --rm -it postgres:16 true" /dev/null',
  );
  await record('run-network-none', 'docker run --rm --network none postgres:16 true');
  await record('network-create', 'docker network create gwcap-net');
  await record('volume-create', 'docker volume create gwcap-vol');
  await record(
    'run-mounts',
    'docker run --rm --network gwcap-net -p 127.0.0.1:15432:5432 --mount type=volume,src=gwcap-vol,dst=/q ' +
      `--mount type=bind,src=${bindDir},dst=/w,readonly -v /anon postgres:16 true`,
  );
  await sh('docker run -d --name gwcap-b --entrypoint sleep postgres:16 300');
  await record('exec', 'docker exec gwcap-b true');
  await record('exec-tty', 'script -qc "stty rows 24 cols 80; docker exec -it gwcap-b true" /dev/null');
  await record('compose-up', 'docker compose -p gwcap -f compose.test-services.yml up -d --wait');
  await record('compose-exec', 'docker compose -p gwcap -f compose.test-services.yml exec -T db true');
  const v = await sh(
    "docker version --format '{{.Client.Version}} {{.Client.APIVersion}}'; docker compose version --short",
  );
  const [cli, api] = v.out.split('\n')[0].split(' ');
  writeFileSync(
    join(here, 'VERSIONS.json'),
    `${JSON.stringify({ docker: cli, api, compose: v.out.split('\n')[1], captured: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
} finally {
  // exact names only
  await sh('docker compose -p gwcap -f compose.test-services.yml down -v --timeout 1');
  await sh('docker rm -f gwcap-a gwcap-b');
  await sh('docker network rm gwcap-net');
  await sh('docker volume rm gwcap-vol');
  relay.close();
  rmSync(relayPath, { force: true });
  rmSync(join(work, 'compose.test-services.yml'), { force: true });
  rmdirSync(work);
  rmdirSync(bindDir);
}
