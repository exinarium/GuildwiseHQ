import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SignOffDetection {
  required: boolean;
  /** What asked for the sign-off, for the notice on the desk. */
  reason?: string;
}

const DCO_TEXT = /Developer Certificate of Origin|Signed-off-by/i;

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether the repository at `dir` (a checkout) asks for a Developer Certificate of Origin sign-off: a DCO bot
 * configuration, a CI workflow that checks for `Signed-off-by`, or a contributing guide that names the DCO.
 */
export async function detectSignOff(dir: string): Promise<SignOffDetection> {
  if ((await read(join(dir, '.github', 'dco.yml'))) !== null)
    return { required: true, reason: '.github/dco.yml' };
  const workflows = join(dir, '.github', 'workflows');
  let names: string[] = [];
  try {
    names = (await readdir(workflows)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    // no workflows folder
  }
  for (const n of names) {
    const text = await read(join(workflows, n));
    if (text !== null && /Signed-off-by/i.test(text))
      return { required: true, reason: `.github/workflows/${n}` };
  }
  const gitlab = await read(join(dir, '.gitlab-ci.yml'));
  if (gitlab !== null && /Signed-off-by/i.test(gitlab)) return { required: true, reason: '.gitlab-ci.yml' };
  for (const f of ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md']) {
    const text = await read(join(dir, f));
    if (text !== null && DCO_TEXT.test(text)) return { required: true, reason: f };
  }
  return { required: false };
}
