#!/usr/bin/env node
// Checks that a file is a minisign PUBLIC key and prints its key line (or, with --id, its key id). Refuses anything that
// looks like a secret key, so a secret key never reaches a build, a commit or an image (core DESIGN R18-U, R30).
//
//   node scripts/runner-key-check.mjs [--id] <file.pub>
//
// A minisign public key file is exactly two lines: "untrusted comment: ..." and the base64 of 42 bytes starting with "Ed"
// (algorithm, 8-byte key id, 32-byte Ed25519 key). Used by package-runner.sh and set-runner-release-key.sh.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const wantId = args[0] === '--id';
const file = wantId ? args[1] : args[0];
const die = (msg) => {
  process.stderr.write(`runner key check: ${msg}\n`);
  process.exit(1);
};
if (!file) die('usage: runner-key-check.mjs [--id] <file.pub>');
let text;
try {
  text = readFileSync(file, 'utf8');
} catch (err) {
  die(`cannot read ${file} (${err.message})`);
}
const lines = text
  .replace(/\r/g, '')
  .split('\n')
  .filter((l) => l.trim() !== '');
const secret = () =>
  die(
    `${file} looks like a SECRET key: give the public key (.pub) file, and keep the secret key where it is`,
  );
if (/secret key/i.test(lines[0] ?? '') || /encrypted/i.test(lines[0] ?? '')) secret();
// a minisign secret key line is the base64 of 158 bytes (algorithm, KDF, checksum, salt, limits, the encrypted key)
if (lines[1] && Buffer.from(lines[1].trim(), 'base64').length >= 100) secret();
if (lines.length !== 2)
  die(`${file} is not a minisign public key file (expected 2 lines, found ${lines.length})`);
if (!lines[0].startsWith('untrusted comment:'))
  die(`${file}: the first line must be "untrusted comment: ..."`);
const line = lines[1].trim();
if (!/^RW[A-Za-z0-9+/]{54}$/.test(line))
  die(`${file}: the second line is not a minisign public key (RW... of 56 characters)`);
const bytes = Buffer.from(line, 'base64');
if (bytes.length !== 42 || bytes[0] !== 0x45 || bytes[1] !== 0x64)
  die(`${file}: not an Ed25519 minisign public key`);
const id = Buffer.from(bytes.subarray(2, 10)).reverse().toString('hex').toUpperCase();
process.stdout.write(`${wantId ? id : line}\n`);
