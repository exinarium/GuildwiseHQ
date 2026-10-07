/**
 * Renders the workstation installers with sample values into a directory (default: ./installer-out), for linting and for
 * running them in a throwaway container. Usage: tsx scripts/render-installers.ts <dir> [serverUrl] [pairingCode]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderBash, renderPowerShell } from '../src/installer/render.ts';

const dir = process.argv[2] ?? 'installer-out';
const serverUrl = process.argv[3] ?? 'https://guildwise.example.com';
const pairingCode = process.argv[4] ?? 'ABCD-EFGH';
const p = {
  serverUrl,
  pairingCode,
  sessionToken: 'sample-session-token-0123456789',
  workstationName: "Pieter's laptop",
  release: { version: '0.1.0', sha256: 'a'.repeat(64) },
  generatedAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 60_000),
};
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'install-linux.sh'), renderBash('linux', p), { mode: 0o755 });
writeFileSync(join(dir, 'install-macos.sh'), renderBash('macos', p), { mode: 0o755 });
writeFileSync(
  join(dir, 'install-windows.ps1'),
  renderPowerShell({
    ...p,
    scriptUrl: `${serverUrl}/install/x/install.ps1`,
    linuxScriptUrl: `${serverUrl}/install/x/install-linux-wsl.sh`,
  }),
);
console.log(`rendered into ${dir}`);
