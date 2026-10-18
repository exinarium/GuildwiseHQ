import { describe, expect, it } from 'vitest';
import { oauth1Header, oauth1Params, oauth1Signature, percentEncode } from '../src/blog/oauth1.ts';

// The worked example of Twitter's "Creating a signature" documentation.
const vector = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: '1318622958',
  params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true' },
};

describe('oauth1', () => {
  it('encodes per RFC 3986', () => {
    expect(percentEncode("a b!'()*~-._+/")).toBe('a%20b%21%27%28%29%2A~-._%2B%2F');
  });

  it('signs the documented example', () => {
    const oauth = oauth1Params(vector);
    expect(oauth1Signature(vector, oauth)).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  it('builds an Authorization header with the signature and no secrets', () => {
    const h = oauth1Header({ ...vector, params: undefined });
    expect(h).toMatch(/^OAuth /);
    expect(h).toContain('oauth_signature="');
    expect(h).toContain(`oauth_consumer_key="${vector.consumerKey}"`);
    expect(h).not.toContain(vector.consumerSecret);
    expect(h).not.toContain(vector.tokenSecret);
  });
});
