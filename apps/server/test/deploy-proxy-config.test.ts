import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RELAY_BODY_HARD_MAX_BYTES, STORAGE_MAX_FILE_BYTES } from '@aom/shared';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const caddyfile = read('deploy/Caddyfile');
const compose = read('docker-compose.prod.yml');
const code = caddyfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/** The text between the `{` that opens at `open` and its matching `}`. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced block');
}
const blockAfter = (src: string, header: string): string => {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`missing ${header}`);
  return block(src, at + header.length - 1);
};

const SECRET_HEADERS = [
  'X-Form-Link',
  'X-Upload-Token',
  'X-File-Name',
  'X-Guildwise-Signature',
  'X-Hub-Signature-256',
  'X-Signature',
  'X-Goog-Channel-Token',
  'Idempotency-Key',
  'X-Guildwise-Delivery',
  'Cookie',
  'Authorization',
  'Proxy-Authorization',
];

function uriRule(): (u: string) => string {
  const m = code.match(/request>uri regexp "([^"]+)" "([^"]+)"/);
  if (!m) throw new Error('no uri regexp');
  const re = new RegExp(m[1]!.replace(/^\(\?i\)/, ''), 'gi');
  const repl = m[2]!.replace(/\$\{(\d)\}/g, '$$$1');
  return (u) =>
    u.replace(re, (...a: unknown[]) => {
      // RE2 expands unmatched groups to '', JS passes undefined
      const groups = a.slice(1, 5).map((g) => (typeof g === 'string' ? g : ''));
      return repl
        .replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '')
        .replace(/\[redacted\]$/, '[redacted]');
    });
}

describe('deploy/Caddyfile log filter', () => {
  it('has exactly one log block, the default logger in the global block', () => {
    expect((code.match(/^\s*log\b/gm) ?? []).length).toBe(1);
    expect(code.trimStart().startsWith('{')).toBe(true);
    expect(code.indexOf('log default')).toBeGreaterThan(-1);
    expect(code.indexOf('log default')).toBeLessThan(code.indexOf('{$AOM_DOMAIN'));
  });

  it('deletes every secret header and Set-Cookie', () => {
    for (const h of SECRET_HEADERS) expect(code).toContain(`request>headers>${h} delete`);
    expect(code).toContain('resp_headers>Set-Cookie delete');
  });

  it('keeps braces and backslashes out of the pattern', () => {
    const m = code.match(/request>uri regexp "([^"]+)"/)!;
    expect(m[1]).not.toMatch(/[\\]|\{\d/);
  });

  it('redacts the secret part of public addresses', () => {
    const f = uriRule();
    const cases: Array<[string, string]> = [
      ['/relay/in/rly_FAKE?hub.verify_token=FAKEV', '/relay/in/[redacted]'],
      ['/hooks/in/FAKE-HOOK', '/hooks/in/[redacted]'],
      ['/RELAY/IN/FAKE', '/RELAY/IN/[redacted]'],
      ['/f/FAKE', '/f/[redacted]'],
      ['/api/public/forms/FAKE/submissions/s/parts/1', '/api/public/forms/[redacted]/submissions/s/parts/1'],
      ['/invite/FAKE', '/invite/[redacted]'],
      ['/api/invitations/FAKE/accept', '/api/invitations/[redacted]/accept'],
      ['/x?code=FAKE&x=1', '/x?code=[redacted]&x=1'],
    ];
    for (const [input, out] of cases) expect(f(input)).toBe(out);
    expect(f('/api/m/desk/FAKE/apply')).not.toContain('FAKE');
    expect(f('/login?next=%2Fm%2Fdesk%2FFAKE')).not.toContain('FAKE');
    for (const u of ['/api/health', '/api/ws', '/assets/x.js']) expect(f(u)).toBe(u);
  });

  it('removes every value the app redactUrl removes', async () => {
    const { redactUrl } = await import('../src/app.ts');
    const f = uriRule();
    const samples = [
      '/relay/in/rly_FAKE?hub.verify_token=FAKEV',
      '/hooks/in/FAKE-HOOK',
      '/f/FAKE',
      '/api/public/forms/FAKE',
      '/api/public/forms/FAKE/submissions/s/parts/1',
      '/api/m/desk/FAKE/apply',
      '/m/desk/FAKE',
      '/login?next=%2Fm%2Fdesk%2FFAKE',
      '/invite/FAKE',
      '/api/invitations/FAKE/accept',
      '/x?token=FAKE',
      '/x?a=1&pairing_code=FAKE',
    ];
    for (const s of samples) {
      expect(redactUrl(s)).not.toContain('FAKE');
      expect(f(s)).not.toContain('FAKE');
    }
  });
});

describe('deploy/Caddyfile body limits', () => {
  const partRe = '^/api/public/forms/[^/]+/submissions/[^/]+/parts/[0-9]+$';
  const forms = blockAfter(code, 'handle /api/public/forms/* {');

  it('limits the form file part by the storage variable and the rest to 4 MiB', () => {
    expect(forms).toContain(`@formPart path_regexp ${partRe}`);
    expect(forms).toContain(`@formJson not path_regexp ${partRe}`);
    expect(blockAfter(forms, 'request_body @formPart {')).toContain(
      'max_size {$AOM_STORAGE_MAX_FILE_BYTES:26214400}',
    );
    expect(blockAfter(forms, 'request_body @formJson {')).toContain('max_size 4MiB');
  });

  it('limits hooks by the hook variable and relay to 4 MiB', () => {
    expect(blockAfter(code, 'handle /hooks/in/* {')).toContain(
      'max_size {$AOM_JOURNEY_HOOK_MAX_BYTES:65536}',
    );
    expect(blockAfter(code, 'handle /relay/in/* {')).toContain('max_size 4MiB');
  });

  it('never undercuts the app defaults', () => {
    expect(STORAGE_MAX_FILE_BYTES).toBe(26214400);
    expect(4 * 1024 * 1024).toBe(RELAY_BODY_HARD_MAX_BYTES);
    expect(read('apps/server/src/journeys/hooks/route.ts')).toContain(
      "envInt('AOM_JOURNEY_HOOK_MAX_BYTES', 65_536)",
    );
    expect(4 * 1024 * 1024).toBeGreaterThanOrEqual(1_048_576);
  });

  it('keeps streaming and the existing site behaviour', () => {
    expect(code).not.toMatch(/request_buffers|response_buffers/);
    expect(code).not.toMatch(/header_up[^\n]*(Content-Length|Transfer-Encoding)/i);
    expect(code).toContain('{$AOM_DOMAIN:localhost} {');
    expect(code).toContain('encode zstd gzip');
    expect(code).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(code).toContain('reverse_proxy video-worker:{$AOM_VIDEO_WORKER_PORT:4610}');
    expect(code).toContain('health_uri /api/health');
  });
});

describe('docker-compose.prod.yml', () => {
  const service = (name: string): string => {
    const m = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|^\\S|(?![\\s\\S]))`, 'm'));
    if (!m) throw new Error(`no service ${name}`);
    return m[1]!;
  };
  const shared = [
    'AOM_STORAGE_MAX_FILE_BYTES: ${AOM_STORAGE_MAX_FILE_BYTES:-26214400}',
    'AOM_JOURNEY_HOOK_MAX_BYTES: ${AOM_JOURNEY_HOOK_MAX_BYTES:-65536}',
  ];

  it('pins caddy to 2.11', () => {
    expect(service('caddy')).toContain('image: caddy:2.11\n');
  });

  it('gives the app and the proxy the same limits', () => {
    for (const l of shared) {
      expect(service('app')).toContain(l);
      expect(service('caddy')).toContain(l);
    }
    expect(service('app')).toContain('AOM_RELAY_MAX_BODY_BYTES: ${AOM_RELAY_MAX_BODY_BYTES:-1048576}');
  });
});
