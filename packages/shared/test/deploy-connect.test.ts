import { describe, expect, it } from 'vitest';
import {
  CommandPayloadSchemas,
  ConnectRequestSchema,
  connectErrorText,
  DeployConnectPayloadSchema,
  DeployKeyPayloadSchema,
  DeployPreparePayloadSchema,
  describePrepareAction,
  ENVELOPE_COMMANDS,
  keyLabel,
  PrepareActionSchema,
  type ProbeReport,
  planPrepare,
  preferredHostKey,
  ServerAddressSchema,
  SshUserSchema,
  suggestAlias,
} from '../src/index.ts';

const U = '7f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const FP = `SHA256:${'A'.repeat(43)}`;

const report = (over: Partial<ProbeReport> = {}): ProbeReport => ({
  scope: 'ssh_target',
  at: new Date().toISOString(),
  docker: { installed: true, usable: true, version: '29', composeVersion: '2.40.0' },
  containers: [],
  composeFiles: [],
  volumes: [],
  folders: [],
  backups: [],
  proxies: [],
  urls: [],
  listeners: [],
  ...over,
});

describe('values that reach ssh', () => {
  it('addresses and users are plain: no option, no shell, no user@host', () => {
    for (const ok of ['203.0.113.9', 'shop.example.com', 'srv-1.example.org', 'localhost'])
      expect(ServerAddressSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      '-oProxyCommand=x',
      'a b',
      'root@host',
      'a;b',
      '$(x)',
      'host:22',
      '',
      'a\nb',
      '[::1]',
      '.x',
      'x.',
    ])
      expect(ServerAddressSchema.safeParse(bad).success, bad).toBe(false);
    for (const ok of ['root', 'deploy', 'ubuntu', 'a.b-c_d'])
      expect(SshUserSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['-x', 'a b', 'a;b', '1abc', 'a@b', ''])
      expect(SshUserSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('a key comment and an alias are made safe from any computer name', () => {
    expect(keyLabel("Pieter's Laptop (Office) #2")).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(keyLabel('   ')).toBe('workstation');
    expect(suggestAlias('My Shop!')).toBe('aom-my-shop');
    expect(suggestAlias('My Shop!', ['aom-my-shop'])).toBe('aom-my-shop-2');
  });

  it('prefers the ed25519 host key for the plain-language comparison', () => {
    const keys = [
      { type: 'ssh-rsa', fingerprint: FP },
      { type: 'ssh-ed25519', fingerprint: FP },
    ];
    expect(preferredHostKey(keys)?.type).toBe('ssh-ed25519');
  });
});

describe('commands', () => {
  it('are in the protocol; only the connect carries an envelope', () => {
    for (const c of [
      'deploy.hostkey',
      'deploy.key',
      'deploy.connect',
      'deploy.revoke',
      'deploy.prepare',
    ] as const)
      expect(CommandPayloadSchemas[c]).toBeDefined();
    expect(ENVELOPE_COMMANDS.has('deploy.connect')).toBe(true);
    expect(ENVELOPE_COMMANDS.has('deploy.key')).toBe(false);
  });

  it('a key is for a target or for a reference, never both', () => {
    expect(DeployKeyPayloadSchema.safeParse({ projectId: U, label: 'PC' }).success).toBe(false);
    expect(DeployKeyPayloadSchema.safeParse({ projectId: U, label: 'PC', targetId: U }).success).toBe(true);
    expect(
      DeployKeyPayloadSchema.safeParse({ projectId: U, label: 'PC', targetId: U, keyRef: U }).success,
    ).toBe(false);
  });

  it('connect needs the confirmed host key and, for a password or key file, the sealed secret', () => {
    const base = { projectId: U, targetId: U, alias: 'aom-shop', label: 'PC' };
    expect(DeployConnectPayloadSchema.safeParse({ ...base, method: 'password' }).success).toBe(false);
    expect(
      DeployConnectPayloadSchema.safeParse({
        ...base,
        method: 'password',
        address: 'shop.example.com',
        user: 'root',
        hostKeyFingerprint: FP,
        keyId: 'k',
        ciphertext: 'c',
      }).success,
    ).toBe(true);
    expect(
      DeployConnectPayloadSchema.safeParse({
        ...base,
        method: 'panel',
        address: 'shop.example.com',
        user: 'root',
      }).success,
    ).toBe(false);
    expect(
      DeployConnectPayloadSchema.safeParse({ ...base, method: 'alias', alias: 'prod-server' }).success,
    ).toBe(true);
    expect(ConnectRequestSchema.safeParse({ workstationId: U, method: 'alias', alias: 'x' }).success).toBe(
      false,
    );
  });

  it('prepare is a closed list: no free command, a safe domain, a path inside the project', () => {
    for (const bad of [
      { kind: 'run', cmd: 'rm -rf /' },
      { kind: 'caddy_site', domain: 'a b.com', upstreamPort: 80 },
      { kind: 'caddy_site', domain: 'https://x.com', upstreamPort: 80 },
      { kind: 'create_dir', path: '/opt/../etc' },
      { kind: 'create_dir', path: 'relative' },
      { kind: 'write_compose', path: '/opt/x/docker-compose.yml', repoPath: '../../etc/passwd' },
      { kind: 'start_services', composeFile: '/opt/x/c.yml', project: 'Bad Name' },
    ])
      expect(PrepareActionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(
      DeployPreparePayloadSchema.safeParse({
        projectId: U,
        hosting: 'ssh',
        alias: 'aom-shop',
        actions: [{ kind: 'install_docker' }, { kind: 'create_dir', path: '/opt/shop' }],
      }).success,
    ).toBe(true);
  });

  it('every error has a sentence for a person', () => {
    for (const e of [
      'bad_password',
      'host_key_changed',
      'copy_paste_needed',
      'key_not_accepted',
      'unreachable',
    ] as const)
      expect(connectErrorText(e).length).toBeGreaterThan(20);
    expect(connectErrorText('host_key_changed')).toContain('Guildwise will not connect');
  });
});

describe('planPrepare: detect first, change only what is missing', () => {
  it('a bare server: Docker, the folder with backups, a compose file from the project, Caddy for the domain', () => {
    const p = planPrepare(report({ docker: { installed: false, usable: false } }), {
      hosting: 'ssh',
      appDir: '/opt/shop',
      domain: 'shop.example.com',
      upstreamPort: 4600,
      composeFromRepo: { repoPath: 'deploy/docker-compose.yml' },
    });
    expect(p.actions.map((a) => a.kind)).toEqual([
      'install_docker',
      'create_dir',
      'create_dir',
      'write_compose',
      'caddy_site',
    ]);
    expect(p.blockers).toEqual([]);
    for (const a of p.actions) expect(PrepareActionSchema.safeParse(a).success).toBe(true);
    expect(p.actions.map((a) => describePrepareAction(a)).join('\n')).toContain('HTTPS for shop.example.com');
  });

  it('an existing setup is adopted: nothing to do, everything found is listed as reused', () => {
    const p = planPrepare(
      report({
        folders: [{ path: '/opt/shop', exists: true, entries: ['docker-compose.yml', 'backups'] }],
        composeFiles: [
          {
            path: '/opt/shop/docker-compose.yml',
            services: [{ name: 'app', ports: [], volumes: [], envFiles: [], vars: [] }],
            volumes: [],
          },
        ],
        backups: [{ dir: '/opt/shop/backups', count: 3 }],
        proxies: [{ kind: 'caddy', via: 'container', name: 'caddy', sites: ['shop.example.com'] }],
      }),
      { hosting: 'ssh', appDir: '/opt/shop', domain: 'shop.example.com', upstreamPort: 4600 },
    );
    expect(p.actions).toEqual([]);
    expect(p.reuse.join(' ')).toContain('already served by caddy');
    expect(p.reuse.join(' ')).toContain('compose file is already');
  });

  it('adds one site to an existing Caddy; never touches nginx, traefik or a busy port', () => {
    const caddy = planPrepare(
      report({ proxies: [{ kind: 'caddy', via: 'systemd', name: 'caddy', sites: ['other.com'] }] }),
      { hosting: 'ssh', domain: 'shop.example.com', upstreamPort: 4600 },
    );
    expect(caddy.actions).toEqual([{ kind: 'caddy_site', domain: 'shop.example.com', upstreamPort: 4600 }]);
    const nginx = planPrepare(
      report({ proxies: [{ kind: 'nginx', via: 'systemd', name: 'nginx', sites: [] }] }),
      { hosting: 'ssh', domain: 'shop.example.com', upstreamPort: 4600 },
    );
    expect(nginx.actions).toEqual([]);
    expect(nginx.blockers.join(' ')).toContain('only sets up HTTPS with Caddy');
    const busy = planPrepare(report({ listeners: [80] }), {
      hosting: 'ssh',
      domain: 'shop.example.com',
      upstreamPort: 4600,
    });
    expect(busy.actions).toEqual([]);
    expect(busy.blockers.join(' ')).toContain('ports 80 or 443');
  });

  it('Docker that this user may not use is a blocker, not an install', () => {
    const p = planPrepare(report({ docker: { installed: true, usable: false } }), { hosting: 'ssh' });
    expect(p.actions).toEqual([]);
    expect(p.blockers.join(' ')).toContain('docker group');
  });

  it('a new copy on this computer: folder, compose file, then the supporting parts (not the app)', () => {
    const p = planPrepare(report({ scope: 'local' }), {
      hosting: 'this_computer',
      appDir: '/home/u/guildwise/shop-uat',
      composeFromRepo: { repoPath: 'docker-compose.yml' },
      project: 'aom-shop-uat',
      appService: 'app',
    });
    expect(p.actions.map((a) => a.kind)).toEqual([
      'create_dir',
      'create_dir',
      'write_compose',
      'start_services',
    ]);
    expect(p.actions.at(-1)).toMatchObject({ except: ['app'], project: 'aom-shop-uat' });
    const noDocker = planPrepare(report({ scope: 'local', docker: { installed: false, usable: false } }), {
      hosting: 'this_computer',
    });
    expect(noDocker.blockers.join(' ')).toContain('Docker is not installed');
  });
});
