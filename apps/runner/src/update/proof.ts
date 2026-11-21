import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RELEASE_MANIFEST_MAX_BYTES, RELEASE_MINISIG_MAX_BYTES, type SignedReleaseProof } from '@aom/shared';
import { detectLayout } from './layout.ts';

/**
 * The signed-release proof (R18-U, R27): the installer keeps the verified `manifest.json` and `manifest.json.minisig` in
 * the runner root; a self-update keeps them beside the version it unpacked (`<root>/<version>/`). The runner sends both
 * at pairing and in every `hello` (`release{manifest, minisig}`), only when the manifest names exactly the version this
 * process is. The server checks them; it cannot attest the code this machine runs (Q10).
 */

function readSmall(file: string, max: number): string | null {
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > 0 && Buffer.byteLength(text) <= max ? text : null;
  } catch {
    return null;
  }
}

/** The proof from the first folder that holds a manifest for `version` and its signature. */
export function readReleaseProof(dirs: readonly string[], version: string): SignedReleaseProof | null {
  for (const dir of dirs) {
    const manifest = readSmall(join(dir, 'manifest.json'), RELEASE_MANIFEST_MAX_BYTES);
    const minisig = readSmall(join(dir, 'manifest.json.minisig'), RELEASE_MINISIG_MAX_BYTES);
    if (!manifest || !minisig) continue;
    try {
      if ((JSON.parse(manifest) as { version?: unknown }).version !== version) continue;
    } catch {
      continue;
    }
    return { manifest, minisig };
  }
  return null;
}

/**
 * Where this process looks: its version folder (`<root>/<version>/`, kept by a self-update) and the runner root (kept by
 * the installer). Outside the installer layout (a checkout, a dev runner) there is no proof.
 */
export function proofDirs(entryFile: string | undefined = process.argv[1]): string[] {
  const layout = detectLayout(entryFile);
  if (!layout) return [];
  return [dirname(layout.packageDir), layout.root];
}

export function currentReleaseProof(version: string, entryFile?: string): SignedReleaseProof | null {
  return readReleaseProof(proofDirs(entryFile), version);
}
