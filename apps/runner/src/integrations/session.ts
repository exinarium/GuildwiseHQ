import type {
  IntegrationKindId,
  IntegrationPrompt,
  IntegrationSessionMsg,
  IntegrationSessionState,
  IntegrationStatus,
} from '@aom/shared';
import { redact, registerSecret, unregisterSecret } from '../secrets/redact.ts';
import type { LoginProcess, LoginSpawner } from './pty.ts';
import { cleanTerminal } from './terminal.ts';

/** What an adapter's matchers make of the output so far. */
export interface ParseResult {
  /** The prompt to show (URL, device code, paste label). */
  prompt?: IntegrationPrompt;
  /** The CLI waits for the user in their browser (`user`) or for a paste (`code`). */
  awaiting?: 'user' | 'code';
  /** The CLI re-asked after a paste: why, in a sentence for the page. */
  retry?: string;
  /** The login worked (a token was printed): do not wait for the process to end. */
  done?: boolean;
  /** The login failed; the sentence for the page. */
  failed?: string;
  /** Values the output holds that must be redacted from now on (a token). */
  secrets?: string[];
}

export interface Transcript {
  raw: string;
  text: string;
  /** Clean text printed after the last paste was written. */
  sinceInput: string;
  inputs: number;
}

export interface LoginSpec {
  cmd: string;
  args: string[];
  pty: boolean;
  env?: Record<string, string>;
  cwd?: string;
  parse(t: Transcript): ParseResult;
  /** What is written to stdin for a pasted value (without the final Enter). */
  stdin?(value: string): string;
  /** Called when the login ended: save the result and return the new status, or the reason it failed. */
  finish(r: {
    exitCode: number | null;
    transcript: Transcript;
    secrets: string[];
  }): Promise<IntegrationStatus | { error: string }>;
  /** Command line for "use the terminal" in a failure message. */
  terminalHint: string;
}

export const SESSION_LIMIT_MS = 10 * 60_000;
export const MAX_INPUTS = 3;

const isStatus = (r: IntegrationStatus | { error: string }): r is IntegrationStatus => 'kind' in r;

/**
 * One interactive sign-in (design D5). Spawns the CLI (in a pseudo-terminal when it needs one), turns what it prints into
 * a small state machine, takes up to three pasted values, and always ends: a limit of ten minutes, and an unknown output
 * ends in `failed` with "use the terminal", never a hang. Raw output never leaves this class: only the extracted prompt,
 * the state and one sentence.
 */
export class LoginSession {
  state: IntegrationSessionState = 'starting';
  private proc: LoginProcess | undefined;
  private prompt: IntegrationPrompt | undefined;
  private error: string | undefined;
  private status: IntegrationStatus | undefined;
  private inputs = 0;
  private inputOffset = 0;
  private secrets: string[] = [];
  private pasted: string[] = [];
  private settled = false;
  private finishing = false;
  private timer: NodeJS.Timeout | undefined;
  private lastEmit = '';
  readonly ended: Promise<void>;
  private endResolve!: () => void;

  constructor(
    readonly sessionId: string,
    readonly kind: IntegrationKindId,
    readonly instance: string,
    private readonly spec: LoginSpec,
    private readonly spawn: LoginSpawner,
    private readonly emit: (m: IntegrationSessionMsg) => void,
    private readonly opts: { limitMs?: number; settleMs?: number; pasteDelayMs?: number } = {},
  ) {
    this.ended = new Promise<void>((r) => {
      this.endResolve = r;
    });
  }

  get terminal(): boolean {
    return this.settled;
  }

  start(): void {
    this.send();
    try {
      this.proc = this.spawn({
        cmd: this.spec.cmd,
        args: this.spec.args,
        pty: this.spec.pty,
        ...(this.spec.env ? { env: this.spec.env } : {}),
        ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
        timeoutMs: (this.opts.limitMs ?? SESSION_LIMIT_MS) + 5000,
      });
    } catch {
      return void this.fail(`The sign-in could not start. Use the terminal: ${this.spec.terminalHint}`);
    }
    this.timer = setTimeout(
      () => this.end('expired', 'The sign-in took too long. Start it again.'),
      this.opts.limitMs ?? SESSION_LIMIT_MS,
    );
    this.timer.unref();
    this.proc.onOutput(() => this.onOutput());
    void this.proc.done.then((code) => void this.onExit(code));
    this.onOutput();
  }

  private transcript(): Transcript {
    const raw = this.proc?.output() ?? '';
    const text = cleanTerminal(raw);
    const sinceRaw = raw.slice(this.inputOffset);
    return { raw, text, sinceInput: this.inputs > 0 ? cleanTerminal(sinceRaw) : text, inputs: this.inputs };
  }

