import { type RunnerPairResponse, RunnerPairResponseSchema } from '@aom/shared';
import { loadConfig } from './config.ts';
import {
  type AddPairingResult,
  addPairing,
  entryConfigPath,
  loadIndex,
  normalizeServerUrl,
  type PairingEntry,
} from './pairings.ts';

/**
 * `guildwise-runner pair` against the server (UAT 1.10.0 finding 5). A machine already paired with this server proves its
 * current workstation (id and runner token) so a fresh link from the same account re-links that SAME workstation: its
 * agents, DevOps engineer, switches and the local DevOps grant stay. When the server refuses the re-link (the link is
 * from another account, or the old workstation is gone) nothing is changed here and `RelinkRefusedError` says what a new
 * workstation would mean; only `newWorkstation` (the person's explicit yes) pairs as a new one.
 */
export class RelinkRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: 'other_account' | 'gone' | string,
    readonly workstationName?: string,
  ) {
    super(message);
    this.name = 'RelinkRefusedError';
  }
}

/** What a new workstation means, in the words the installer and the CLI show before asking. */
export const NEW_WORKSTATION_CONSEQUENCES =
  "A NEW workstation is created: it gets its own new DevOps engineer with every DevOps switch off, and this computer's DevOps grant has to be given again. The old workstation stops working on this computer; when you unlink it on the Workstations page its DevOps engineer is retired.";

export interface PairInput {
  root: string;
  server: string;
  code: string;
  name: string;
  body: Record<string, unknown>;
  mock?: boolean;
  newWorkstation?: boolean;
  fetch?: typeof fetch;
}

export interface PairOutput {
  paired: RunnerPairResponse;
  added: AddPairingResult;
  /** The pairing whose workstation the request proved (absent: a first pairing with this server). */
  previous?: PairingEntry;
}

/** The pairing of this server a re-run belongs to: the one with this name, else the only one for this server. */
export function previousPairing(root: string, server: string, name: string): PairingEntry | undefined {
  const url = normalizeServerUrl(server);
  const mine = loadIndex(root).pairings.filter((p) => p.serverUrl === url);
  return mine.find((p) => p.label === name) ?? (mine.length === 1 ? mine[0] : undefined);
}

export async function pairWithServer(input: PairInput): Promise<PairOutput> {
  const prev = previousPairing(input.root, input.server, input.name);
  let previous: { workstationId: string; runnerToken: string } | undefined;
  if (prev && !prev.disabled) {
    try {
      const c = loadConfig(entryConfigPath(input.root, prev));
      if (c.runnerToken) previous = { workstationId: c.workstationId, runnerToken: c.runnerToken };
    } catch {
      // an unreadable config proves nothing: this pairs as new (the server asks nothing then)
    }
  }
  const res = await (input.fetch ?? fetch)(new URL('/api/runner/pair', input.server).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...input.body,
      ...(previous ? { previous } : {}),
      ...(input.newWorkstation ? { newWorkstation: true } : {}),
    }),
  });
  const text = await res.text();
  if (res.status === 409) {
    let err: { code?: string; message?: string; details?: { reason?: string; workstationName?: string } } =
      {};
    try {
      err = (JSON.parse(text) as { error?: typeof err }).error ?? {};
    } catch {
      // not JSON: reported below as a plain failure
    }
    if (err.code === 'relink_refused')
      throw new RelinkRefusedError(
        err.message ?? "the server did not re-link this computer's workstation",
        err.details?.reason ?? 'unknown',
        err.details?.workstationName,
      );
  }
  if (!res.ok) throw new Error(`pairing failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const paired = RunnerPairResponseSchema.parse(JSON.parse(text));
  // a re-link keeps the existing pairing entry (and with it every bit of local state); anything else is a new one
  const label = paired.relinked && prev ? prev.label : input.name;
  const added = addPairing(input.root, {
    serverUrl: input.server,
    label,
    workstationId: paired.workstationId,
    runnerToken: paired.runnerToken,
    mock: !!input.mock,
  });
  return { paired, added, ...(prev ? { previous: prev } : {}) };
}
