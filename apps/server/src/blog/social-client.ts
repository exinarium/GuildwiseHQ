import type { SocialNetwork } from '@aom/shared';

/**
 * The only code that talks to Facebook and LinkedIn. Everything else (and every test) goes through the `SocialClient`
 * interface, so no test ever reaches a real network. The versions below are pinned on purpose (docs/design/blog-prd.md
 * section 12): review them every 6 to 12 months.
 */
export const GRAPH_VERSION = 'v21.0';
export const LINKEDIN_VERSION = '202509';

export type SocialErrorKind = 'auth' | 'retry' | 'final';
export class SocialError extends Error {
  constructor(
    readonly kind: SocialErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SocialError';
  }
}

export interface SharePayload {
  accountId: string;
  accessToken: string;
  /** The caption. */
  text: string;
  link: string;
  title: string;
  description: string;
  /** Absolute URL of the 1200x630 cover. */
  imageUrl: string;
}
export interface ShareResult {
  externalId: string;
  url: string | null;
}
export interface RefreshedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface SocialClient {
  post(network: SocialNetwork, p: SharePayload): Promise<ShareResult>;
  /** LinkedIn access tokens last about 60 days and are renewed with the refresh token. Null: this network has no refresh. */
  refresh(
    network: SocialNetwork,
    refreshToken: string,
    creds: { clientId?: string; clientSecret?: string },
  ): Promise<RefreshedToken | null>;
}

const classify = (status: number, body: string): SocialError => {
  const msg = `HTTP ${status}: ${body.slice(0, 300)}`;
  if (status === 401 || status === 403) return new SocialError('auth', msg);
  if (status === 429 || status >= 500) return new SocialError('retry', msg);
  return new SocialError('final', msg);
};

async function call(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (err) {
    throw new SocialError('retry', `network error: ${(err as Error).message}`);
  }
}

/** The real thing. Facebook: `POST /{page-id}/feed`. LinkedIn: image upload, then `POST /rest/posts` as the organization. */
export function createSocialClient(): SocialClient {
  return {
    async post(network, p) {
      if (network === 'facebook') {
        const r = await call(
          `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(p.accountId)}/feed`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ message: p.text, link: p.link, access_token: p.accessToken }),
          },
        );
        if (r.status >= 300) throw classify(r.status, r.body);
        const id = (JSON.parse(r.body) as { id?: string }).id;
        if (!id) throw new SocialError('final', 'no post id in the answer');
        return { externalId: id, url: `https://www.facebook.com/${id}` };
      }
      const headers = {
        authorization: `Bearer ${p.accessToken}`,
        'linkedin-version': LINKEDIN_VERSION,
        'x-restli-protocol-version': '2.0.0',
        'content-type': 'application/json',
      };
      const owner = `urn:li:organization:${p.accountId}`;
      // LinkedIn does not scrape the page: the thumbnail is uploaded through the Images API first.
      let thumbnail: string | undefined;
      try {
        const init = await call('https://api.linkedin.com/rest/images?action=initializeUpload', {
          method: 'POST',
          headers,
          body: JSON.stringify({ initializeUploadRequest: { owner } }),
        });
        if (init.status >= 300) throw classify(init.status, init.body);
        const v = (JSON.parse(init.body) as { value?: { uploadUrl?: string; image?: string } }).value;
        if (v?.uploadUrl && v.image) {
          const img = await fetch(p.imageUrl, { signal: AbortSignal.timeout(20_000) });
          if (img.ok) {
            const up = await call(v.uploadUrl, {
              method: 'PUT',
              headers: { authorization: `Bearer ${p.accessToken}` },
              body: Buffer.from(await img.arrayBuffer()),
            });
            if (up.status < 300) thumbnail = v.image;
          }
        }
      } catch (err) {
        if (err instanceof SocialError && err.kind === 'auth') throw err;
        // a missing thumbnail does not stop the post
      }
      const r = await call('https://api.linkedin.com/rest/posts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          author: owner,
          commentary: p.text,
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          content: {
            article: {
              source: p.link,
              title: p.title,
              description: p.description,
              ...(thumbnail ? { thumbnail } : {}),
            },
          },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
      });
      if (r.status >= 300) throw classify(r.status, r.body);
      const id = r.headers.get('x-restli-id') ?? '';
      if (!id) throw new SocialError('final', 'no post id in the answer');
      return { externalId: id, url: `https://www.linkedin.com/feed/update/${id}` };
    },

    async refresh(network, refreshToken, creds) {
      if (network !== 'linkedin' || !creds.clientId || !creds.clientSecret) return null;
      const r = await call('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      });
      if (r.status >= 300) throw classify(r.status, r.body);
      const j = JSON.parse(r.body) as { access_token: string; expires_in?: number; refresh_token?: string };
      return {
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? refreshToken,
        expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
      };
    },
  };
}
