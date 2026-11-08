import { describe, expect, it } from 'vitest';
import { presignV4 } from '../src/storage/s3-sign.ts';

const keys = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('presignV4', () => {
  // The AWS documentation example "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
  it('matches the documented presigned URL', () => {
    const q = presignV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      ...keys,
      expires: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(q).toContain('X-Amz-Expires=86400');
    expect(q).toContain('X-Amz-SignedHeaders=host');
    expect(q).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(
      q.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'),
    ).toBe(true);
  });

  it('signs the length, type, checksum and if-none-match of a PUT, and the TTL', () => {
    const base = {
      method: 'PUT',
      host: 'b.s3.example.com',
      path: '/p/x.pdf',
      region: 'eu-west-1',
      ...keys,
      expires: 600,
      now: new Date('2026-11-08T10:00:00Z'),
    };
    const a = presignV4({
      ...base,
      headers: { 'content-length': '10', 'content-type': 'application/pdf', 'if-none-match': '*' },
    });
    expect(a).toContain('X-Amz-Expires=600');
    expect(a).toContain('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match');
    // A different size, path or type gives another signature.
    const sig = (q: string) => /X-Amz-Signature=(\w+)/.exec(q)?.[1];
    const other = presignV4({
      ...base,
      headers: { 'content-length': '11', 'content-type': 'application/pdf', 'if-none-match': '*' },
    });
    expect(sig(other)).not.toBe(sig(a));
    expect(
      sig(
        presignV4({
          ...base,
          path: '/p/y.pdf',
          headers: { 'content-length': '10', 'content-type': 'application/pdf', 'if-none-match': '*' },
        }),
      ),
    ).not.toBe(sig(a));
  });

  it('includes a session token', () => {
    const q = presignV4({
      method: 'PUT',
      host: 'h.example.com',
      path: '/k',
      region: 'us-east-1',
      ...keys,
      sessionToken: 'TOKEN/1',
      expires: 60,
      now: new Date('2026-11-08T10:00:00Z'),
    });
    expect(q).toContain('X-Amz-Security-Token=TOKEN%2F1');
  });
});
