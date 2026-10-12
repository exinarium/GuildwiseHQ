import { createReadStream } from 'node:fs';
import {
  CreateInstallerRequestSchema,
  IdParamsSchema,
  InstallerProgressRequestSchema,
  InstallerSessionSchema,
  InstallerStatusSchema,
  RunnerReleaseResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import {
  createInstallerSession,
  installerScript,
  installerStatus,
  recordInstallerProgress,
  type ScriptKind,
} from '../commands/installer.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import {
  findRelease,
  latestRelease,
  RELEASE_VERSION_PATTERN,
  runnerUpdatesPaused,
} from '../installer/release.ts';
import { typed } from './util.ts';

const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const FILES: Record<string, ScriptKind> = {
  'install.sh': 'linux',
  'install-linux-wsl.sh': 'linux',
  'install-mac.sh': 'macos',
  'install.ps1': 'windows',
};

/**
 * The runner installer (docs/design/open-questions.md "Runner installer with a guided setup"):
 *  - the wizard's own routes (signed in): create a session, follow its progress;
 *  - `/install/:token/*` (unauthenticated, the short-lived token is the credential): the generated scripts and the
 *    progress reports the scripts send;
 *  - `/api/runner/release*` (unauthenticated: the runner release is not a secret): the tarball and its checksum.
 */
export function installerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.post(
      '/api/workstations/installers',
      {
        schema: { body: CreateInstallerRequestSchema },
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(201);
        return InstallerSessionSchema.parse(await createInstallerSession(ctx, s.user, req.body));
      },
    );

    app.get('/api/workstations/installers/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return InstallerStatusSchema.parse(await installerStatus(ctx, s.user.id, req.params.id));
    });

    app.get(
      '/install/:token/:file',
      {
        schema: {
          params: TokenParams.extend({ file: z.string() }),
          querystring: z.object({ download: z.string().optional() }),
        },
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const kind = FILES[req.params.file];
        if (!kind) throw notFound();
        const script = await installerScript(ctx, req.params.token, kind);
        if (!script)
          throw notFound('this install link has expired; create a new one on the Workstations page');
        reply
          .header(
            'content-type',
            `${kind === 'windows' ? 'text/plain' : 'text/x-shellscript'}; charset=utf-8`,
          )
          .header('cache-control', 'no-store');
        if (req.query.download)
          reply.header('content-disposition', `attachment; filename="${script.fileName}"`);
        return script.text;
      },
    );

    app.post(
      '/install/:token/progress',
      {
        schema: { params: TokenParams, body: InstallerProgressRequestSchema },
        config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      },
      async (req) => {
        if (!(await recordInstallerProgress(ctx, req.params.token, req.body))) throw notFound();
        return { ok: true };
      },
    );

    app.get('/api/runner/release', async () => {
      const r = await latestRelease(ctx.config);
      if (!r) throw notFound('this server has no runner release', 'no_release');
      return RunnerReleaseResponseSchema.parse({
        version: r.version,
        sha256: r.sha256,
        size: r.size,
        // One portable archive for every platform and architecture (the installer unpacks the same file everywhere).
        url: `${ctx.config.publicOrigin}/api/runner/release/aom-runner-${r.version}.tgz`,
        autoUpdatePaused: await runnerUpdatesPaused(ctx.pool),
      });
    });

    app.get(
      '/api/runner/release/:file',
      { schema: { params: z.object({ file: z.string().max(80) }) } },
      async (req, reply) => {
        const m = /^aom-runner-(.+?)\.tgz(\.sha256)?$/.exec(req.params.file);
        if (!m?.[1] || !RELEASE_VERSION_PATTERN.test(m[1])) throw notFound();
        const r = await findRelease(ctx.config, m[1]);
        if (!r) throw notFound('no such runner release', 'no_release');
        if (m[2]) {
          return reply.type('text/plain; charset=utf-8').send(`${r.sha256}  aom-runner-${r.version}.tgz\n`);
        }
        return reply
          .type('application/gzip')
          .header('content-length', r.size)
          .header('content-disposition', `attachment; filename="aom-runner-${r.version}.tgz"`)
          .send(createReadStream(r.file));
      },
    );
  };
}
