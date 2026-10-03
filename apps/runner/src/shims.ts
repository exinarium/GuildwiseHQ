import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How to run one of the runner's own scripts. Bundled (`dist/aom-runner.mjs` next to `dist/aom.mjs`): plain node.
 * From source (dev, vitest): through the tsx CLI so no build is needed.
 */
export function selfCommand(script: 'aom' | 'mock-agent'): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, `${script}.mjs`);
  if (existsSync(bundled)) return [process.execPath, bundled];
  const src = script === 'aom' ? join(here, 'aom', 'aom-cli.ts') : join(here, 'adapters', 'mock-agent.ts');
  try {
    const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
    return [process.execPath, join(dirname(pkg), 'dist', 'cli.mjs'), src];
  } catch {
    return ['tsx', src];
  }
}

const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

/** Writes `bin/aom` and `bin/aom.cmd` (prepended to PATH in agent sessions). */
export async function writeShims(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const cmd = selfCommand('aom');
  const sh = `#!/bin/sh\nexec ${cmd.map(q).join(' ')} "$@"\n`;
  await writeFile(join(binDir, 'aom'), sh);
  await chmod(join(binDir, 'aom'), 0o755);
  const bat = `@echo off\r\n${cmd.map((c) => `"${c}"`).join(' ')} %*\r\n`;
  await writeFile(join(binDir, 'aom.cmd'), bat);
}
