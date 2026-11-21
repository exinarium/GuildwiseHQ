import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleaseSignPayload, ReleaseSignResult } from '@aom/shared';
import { z } from 'zod';
import type { SigningKey } from '../policy/schema.ts';
import { policyDir, writeFileAtomic } from '../policy/store.ts';
import { minisigKeyId, verifyMinisign } from '../update/minisign.ts';
import { insideRoot } from './release-prepare.ts';

/**
 * Release signing on the workstation that holds the key (R30, route 1). Only the key's PATH is ever stored
 * (`policy.json` `signingKeys`); the key file is handed to `minisign`, which reads it. The runner reads at most the
 * key file's header to tell a passphrase key (which can only sign at the keyboard) from one without (which `autoSign` may
 * use, Q14). Only the `.minisig` leaves the machine.
 */

export type SecretKeyKind = 'plain' | 'passphrase' | 'unknown';

/**
 * Reads the KDF field of a minisign secret key file (`untrusted comment:` line, then base64 of sig_alg[2] kdf_alg[2]
 * ...): `Sc` = scrypt (passphrase), two zero bytes = none. The key bytes themselves are never kept or logged.
 */
export function secretKeyKind(keyFile: string): SecretKeyKind {
  try {
    const lines = readFileSync(keyFile, 'utf8').replace(/\r/g, '').split('\n');
    if (!lines[0]?.startsWith('untrusted comment:')) return 'unknown';
    const head = Buffer.from((lines[1] ?? '').trim().slice(0, 8), 'base64');
    if (head.length < 4 || head.subarray(0, 2).toString('latin1') !== 'Ed') return 'unknown';
    const kdf = head.subarray(2, 4);
    if (kdf.toString('latin1') === 'Sc') return 'passphrase';
    if (kdf[0] === 0 && kdf[1] === 0) return 'plain';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export const sha256File = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

export type MinisignRunner = (
  args: string[],
  opts: { interactive: boolean },
) => Promise<{ code: number | null; stderr: string }>;

/** Runs the `minisign` binary (`AOM_MINISIGN_BIN` overrides it). Interactive: the passphrase prompt is on this terminal. */
export const runMinisign: MinisignRunner = (args, opts) =>
  new Promise((resolve) => {
    const p = spawn(process.env.AOM_MINISIGN_BIN || 'minisign', args, {
      stdio: opts.interactive ? 'inherit' : ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    p.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    p.on('error', (err) => resolve({ code: null, stderr: String(err) }));
    p.on('close', (code) => resolve({ code, stderr: stderr.slice(0, 2000) }));
  });

export const trustedCommentFor = (p: ReleaseSignPayload): string =>
  `${p.projectName} ${p.version} ${p.targetName}`.replace(/[\r\n]/g, ' ').slice(0, 200);

/**
 * `minisign -S -s <keyFile> -m <artefact> -t "<project> <version> <target>"` after checking that the file on disk is the
 * one the server named (its sha256). Returns the `release.sign` result. Throws with a plain reason otherwise.
 */
export async function signArtefact(o: {
  payload: ReleaseSignPayload;
  key: SigningKey;
  artefactPath: string;
  interactive: boolean;
  minisign?: MinisignRunner;
  /**
   * Only a file under this folder is ever signed (`<data dir>/release-prep`, where `release.prepare` packages): no other
   * path on the machine can be signed through the server (W14 review item 4).
   */
  allowedRoot?: string;
}): Promise<ReleaseSignResult> {
  const { payload: p, key } = o;
  if (key.keyId !== p.keyId) throw new Error(`key ${key.keyId} is not the requested key ${p.keyId}`);
  if (o.allowedRoot && !insideRoot(o.allowedRoot, o.artefactPath))
    throw new Error(`refused: ${o.artefactPath} is not a prepared release artefact of this workstation`);
  if (!existsSync(o.artefactPath))
    throw new Error(`the artefact ${o.artefactPath} is not on this workstation`);
  const sha = sha256File(o.artefactPath);
  if (sha !== p.artefactSha256)
    throw new Error(
      `the artefact on disk (sha256 ${sha.slice(0, 12)}...) is not the one the server asked to sign (${p.artefactSha256.slice(0, 12)}...): refused`,
    );
  if (!o.interactive && secretKeyKind(key.keyFile) !== 'plain')
    throw new Error(
      `key ${key.keyId} needs a passphrase: approve it at the keyboard (guildwise-runner approve)`,
    );
  const work = mkdtempSync(join(tmpdir(), 'aom-sign-'));
  try {
    const out = join(work, 'artefact.minisig');
    const r = await (o.minisign ?? runMinisign)(
      ['-S', '-s', key.keyFile, '-m', o.artefactPath, '-x', out, '-t', trustedCommentFor(p)],
      { interactive: o.interactive },
    );
    if (r.code !== 0 || !existsSync(out))
      throw new Error(`minisign could not sign (exit ${r.code ?? 'none'}): ${r.stderr.trim().slice(0, 300)}`);
    const minisig = readFileSync(out, 'utf8');
    // the file must not have changed while it was signed, and the signature must name the requested key
    if (sha256File(o.artefactPath) !== p.artefactSha256)
      throw new Error('the artefact changed while it was signed');
    if (minisigKeyId(minisig) !== p.keyId)
      throw new Error(
        `minisign signed with key ${minisigKeyId(minisig)}, not ${p.keyId}: check the key file`,
      );
    return { keyId: p.keyId, artefactSha256: p.artefactSha256, minisig };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Before a deploy to a target that requires signing, the runner checks the signature itself against the TARGET's public
 * key and the file on disk (R30 "Gate"), then writes it beside the artefact (`manifest.json.minisig`). A signature by any
 * other key, or over any other file, is refused.
 */
export function verifyArtefactSignature(o: {
  artefactPath: string;
  minisig: string;
  targetPublicKey: string;
  expectedSha256?: string;
  writeBeside?: boolean;
}): { ok: true; keyId: string } | { ok: false; reason: string } {
  if (!existsSync(o.artefactPath)) return { ok: false, reason: 'the artefact is not on this workstation' };
  const bytes = readFileSync(o.artefactPath);
  if (o.expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== o.expectedSha256)
    return { ok: false, reason: 'the artefact on disk is not the one that was signed' };
  const v = verifyMinisign(bytes, o.minisig, o.targetPublicKey);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (o.writeBeside) writeFileAtomic(`${o.artefactPath}.minisig`, o.minisig, 0o644);
  return { ok: true, keyId: v.keyId };
}

// ---------------------------------------------------------------- where the deploy left each artefact

const ArtefactIndexSchema = z.array(
  z.object({
    releaseId: z.string(),
    targetId: z.string(),
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.string(),
    at: z.iso.datetime(),
  }),
);
export type PreparedArtefact = z.infer<typeof ArtefactIndexSchema>[number];

/**
 * `release-artefacts.json` beside the policy: the artefacts this workstation's deploys produced (`release.artefact.prepared`),
 * so a later `release.sign` finds the file on disk. The server names only ids; the path is never taken from it.
 */
export class ArtefactIndex {
  readonly file: string;
  constructor(readonly dir: string = policyDir()) {
    this.file = join(dir, 'release-artefacts.json');
  }
  list(): PreparedArtefact[] {
    try {
      const parsed = ArtefactIndexSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }
  find(releaseId: string, targetId: string): PreparedArtefact | null {
    return this.list().find((a) => a.releaseId === releaseId && a.targetId === targetId) ?? null;
  }
  record(a: Omit<PreparedArtefact, 'at'>, now = new Date()): void {
    const rest = this.list().filter((x) => !(x.releaseId === a.releaseId && x.targetId === a.targetId));
    rest.push({ ...a, at: now.toISOString() });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(rest.slice(-100), null, 2)}\n`, 0o600);
  }
}
