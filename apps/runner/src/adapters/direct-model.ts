import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chatToolsFor,
  DIRECT_RUNTIME,
  directProvider,
  type SessionToolDef,
  sessionToolsFor,
  splitDirectModel,
  type Usage,
} from '@aom/shared';
import { isStepCount, streamText, type ToolSet } from 'ai';
import { withPromptCaching } from '../direct/cache.ts';
import { guardedFetch, type Resolver } from '../direct/guarded-fetch.ts';
import { ChatHistory } from '../direct/history.ts';
import { defaultModelFactory, type FetchLike, type ModelFactory, ModelLister } from '../direct/models.ts';
import type { ProviderStore } from '../direct/store.ts';
import { buildToolSet, summarizeCall } from '../direct/tools.ts';
import type { Logger } from '../log.ts';
import { nullLogger } from '../log.ts';
import { redact } from '../secrets/redact.ts';
import type {
  ChatStartInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

/** Version reported for the runtime: the pinned AI SDK (kept in step with package.json by a test). */
export const DIRECT_MODEL_VERSION = 'ai-sdk-7.0.150';

export interface DirectModelOptions {
  /** The most model calls (steps) one turn may make: each tool round trip is a step. */
  maxSteps: number;
  /** The whole turn, tool calls included. */
  turnTimeoutMs: number;
  /** The most tokens one model call may write. */
  maxOutputTokens: number;
  /** Days a plain chat's text is kept on this workstation; 0 keeps it forever. */
  chatRetentionDays: number;
}

export const DIRECT_MODEL_DEFAULTS: DirectModelOptions = {
  maxSteps: 12,
  turnTimeoutMs: 5 * 60_000,
  maxOutputTokens: 8_000,
  chatRetentionDays: 90,
};

/** A queue the stream's consumer reads as an async iterable and the producer pushes into. */
class EventQueue {
  private items: RuntimeEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(ev: RuntimeEvent): void {
    if (this.closed) return;
    this.items.push(ev);
    this.waiter?.();
  }
  close(): void {
    this.closed = true;
    this.waiter?.();
  }
  async *iterate(): AsyncIterable<RuntimeEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

/** A short text for the owner that tells what went wrong without the provider's raw body or any key. */
export function describeProviderError(provider: string, err: unknown): string {
  const label = directProvider(provider)?.label ?? provider;
  const e = err as { statusCode?: number; status?: number; message?: string; name?: string } | undefined;
  const status = e?.statusCode ?? e?.status;
  if (status === 401 || status === 403)
    return `${label} refused the API key (HTTP ${status}). Check the key under Workstations > Model providers.`;
  if (status === 404)
    return `${label} does not know this model (HTTP 404). Pick another model or check the endpoint.`;
  if (status === 429)
    return `${label} is rate limiting this key or its quota is used up (HTTP 429). Try again later.`;
  if (status && status >= 500) return `${label} had a server error (HTTP ${status}). Try again.`;
  const text = redact(e?.message ?? String(err))
    .replace(/\s+/g, ' ')
    .trim();
  return `${label}: ${text.slice(0, 300) || 'the call failed'}`;
}

/**
 * The direct-model runtime (docs/ARCHITECTURE.md section 38.3): one call to a provider's API per turn with the Vercel AI SDK, run
 * inside the runner. It has no shell, no edit tool and no files; it speaks in session turns (facilitator, CEO proposals, boardroom
 * personas, the Chair, the minutes) and in plain chats. What it can do besides talk is exactly the typed tools of the turn's purpose
 * (`sessionToolsFor`): each is an `aom` verb sent over the runner's IPC with the turn's token, so the same handler and the same
 * server-side permission table that govern the Claude Code path govern this one. Provider keys come from the `ProviderStore`
 * (sealed in the browser, kept 0600 on this machine) and are registered with the redaction registry.
 */
export class DirectModelAdapter implements RuntimeAdapter {
  readonly id = DIRECT_RUNTIME;
  readonly instructionStyle = 'tools' as const;
  private readonly lister: ModelLister;
  private readonly history: ChatHistory;
  private readonly factory: ModelFactory;
  private readonly opts: DirectModelOptions;
  private readonly log: Logger;

  constructor(
    private readonly deps: {
      store: ProviderStore;
      /** `<data dir>`: chat memory lives in `<root>/direct-chats`. */
      root: string;
      lister?: ModelLister;
      modelFactory?: ModelFactory;
      /** The HTTP the providers' SDKs use (tests point it at a local server). */
      fetch?: FetchLike;
      /** Test hook: resolves the name of an OpenAI-compatible endpoint (default: DNS). */
      resolve?: Resolver;
      options?: Partial<DirectModelOptions>;
      /** The model list of an OpenAI-compatible endpoint changed after it was fetched: report the runtimes again. */
      onModelsChanged?: () => void;
      log?: Logger;
    },
  ) {
    this.lister = deps.lister ?? new ModelLister({ fetch: this.endpointFetch() });
    this.history = new ChatHistory(join(deps.root, 'direct-chats'));
    this.factory = deps.modelFactory ?? defaultModelFactory;
    this.opts = { ...DIRECT_MODEL_DEFAULTS, ...deps.options };
    this.log = deps.log ?? nullLogger;
    this.startPruning();
    // A changed provider forgets what it listed.
    deps.store.onChange(() => this.lister.invalidate());
  }

  /** Deletes chat memory older than the retention period: now, and every six hours while the runner lives. */
  pruneHistory(now: number = Date.now()): number {
    if (this.opts.chatRetentionDays <= 0) return 0;
    try {
      const n = this.history.prune(this.opts.chatRetentionDays * 86_400_000, now);
      if (n) this.log.info(`direct chats: removed ${n} older than ${this.opts.chatRetentionDays} days`);
      return n;
    } catch (err) {
      this.log.warn(`direct chat pruning failed: ${redact(String(err))}`);
      return 0;
    }
  }

  private startPruning(): void {
    this.pruneHistory();
    const t = setInterval(() => this.pruneHistory(), 6 * 3_600_000);
    t.unref?.();
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const listed: Record<string, string[]> = {};
    const problems: Record<string, string> = {};
    for (const cfg of this.deps.store.configured()) {
      if (cfg.id !== 'openai-compatible') continue;
      // Never wait for the endpoint here (an offline Ollama must not delay the hello): report what is cached and refresh in the
      // background; a changed list is reported again through `onModelsChanged`.
      const hit = this.lister.peek(cfg.id);
      listed[cfg.id] = hit.ids;
      if (hit.problem) problems[cfg.id] = hit.problem;
      if (!hit.fresh)
        void this.lister.refresh(cfg, true).then((r) => {
          if (JSON.stringify([r.ids, r.problem]) !== JSON.stringify([hit.ids, hit.problem]))
            this.deps.onModelsChanged?.();
        });
    }
    const providers = this.deps.store.report(listed, problems);
    return {
      runtime: this.id,
      version: DIRECT_MODEL_VERSION,
      available: providers.length > 0,
      // No 'shell', no 'edit', no 'web': this runtime cannot take part in card or shift work.
      capabilities: ['skills', 'resume'],
      providers,
      keys: this.deps.store.reportKeys(),
      privateEndpoints: this.deps.store.endpoints(),
    };
  }

  /**
   * The HTTP for an OpenAI-compatible endpoint (and its model list): the name of the base URL is resolved and judged against the
   * private-endpoint rules, and the connection goes to a judged address (R3c). The hosted providers need no such check.
   */
  private endpointFetch(orgId?: string): FetchLike {
    // a test that points the HTTP at its own fake keeps it, unless it also supplies a resolver to exercise the check
    if (this.deps.fetch && !this.deps.resolve) return this.deps.fetch;
    return guardedFetch({
      entries: () => this.deps.store.endpoints(),
      // an organization's endpoint is judged without the loopback exemption
      isOrgUrl: (url) => {
        const c = this.deps.store.get('openai-compatible', orgId);
        return c?.source === 'org' && !!c.baseUrl && url.startsWith(c.baseUrl);
      },
      ...(this.deps.resolve ? { resolve: this.deps.resolve } : {}),
      ...(this.deps.fetch ? { inner: this.deps.fetch } : {}),
    });
  }

  /** The instructions travel with `startChat` (`instructions`); the file is a copy for the owner to read, not an input. */
  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'AGENTS.md'), markdown);
  }

  async start(_input: ShiftStartInput): Promise<RuntimeSession> {
    throw new Error('the direct-model runtime has no shell or edit tools: it cannot work cards');
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    const q = new EventQueue();
    const ac = new AbortController();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let lastActivity = Date.now();
    let stopReason: string | undefined;

    const session: RuntimeSession = {
      events: () => q.iterate(),
      stop: async (reason) => {
        stopReason ??= reason;
        ac.abort();
      },
      usage: () => usage,
      lastActivityAt: () => lastActivity,
    };
    const fail = (error: string): void => {
      q.push({ kind: 'exit', code: 1, error });
      q.close();
    };

    const choice = splitDirectModel(input.agent.model);
    if (!choice) {
      fail(`"${input.agent.model}" is not a direct-model id (provider:model)`);
      return session;
    }
    const cfg = this.deps.store.get(choice.provider, input.orgId);
    if (!cfg) {
      fail(
        `${directProvider(choice.provider)?.label ?? choice.provider} is not set up on this workstation: add its key under Workstations > Model providers`,
      );
      return session;
    }
    let model: ReturnType<ModelFactory>;
    try {
      model = this.factory(
        input.agent.model,
        cfg,
        choice.provider === 'openai-compatible' ? this.endpointFetch(input.orgId) : this.deps.fetch,
      );
    } catch (err) {
      fail(describeProviderError(choice.provider, err));
      return session;
    }

    const tools: SessionToolDef[] = input.sessionTurn
      ? sessionToolsFor(input.sessionTurn.purpose, { delegate: input.delegate === true })
      : chatToolsFor({ playbook: !!input.playbookGrants?.length, delegate: input.delegate === true });
    const ipcUrl = input.env.AOM_IPC_URL;
    const ipcToken = input.env.AOM_SHIFT_TOKEN;
    const toolSet: ToolSet =
      ipcUrl && ipcToken && tools.length
        ? buildToolSet(tools, { url: ipcUrl, token: ipcToken }, ac.signal)
        : {};

    // A plain chat remembers its earlier messages (the runtime session id names the file); a session turn carries its history.
    const prior = input.sessionTurn ? [] : this.history.load(input.resumeSessionId);
    const chatId = input.sessionTurn
      ? undefined
      : input.resumeSessionId && prior.length
        ? input.resumeSessionId
        : this.history.newId();
    const messages = [...prior, { role: 'user' as const, content: input.message }];

    const cached = withPromptCaching(choice.provider, input.instructions ?? '', messages, prior.length);

    const timeout = setTimeout(() => {
      stopReason ??= `timed out after ${Math.round(this.opts.turnTimeoutMs / 60_000)} minutes`;
      ac.abort();
    }, this.opts.turnTimeoutMs);
    timeout.unref?.();

    void (async () => {
      let allText = '';
      let stepText = '';
      let lastStepText = '';
      let blocks = 0;
      let totalUsage: Awaited<ReturnType<typeof streamText>['totalUsage']> | undefined;
      let failure: string | undefined;
      try {
        const result = streamText({
          model,
          system: cached.system,
          messages: cached.messages,
          tools: toolSet,
          stopWhen: isStepCount(Math.min(input.maxSteps ?? this.opts.maxSteps, this.opts.maxSteps)),
          abortSignal: ac.signal,
          maxOutputTokens: this.opts.maxOutputTokens,
          maxRetries: 2,
          providerOptions: {
            ...cached.providerOptions,
            openai: { strictJsonSchema: false, ...cached.providerOptions.openai },
          },
          onError: () => {
            // reported by the `error` part below
          },
        });
        for await (const part of result.fullStream) {
          lastActivity = Date.now();
          switch (part.type) {
            case 'start-step':
              stepText = '';
              break;
            case 'text-start':
              if (blocks++ > 0) q.push({ kind: 'textstart' });
              break;
            case 'text-delta':
              allText += part.text;
              stepText += part.text;
              q.push({ kind: 'delta', text: part.text });
              break;
            case 'reasoning-start':
              q.push({ kind: 'thinking' });
              break;
            case 'tool-call':
              q.push({
                kind: 'tool',
                name: part.toolName,
                summary: summarizeCall(part.toolName, part.input),
                id: part.toolCallId,
              });
              break;
            case 'tool-result':
              q.push({
                kind: 'toolresult',
                id: part.toolCallId,
                bytes: Buffer.byteLength(
                  typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? ''),
                ),
              });
              break;
            case 'tool-error': {
              const err = part.error as { refused?: boolean; message?: string } | undefined;
              q.push({
                kind: 'toolresult',
                id: part.toolCallId,
                bytes: Buffer.byteLength(err?.message ?? ''),
                isError: true,
                ...(err?.refused ? { refused: true } : {}),
              });
              break;
            }
            case 'finish-step':
              lastStepText = stepText;
              break;
            case 'error':
              failure ??= describeProviderError(choice.provider, part.error);
              break;
            case 'abort':
              failure ??= stopReason ?? 'cancelled';
              break;
            case 'finish':
              totalUsage = part.totalUsage;
              break;
            default:
              break;
          }
        }
      } catch (err) {
        failure ??= stopReason ?? describeProviderError(choice.provider, err);
      } finally {
        clearTimeout(timeout);
      }
      if (ac.signal.aborted && stopReason) failure = stopReason;
      if (totalUsage) {
        const d = totalUsage.inputTokenDetails;
        usage = {
          inputTokens:
            d.noCacheTokens ??
            Math.max(0, (totalUsage.inputTokens ?? 0) - (d.cacheReadTokens ?? 0) - (d.cacheWriteTokens ?? 0)),
          outputTokens: totalUsage.outputTokens ?? 0,
          cacheReadTokens: d.cacheReadTokens ?? 0,
          cacheWriteTokens: d.cacheWriteTokens ?? 0,
          // `provider:model` is what the cost tables key on (an unlisted model is flagged "cost unknown", never priced at zero).
          model: input.agent.model,
        };
      } else {
        usage = { ...usage, model: input.agent.model };
      }
      // Whose key paid: the server counts the organization's against its monthly cap and leaves the workstation's own out.
      usage = { ...usage, keySource: cfg.source ?? 'workstation', keyProvider: choice.provider };
      q.push({ kind: 'usage', usage });
      if (failure) {
        q.push({ kind: 'exit', code: 1, error: failure });
      } else {
        const reply = (lastStepText.trim() || allText.trim()).trim();
        if (chatId) {
          try {
            this.history.save(chatId, [...messages, { role: 'assistant', content: reply || allText }]);
          } catch (err) {
            this.log.warn(`direct chat memory not saved: ${redact(String(err))}`);
          }
          q.push({ kind: 'session', runtimeSessionId: chatId });
        }
        q.push({ kind: 'final', text: reply });
        q.push({ kind: 'exit', code: 0 });
      }
      q.close();
    })();

    return session;
  }
}
