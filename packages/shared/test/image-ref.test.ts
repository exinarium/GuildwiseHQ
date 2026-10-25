import { describe, expect, it } from 'vitest';
import { imageNameOf, parseImageRef } from '../src/delivery/image-ref.ts';

describe('parseImageRef', () => {
  it('name', () => {
    expect(parseImageRef('app')).toEqual({ registry: '', name: 'app', tag: '', digest: '' });
  });
  it('name:tag', () => {
    expect(parseImageRef('app:1.2')).toEqual({ registry: '', name: 'app', tag: '1.2', digest: '' });
  });
  it('host:port/name:tag keeps the whole registry address (the P5 bug cut it to "192.168.1.11")', () => {
    expect(parseImageRef('192.168.1.11:5000/demo-server:showcase-cd30f7bb33')).toEqual({
      registry: '192.168.1.11:5000',
      name: 'demo-server',
      tag: 'showcase-cd30f7bb33',
      digest: '',
    });
    expect(imageNameOf('192.168.1.11:5000/demo-server:showcase-cd30f7bb33')).toBe(
      '192.168.1.11:5000/demo-server',
    );
  });
  it('host:port/name without a tag', () => {
    expect(parseImageRef('192.168.1.11:5000/demo-server')).toMatchObject({
      registry: '192.168.1.11:5000',
      name: 'demo-server',
      tag: '',
    });
  });
  it('host/ns/name', () => {
    expect(parseImageRef('ghcr.io/acme/api:v3')).toEqual({
      registry: 'ghcr.io',
      name: 'acme/api',
      tag: 'v3',
      digest: '',
    });
  });
  it('a namespace without a dot is not a registry', () => {
    expect(parseImageRef('acme/api:v3')).toEqual({ registry: '', name: 'acme/api', tag: 'v3', digest: '' });
  });
  it('digests, with and without a tag', () => {
    expect(parseImageRef('ghcr.io/acme/api@sha256:abcdef')).toEqual({
      registry: 'ghcr.io',
      name: 'acme/api',
      tag: '',
      digest: 'sha256:abcdef',
    });
    expect(parseImageRef('localhost:5000/x:1@sha256:abcdef')).toEqual({
      registry: 'localhost:5000',
      name: 'x',
      tag: '1',
      digest: 'sha256:abcdef',
    });
  });
  it('localhost:5000/x and localhost/x', () => {
    expect(parseImageRef('localhost:5000/x')).toEqual({
      registry: 'localhost:5000',
      name: 'x',
      tag: '',
      digest: '',
    });
    expect(parseImageRef('localhost/x:2')).toEqual({
      registry: 'localhost',
      name: 'x',
      tag: '2',
      digest: '',
    });
  });
});
