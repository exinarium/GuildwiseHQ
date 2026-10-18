import type { BlogContent, SocialNetwork } from '@aom/shared';
import type { SharePayload, SocialClient } from '../../src/blog/social-client.ts';
import { SocialError } from '../../src/blog/social-client.ts';
import type { Mailer, MailMessage } from '../../src/mail/mailer.ts';
import type { TestApp } from './app.ts';

const PARA =
  'AI agents work best when each one has a narrow job, a clear definition of done and a person who can see what they are doing. ';

/** A valid post (the body is long enough for the 4,000 character minimum). */
export function blogContent(slug: string, over: Partial<BlogContent> = {}): BlogContent {
  return {
    slug,
    title: `How teams use agents well: ${slug}`,
    summary:
      'A practical look at how small teams give AI agents narrow jobs, review their work and keep a person in charge of the result.',
    bodyMarkdown: `## Why it matters\n\n${PARA.repeat(12)}\n\n## What to do\n\n- Give each agent one job\n- Review the output\n\n${PARA.repeat(12)}\n\n[Docs](https://example.com/docs)`,
    coverImage: { defaultKey: 'ai-agents', alt: 'Abstract agents at work' },
    tags: ['ai-agents'],
    sources: [{ title: 'Docs', url: 'https://example.com/docs' }],
    seo: {},
    social: {
      facebookText: 'New on the blog',
      linkedinText: 'New on the blog: agents',
      xText: 'New on the blog: agents #AI',
      blueskyText: 'New on the blog: agents',
    },
    aiDisclosure: { model: 'test-model', agentName: 'Writer' },
    ...over,
  };
}

/** A mailer that keeps what it is asked to send. */
export class CaptureMailer implements Mailer {
  sent: MailMessage[] = [];
  failFor = new Set<string>();
  async send(msg: MailMessage): Promise<void> {
    if (this.failFor.has(msg.to)) throw new Error('smtp down');
    this.sent.push(msg);
  }
  close(): void {}
  to(addr: string) {
    return this.sent.filter((m) => m.to === addr);
  }
}

/** A social client that never touches a network. `script` decides the answer per call. */
export class FakeSocial implements SocialClient {
  calls: Array<{ network: SocialNetwork; p: SharePayload }> = [];
  script: Array<'ok' | 'retry' | 'auth' | 'final'> = [];
  refreshed = 0;
  async post(network: SocialNetwork, p: SharePayload) {
    this.calls.push({ network, p });
    const r = this.script.shift() ?? 'ok';
    if (r === 'retry') throw new SocialError('retry', 'HTTP 503');
    if (r === 'auth') throw new SocialError('auth', 'HTTP 401 token expired');
    if (r === 'final') throw new SocialError('final', 'HTTP 400 bad request');
    return {
      externalId: `${network}-${this.calls.length}`,
      url: `https://social.test/${network}/${this.calls.length}`,
    };
  }
  async refresh() {
    this.refreshed++;
    return null;
  }
}

/** Creates an API key through the platform route; returns the secret. */
export async function makeKey(
  t: TestApp,
  cookie: string,
  scopes: string[] = ['blog:write'],
  extra: Record<string, unknown> = {},
): Promise<{ id: string; secret: string }> {
  const r = await t.req('POST', '/api/platform/api-keys', {
    cookie,
    body: { name: 'writer', scopes, ...extra },
  });
  if (r.status !== 201) throw new Error(`key create failed ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id, secret: r.body.secret };
}

export const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
