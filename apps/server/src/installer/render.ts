import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_NAME } from './brand.ts';

/**
 * The workstation installers.
 *
 * The scripts are real files under `templates/` (so they can be linted with shellcheck) and contain no placeholders:
 * a generated header assigns every per-install value from a safely quoted literal, and the fixed body only reads those
 * variables. Quoting is therefore done in exactly two functions, `shq` (bash) and `psq` (PowerShell).
 */

export type InstallerOs = 'linux' | 'macos' | 'windows';

export interface InstallerParams {
  /** The public origin of this server, without a trailing slash. */
  serverUrl: string;
  /** The one-time pairing code made for this install session. */
  pairingCode: string;
  /** The short-lived token in the script URLs; also authorises progress reports. */
  sessionToken: string;
  /** Suggested workstation name; empty: the script uses the machine's host name. */
  workstationName: string;
  /** The runner release the server serves; null when the server has none. */
  release: { version: string; sha256: string } | null;
  /** When the one-time code and the links stop working. */
  expiresAt: Date;
  generatedAt: Date;
  /** The user turned on expert mode: the installer then asks where the code lives (simple mode uses ~/src). */
  expertMode?: boolean;
}

/** Bash single-quoted literal: everything is literal inside, except the quote itself. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * PowerShell single-quoted literal: only the quote itself is special (doubled). Windows PowerShell 5.1 reads a script
 * without a byte order mark as the ANSI code page and treats the typographic quotes (U+2018, U+2019, U+201A, U+201B) as
 * quote characters, so any non-ASCII text (a name like "Pieter's laptop" typed with a smart quote) is emitted as
 * `[char]` code units: the generated script stays pure ASCII and survives every encoding.
 */
export const psq = (s: string): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: splitting on non-ASCII
  if (!/[^\u0000-\u007f]/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  const parts: string[] = [];
  let run = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) {
      run += s[i];
      continue;
    }
    if (run) parts.push(`'${run.replace(/'/g, "''")}'`);
    run = '';
    parts.push(`[char]${code}`);
  }
  if (run) parts.push(`'${run.replace(/'/g, "''")}'`);
  return `(${parts.join(' + ')})`;
};

/** Control characters never belong in a name; one line, at most 80 characters. */
export const cleanName = (s: string): string =>
  Array.from(s, (c) => {
    const n = c.charCodeAt(0);
    return n < 32 || n === 127 ? ' ' : c;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, 'templates'), join(here, 'installer-templates')]) {
    try {
      readFileSync(join(d, 'common.sh'));
      return d;
    } catch {
      // try the next layout (source tree, or the bundled dist/)
    }
  }
  throw new Error('installer templates not found');
}

const cache = new Map<string, string>();
const template = (name: string): string => {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(join(templatesDir(), name), 'utf8');
  cache.set(name, text);
  return text;
};

const banner = (os: string, p: InstallerParams, comment: string): string =>
  [
    `${comment} ${BRAND_NAME} workstation installer for ${os}.`,
    `${comment} Generated ${p.generatedAt.toISOString()}. Contains a one-time pairing code that expires ${p.expiresAt.toISOString()};`,
    `${comment} it contains no other secret. Read it before you run it: it only installs software for your own user,`,
    `${comment} asks for administrator rights just to install system packages, and reports its progress to ${p.serverUrl}.`,
  ].join('\n');

function bashHeader(os: string, p: InstallerParams): string {
  const rel = p.release;
  return `${[
    '#!/usr/bin/env bash',
    banner(os, p, '#'),
    'set -u -o pipefail',
    '',
    `APP_NAME=${shq(BRAND_NAME)}`,
    `SERVER_URL=${shq(p.serverUrl)}`,
    `PAIRING_CODE=${shq(p.pairingCode)}`,
    `SESSION_TOKEN=${shq(p.sessionToken)}`,
    `DEFAULT_NAME=${shq(cleanName(p.workstationName))}`,
    `RELEASE_VERSION=${shq(rel?.version ?? '')}`,
    `RELEASE_SHA256=${shq(rel?.sha256 ?? '')}`,
    `EXPERT_MODE=${p.expertMode ? '1' : '0'}`,
    'CURRENT_STEP=installer',
    'DOCTOR_FAILED=0',
    '',
  ].join('\n')}\n`;
}

/** The bash installer for Linux (also run inside WSL2 by the Windows script) or macOS. */
export function renderBash(os: 'linux' | 'macos', p: InstallerParams): string {
  return `${bashHeader(os === 'linux' ? 'Linux' : 'macOS', p)}${template('common.sh')}\n${template(os === 'linux' ? 'linux.sh' : 'macos.sh')}`;
}

export interface WindowsParams extends InstallerParams {
  /** URL of this very script (so it can save a copy of itself before a restart). */
  scriptUrl: string;
  /** URL of the Linux installer the script runs inside Ubuntu. */
  linuxScriptUrl: string;
}

export function renderPowerShell(p: WindowsParams): string {
  return `${[
    banner('Windows', p, '#'),
    `$AppName = ${psq(BRAND_NAME)}`,
    `$ServerUrl = ${psq(p.serverUrl)}`,
    `$SessionToken = ${psq(p.sessionToken)}`,
    `$ScriptUrl = ${psq(p.scriptUrl)}`,
    `$LinuxScriptUrl = ${psq(p.linuxScriptUrl)}`,
    `$DefaultName = ${psq(cleanName(p.workstationName))}`,
    '',
  ].join('\n')}\n${template('windows.ps1')}`.replace(/\r?\n/g, '\r\n');
}

const WINDOWS_TLS12 = '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12';

/** What the wizard shows for "copy one command" per system. The URL carries the short-lived token. */
export function oneLiner(os: InstallerOs, scriptUrl: string): string {
  // Windows PowerShell 5.1 on older builds offers only TLS 1.0/1.1 by default, which the server refuses: ask for TLS 1.2 first.
  if (os === 'windows') return `${WINDOWS_TLS12}; irm ${psq(scriptUrl)} | iex`;
  return `curl -fsSL ${shq(scriptUrl)} | bash`;
}

export const scriptFileName = (os: InstallerOs): string =>
  os === 'windows'
    ? 'install-guildwise-hq.ps1'
    : os === 'macos'
      ? 'install-guildwise-hq-mac.sh'
      : 'install-guildwise-hq.sh';
