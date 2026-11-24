import { createReadStream } from 'node:fs';
import {
  CreateInstallerRequestSchema,
  IdParamsSchema,
  InstallerProgressRequestSchema,
  InstallerSessionSchema,
  InstallerStatusSchema,
  REINSTALL_REQUIRED,
  RunnerReleaseResponseSchema,
  SignedRunnersStatusSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { securitySetting } from '../auth/security-settings.ts';
import { requireStepUp } from '../auth/step-up.ts';
import {
  createInstallerSession,
  installerScript,
  installerStatus,
  recordInstallerProgress,
  type ScriptKind,
} from '../commands/installer.ts';
import type { Ctx } from '../context.ts';
import { conflict, gone, notFound } from '../errors.ts';
import {
  belowPairableFloor,
  findRelease,
  latestRelease,
  MIN_PAIRABLE_RUNNER,
  manifestFilesFor,
  RELEASE_MANIFEST_FILE,
  RELEASE_MINISIG_FILE,
  RELEASE_VERSION_PATTERN,
  RUNNER_PIN_BELOW_FLOOR,
  runnerUpdatesPaused,
  SIGNED_RUNNERS_SINCE,
} from '../installer/release.ts';
import { reinstallRequired } from '../runner-gateway/signed-sweep.ts';
import { typed } from './util.ts';

const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const FILES: Record<string, ScriptKind> = {
  'install.sh': 'linux',
  'install-linux-wsl.sh': 'linux',
  'install-mac.sh': 'macos',
  'install.ps1': 'windows',
};

/**
 * The runner installer:
 *  - the wizard's own routes (signed in): create a session, follow its progress;
 *  - `/install/:token/*` (unauthenticated, the short-lived token is the credential): the generated scripts and the
 *    progress reports the scripts send;
 *  - `/api/runner/release*` (unauthenticated: the runner release is not a secret): the tarball and its checksum. These
 *    are the only paths a pre-1.10.0 updater calls: while "Only signed runners" is on they answer 410
 *    `reinstall_required` (R21), so no untrusted runner updates itself;
 *  - `/api/runner/releases/{manifest.json, manifest.json.minisig, aom-runner-<v>.tgz}` (unauthenticated): the signed
 *    release 1.10.0 runners and installers fetch and verify.
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
        // release-readiness O3: adding a machine needs "Confirm it's you" (a fresh step-up)
        requireStepUp(ctx, s);
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

    app.get('/api/workstations/signed-runners', async (req) => {
      const s = await requireUser(ctx, req);
      return SignedRunnersStatusSchema.parse({
        requireSignedRunners: await securitySetting(ctx, 'requireSignedRunners'),
        minRunner: MIN_PAIRABLE_RUNNER,
        since: SIGNED_RUNNERS_SINCE,
        reinstallRequired: await reinstallRequired(ctx.pool, s.user.id),
      });
    });

    // The legacy update paths: refused while "Only signed runners" is on, served as before while it is off.
    const refuseLegacy = async () => {
      if (await securitySetting(ctx, 'requireSignedRunners'))
        throw gone(
          REINSTALL_REQUIRED,
          'this server accepts only signed runners: reinstall the runner with the installer from the Workstations page',
        );
    };

    app.get(
      '/api/runner/releases/:file',
      {
        schema: {
          params: z.object({ file: z.string().max(80) }),
          querystring: z.object({ version: z.string().max(40).optional() }),
        },
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const name = req.params.file;
        reply.header('cache-control', 'no-cache');
        const tgz = /^aom-runner-(.+?)\.tgz$/.exec(name);
        if (tgz) {
          if (!tgz[1] || !RELEASE_VERSION_PATTERN.test(tgz[1])) throw notFound();
          const r = await findRelease(ctx.config, tgz[1]);
          if (!r) throw notFound('no such runner release', 'no_release');
          return reply
            .type('application/gzip')
            .header('content-length', r.size)
            .header('content-disposition', `attachment; filename="aom-runner-${r.version}.tgz"`)
            .send(createReadStream(r.file));
        }
        if (name !== RELEASE_MANIFEST_FILE && name !== RELEASE_MINISIG_FILE) throw notFound();
        // `?version=`: a runner pinned to a release (safe mode). Nothing below the floor is served: the runner would
        // refuse it anyway, and the pin has to go.
        const wanted = req.query.version;
        if (wanted !== undefined) {
          if (!RELEASE_VERSION_PATTERN.test(wanted)) throw notFound();
          if (belowPairableFloor(wanted))
            throw conflict(
              RUNNER_PIN_BELOW_FLOOR,
              `runner ${wanted} is older than the oldest runner ${SIGNED_RUNNERS_SINCE} trusts (${MIN_PAIRABLE_RUNNER}): remove the pin on the platform Runners page, or reinstall the workstation`,
            );
        }
        const files = manifestFilesFor(ctx.config, wanted);
        const file = name === RELEASE_MANIFEST_FILE ? files?.manifest : files?.minisig;
        if (!file) throw notFound('this server has no such runner release file', 'no_release');
        if (name === RELEASE_MANIFEST_FILE)
          // The kill switch for 1.10.0 runners, which read only these paths (`autoUpdatePaused` of the legacy JSON).
          return reply
            .type('application/json')
            .header('x-runner-updates-paused', String(await runnerUpdatesPaused(ctx.pool)))
            .send(createReadStream(file));
        return reply.type('text/plain; charset=utf-8').send(createReadStream(file));
      },
    );

    app.get('/api/runner/release', async (req) => {
      await refuseLegacy();
      // `?version=` asks for one specific release (safe mode: a runner pinned to a version, an older one too).
      const wanted = (req.query as { version?: string }).version;
      if (wanted !== undefined && !RELEASE_VERSION_PATTERN.test(wanted)) throw notFound();
      const r = wanted ? await findRelease(ctx.config, wanted) : await latestRelease(ctx.config);
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
        await refuseLegacy();
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
