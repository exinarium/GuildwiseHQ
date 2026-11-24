import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A user-level Node the way the official tarball lays it out (bin/node, bin/npm -> lib/node_modules/npm/bin/npm-cli.js),
 * inside the temp dir, with a STUB npm: no registry is reachable by design (the product's egress proxy refuses loopback
 * and non-standard ports, and lockfile URLs must be https), so the stub edits package.json and writes a lockfile with an
 * https registry URL. The real `aom devops install`, toolchain lookup, bwrap stages and copy-back run around it; the real
 * download is an owner item. `node` is a COPY of this machine's node (not a link into anybody's home).
 */
export function makeStubToolchain(name = 'node-stub'): { root: string; bin: string } {
  const base = process.env.AOM_COMBINED_TOOLS;
  // the install box mounts its own /tmp over the real one (runs/sandbox.ts), so a toolchain under /tmp is invisible to it:
  // like a real one it must live in a home folder. combined.sh makes this folder (~/.aom-combined-tools.*) and removes it.
  if (!base || !base.startsWith(`${process.env.HOME}/.aom-combined-tools.`))
    throw new Error('AOM_COMBINED_TOOLS (a ~/.aom-combined-tools.* folder made by combined.sh) is required');
  const root = join(base, name);
  const bin = join(root, 'bin');
  const npmDir = join(root, 'lib', 'node_modules', 'npm');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(npmDir, 'bin'), { recursive: true });
  copyFileSync(process.execPath, join(bin, 'node'));
  chmodSync(join(bin, 'node'), 0o755);
  writeFileSync(join(npmDir, 'package.json'), '{"name":"npm","version":"11.20.0"}\n');
  const cli = join(npmDir, 'bin', 'npm-cli.js');
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const i = args.findIndex((a) => ['add', 'install', 'i'].includes(a));
const spec = args.slice(i + 1).find((a) => !a.startsWith('-')) || 'left-pad@1.3.0';
const at = spec.lastIndexOf('@');
const pkg = at > 0 ? spec.slice(0, at) : spec;
const version = at > 0 ? spec.slice(at + 1) : '1.3.0';
const manifest = fs.existsSync('package.json') ? JSON.parse(fs.readFileSync('package.json', 'utf8')) : { name: 'toy' };
const dev = args.includes('--dev') || args.includes('-D') || args.includes('--save-dev');
const key = dev ? 'devDependencies' : 'dependencies';
manifest[key] = { ...(manifest[key] || {}), [pkg]: version };
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\\n');
fs.writeFileSync('package-lock.json', JSON.stringify({
  name: manifest.name, lockfileVersion: 3, requires: true,
  packages: { '': { name: manifest.name, [key]: manifest[key] },
    ['node_modules/' + pkg]: { version, resolved: 'https://registry.npmjs.org/' + pkg + '/-/' + pkg + '-' + version + '.tgz', integrity: 'sha512-' + Buffer.from(pkg + version).toString('base64') } },
}, null, 2) + '\\n');
console.log('added ' + pkg + '@' + version);
`,
  );
  chmodSync(cli, 0o755);
  symlinkSync(join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, 'npm'));
  return { root, bin };
}
