import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { slugify } from '@aom/shared';

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Guildwise Simulation',
  GIT_AUTHOR_EMAIL: 'simulation@guildwise.invalid',
  GIT_COMMITTER_NAME: 'Guildwise Simulation',
  GIT_COMMITTER_EMAIL: 'simulation@guildwise.invalid',
};

/**
 * A throwaway "origin" for a project repository of a simulation organization: a bare repository on this server's disk
 * with one commit on `main`, so clone, worktrees, merge and push all work offline. Whatever URL the user typed, the
 * repository is this one: nothing ever contacts GitHub or any other host. Returns the absolute path (used as the remote).
 */
export async function createLocalOrigin(originsDir: string, name: string): Promise<string> {
  await mkdir(originsDir, { recursive: true });
  const slug = slugify(name, 30) || 'repo';
  const bare = join(originsDir, `${slug}-${randomBytes(3).toString('hex')}.git`);
  await run('git', ['init', '--bare', '-b', 'main', bare], { env: GIT_ENV });
  const work = await mkdtemp(join(originsDir, '.seed-'));
  try {
    await run('git', ['clone', '-q', bare, work], { env: GIT_ENV });
    await run('git', ['-C', work, 'checkout', '-q', '-b', 'main'], { env: GIT_ENV });
    await writeFile(
      join(work, 'README.md'),
      `# ${name}\n\nA simulated repository: it lives on the Guildwise server only and is thrown away with the simulation.\n`,
    );
    await writeFile(join(work, 'index.js'), `console.log(${JSON.stringify(name)});\n`);
    await run('git', ['-C', work, 'add', '-A'], { env: GIT_ENV });
    await run('git', ['-C', work, 'commit', '-q', '-m', 'Initial commit'], { env: GIT_ENV });
    await run('git', ['-C', work, 'push', '-q', 'origin', 'main'], { env: GIT_ENV });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return bare;
}
