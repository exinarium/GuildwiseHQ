import { z } from 'zod';
import { RESERVED_RUN_PORTS } from '../runs/types.ts';

/**
 * Local test services of a project (GWP-41): a database or other service that runs on the workstation and that the
 * project's build, review and test shifts may reach from their sandbox. Only these loopback hosts are accepted, and
 * only the exact declared port is ever opened. Credentials are not part of the setting: the test configuration keeps them.
 */
export const TEST_SERVICE_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type TestServiceHost = (typeof TEST_SERVICE_HOSTS)[number];
export const MAX_TEST_SERVICES = 10;

const PORT_MESSAGE = 'the port must be a whole number from 1 to 65535';

/** Trim and lower-case; `[::1]` is accepted as `::1`. Anything else is left for the host check to refuse. */
export function normaliseTestServiceHost(raw: string): string {
  const h = raw.trim().toLowerCase();
  return h === '[::1]' ? '::1' : h;
}

export function isTestServiceHost(host: string): host is TestServiceHost {
  return (TEST_SERVICE_HOSTS as readonly string[]).includes(host);
}

export const LocalTestServiceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'give the service a name')
    .max(40, 'the name can have at most 40 characters')
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'the name can have letters, digits, dot, dash and underscore only',
    ),
  host: z
    .string()
    .transform(normaliseTestServiceHost)
    .refine(
      isTestServiceHost,
      'only 127.0.0.1, ::1 or localhost: a test service must run on this workstation',
    ),
  port: z
    .number({ error: PORT_MESSAGE })
    .int(PORT_MESSAGE)
    .min(1, PORT_MESSAGE)
    .max(65535, PORT_MESSAGE)
    .refine((p) => !RESERVED_RUN_PORTS.includes(p), 'ports 3128 and 1080 are used by the sandbox proxy'),
});
export type LocalTestService = z.infer<typeof LocalTestServiceSchema>;

export const LocalTestServicesSchema = z
  .array(LocalTestServiceSchema)
  .max(MAX_TEST_SERVICES, `at most ${MAX_TEST_SERVICES} test services`)
  .superRefine((list, ctx) => {
    const names = new Set<string>();
    const ports = new Set<number>();
    list.forEach((s, i) => {
      const key = s.name.toLowerCase();
      if (names.has(key))
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: 'names must be unique' });
      names.add(key);
      // Inside the sandbox each declared port is bound on one loopback, so a port can be declared once.
      if (ports.has(s.port))
        ctx.addIssue({ code: 'custom', path: [i, 'port'], message: 'each port can be declared once' });
      ports.add(s.port);
    });
  });

/** `PUT /api/projects/:id/test-services` (project Owner, organization Owner and Admins): the whole list. */
export const SetTestServicesRequestSchema = z.object({ services: LocalTestServicesSchema });
export type SetTestServicesRequest = z.infer<typeof SetTestServicesRequestSchema>;

/** The exact sandbox allowlist entry for a service: `127.0.0.1:5433`, `[::1]:5433`, `localhost:5433`. Never a bare host. */
export function testServiceDomain(s: Pick<LocalTestService, 'host' | 'port'>): string {
  return s.host.includes(':') ? `[${s.host}]:${s.port}` : `${s.host}:${s.port}`;
}
