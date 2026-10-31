import { describe, expect, it } from 'vitest';
import {
  DomainEventSchema,
  LocalTestServicesSchema,
  ProjectDtoSchema,
  SetTestServicesRequestSchema,
  testServiceDomain,
} from '../src/index.ts';

const svc = (over: Record<string, unknown> = {}) => ({
  name: 'postgres-test',
  host: '127.0.0.1',
  port: 5433,
  ...over,
});
const first = (list: unknown[]) => {
  const r = LocalTestServicesSchema.safeParse(list);
  return r.success ? null : r.error.issues[0]?.message;
};

describe('local test services (GWP-41)', () => {
  it('accepts the three loopback hosts and normalises [::1] and case', () => {
    const r = LocalTestServicesSchema.parse([
      svc(),
      svc({ name: 'a', host: '[::1]', port: 6379 }),
      svc({ name: 'b', host: ' LocalHost ', port: 8025 }),
    ]);
    expect(r.map((s) => s.host)).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it.each(['10.0.0.5', 'db.example.com', '0.0.0.0', '127.0.0.2', 'x.localhost', '', '::'])(
    'refuses host %s',
    (host) => {
      expect(first([svc({ host })])).toMatch(/only 127\.0\.0\.1, ::1 or localhost/);
    },
  );

  it.each([0, 65536, -1, 1.5, 'abc', '5433', null, 3128, 1080])('refuses port %s', (port) => {
    expect(first([svc({ port })])).toBeTruthy();
  });

  it('accepts the port bounds', () => {
    expect(first([svc({ port: 1 }), svc({ name: 'b', port: 65535 })])).toBeNull();
  });

  it('refuses duplicate names (any case) and duplicate ports, also across hosts', () => {
    expect(first([svc(), svc({ port: 1 })])).toBe('names must be unique');
    expect(first([svc(), svc({ name: 'POSTGRES-TEST', port: 1 })])).toBe('names must be unique');
    expect(first([svc(), svc({ name: 'other', host: 'localhost' })])).toBe('each port can be declared once');
  });

  it('refuses bad names and too many entries', () => {
    expect(first([svc({ name: '' })])).toBeTruthy();
    expect(first([svc({ name: 'has space' })])).toMatch(/letters, digits/);
    const many = Array.from({ length: 11 }, (_, i) => svc({ name: `s${i}`, port: 4000 + i }));
    expect(first(many)).toMatch(/at most 10/);
  });

  it('builds the exact port-qualified allowlist entry', () => {
    expect(testServiceDomain({ host: '127.0.0.1', port: 5433 })).toBe('127.0.0.1:5433');
    expect(testServiceDomain({ host: '::1', port: 6379 })).toBe('[::1]:6379');
    expect(testServiceDomain({ host: 'localhost', port: 8025 })).toBe('localhost:8025');
  });

  it('request, project dto and event carry the list', () => {
    expect(SetTestServicesRequestSchema.safeParse({ services: [svc()] }).success).toBe(true);
    expect(SetTestServicesRequestSchema.safeParse({ services: [svc({ host: '10.0.0.5' })] }).success).toBe(
      false,
    );
    expect(ProjectDtoSchema.shape.testServices.safeParse([svc()]).success).toBe(true);
    const id = '5b6d3c0e-9b0c-4d6e-8d2e-1f2a3b4c5d6e';
    expect(
      DomainEventSchema.safeParse({
        type: 'ProjectTestServicesSet',
        payload: { projectId: id, services: [svc()], by: id },
      }).success,
    ).toBe(true);
  });
});
