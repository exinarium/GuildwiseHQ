#!/usr/bin/env node
// Writes the runner release manifest (packages/shared RunnerReleaseManifestSchema) to stdout. The key holder signs these
// exact bytes with minisign; the runner and the server verify them (core DESIGN R18-U).
//
//   node scripts/runner-manifest.mjs <aom-runner-<v>.tgz> <version> <floor> [<node-runtime.json>]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [tgz, version, floor, nodeRuntimeFile] = process.argv.slice(2);
if (!tgz || !version || !floor) {
  process.stderr.write('usage: runner-manifest.mjs <tgz> <version> <floor> [<node-runtime.json>]\n');
  process.exit(2);
}
const file = basename(tgz);
if (file !== `aom-runner-${version}.tgz`) {
  process.stderr.write(`runner manifest: ${file} is not aom-runner-${version}.tgz\n`);
  process.exit(1);
}
let nodeRuntime = {};
if (nodeRuntimeFile) {
  nodeRuntime = JSON.parse(readFileSync(nodeRuntimeFile, 'utf8'));
  for (const [k, v] of Object.entries(nodeRuntime))
    if (!v || typeof v.url !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256 ?? '')) {
      process.stderr.write(`runner manifest: nodeRuntime ${k} needs a url and a sha256\n`);
      process.exit(1);
    }
}
const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
const manifest = { version, file, sha256, minRunner: floor, floor, allowDowngrade: false, nodeRuntime };
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