  private onOutput(): void {
    if (this.settled || this.finishing) return;
    const t = this.transcript();
    let r: ParseResult;
    try {
      r = this.spec.parse(t);
    } catch {
      r = {};
    }
    for (const s of r.secrets ?? [])
      if (!this.secrets.includes(s)) {
        this.secrets.push(s);
        registerSecret(s);
      }
    if (r.failed) return void this.fail(r.failed);
    if (r.done) return void this.finishAfter();
    if (r.prompt) this.prompt = r.prompt;
    if (this.state === 'completing') {
      if (r.retry) {
        this.error = r.retry;
        this.state = 'awaiting_code';
      }
    } else if (r.awaiting === 'code' && this.state !== 'awaiting_code') {
      this.state = 'awaiting_code';
    } else if (r.awaiting === 'user' && this.state === 'starting') {
      this.state = 'awaiting_user';
    }
    this.send();
  }

  /** The token was printed: give the process a moment to exit by itself, then finish. */
  private finishAfter(): void {
    this.finishing = true;
    this.state = 'completing';
    this.send();
    const settle = setTimeout(() => {
      this.proc?.kill();
    }, this.opts.settleMs ?? 3000);
    settle.unref();
    void this.proc?.done.then(() => clearTimeout(settle));
    void this.proc?.done.then((code) => void this.complete(code));
  }

  private async onExit(code: number): Promise<void> {
    if (this.settled || this.finishing) return;
    this.finishing = true;
    await this.complete(code);
  }

  private async complete(code: number | null): Promise<void> {
    if (this.settled) return;
    this.state = 'completing';
    const t = this.transcript();
    // the token may have been printed after the first look: parse once more
    let secrets = this.secrets;
    try {
      const again = this.spec.parse(this.transcript());
      secrets = [...new Set([...secrets, ...(again.secrets ?? [])])];
      if (again.failed && code !== 0) return void this.fail(again.failed);
    } catch {
      // keep what was found
    }
    try {
      const res = await this.spec.finish({ exitCode: code, transcript: t, secrets });
      if (isStatus(res)) {
        this.status = res;
        this.end('connected');
      } else this.fail(res.error);
    } catch (err) {
      this.fail(
        `The sign-in could not be completed (${err instanceof Error ? err.message.slice(0, 120) : 'error'}). Use the terminal: ${this.spec.terminalHint}`,
      );
    }
  }

  /** The user pasted a value. Returns a reason when it is not accepted now. */
  input(value: string): { accepted: true } | { accepted: false; reason: string } {
    if (this.settled || !this.proc) return { accepted: false, reason: 'This sign-in is no longer running.' };
    if (this.state !== 'awaiting_code')
      return { accepted: false, reason: 'This sign-in is not waiting for a value now.' };
    if (this.inputs >= MAX_INPUTS)
      return { accepted: false, reason: 'Too many attempts. Start the sign-in again.' };
    const v = value.trim();
    if (!v) return { accepted: false, reason: 'Nothing was pasted.' };
    this.inputs += 1;
    this.pasted.push(v);
    registerSecret(v);
    this.inputOffset = this.proc.output().length;
    this.error = undefined;
    this.state = 'completing';
    this.send();
    const stdin = this.spec.stdin ? this.spec.stdin(v) : v;
    this.proc.write(stdin);
    const p = this.proc;
    const enter = setTimeout(() => p.write('\r'), this.opts.pasteDelayMs ?? 400);
    enter.unref();
    return { accepted: true };
  }

  cancel(): void {
    if (this.settled) return;
    this.end('cancelled');
  }

  private fail(message: string): void {
    this.end('failed', message);
  }

  private end(state: 'connected' | 'failed' | 'cancelled' | 'expired', error?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.state = state;
    if (error) this.error = redact(error).slice(0, 300);
    if (this.timer) clearTimeout(this.timer);
    this.proc?.kill();
    for (const s of [...this.secrets, ...this.pasted]) unregisterSecret(s);
    this.send(true);
    this.endResolve();
  }

  private send(force = false): void {
    const msg: IntegrationSessionMsg = {
      sessionId: this.sessionId,
      kind: this.kind,
      instance: this.instance,
      state: this.state,
      ...(this.prompt ? { prompt: this.prompt } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
    const key = JSON.stringify(msg);
    if (!force && key === this.lastEmit) return;
    this.lastEmit = key;
    this.emit(msg);
  }
}
