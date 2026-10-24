import {
  DelegateGrantsDtoSchema,
  DelegateTargetOptionsDtoSchema,
  SetDelegateGrantRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import {
  delegateTargetOptions,
  getAgentDelegateGrants,
  getRoleDelegateGrants,
  getSessionDelegateGrants,
  roleDelegateTargetOptions,
  setAgentDelegateGrant,
  setRoleDelegateGrant,
  setSessionDelegateGrant,
} from '../sessions/delegate-grants.ts';
import { typed } from './util.ts';

/** Explicit delegation (docs/ARCHITECTURE.md section 38.9): who may delegate to whom, for an agent and for a session. */
export function delegationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const Params = z.object({ id: z.uuid() });

    app.get(
      '/api/agents/:id/delegate-grants',
      { schema: { params: Params, response: { 200: DelegateGrantsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return getAgentDelegateGrants(ctx, a.session.user, req.params.id);
      },
    );
    app.put(
      '/api/agents/:id/delegate-grants',
      {
        schema: {
          params: Params,
          body: SetDelegateGrantRequestSchema,
          response: { 200: DelegateGrantsDtoSchema },
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return setAgentDelegateGrant(ctx, a.session.user, req.params.id, req.body);
      },
    );
    app.get(
      '/api/agents/:id/delegate-targets',
      { schema: { params: Params, response: { 200: DelegateTargetOptionsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return { items: await delegateTargetOptions(ctx, a.session.user, 'agent', req.params.id) };
      },
    );

    // R3c (Q61): a role's grants cover every agent of the role, the future hires included. Owners and Admins, like the HR rule.
    const RoleParams = z.object({ key: z.string().min(1).max(80) });
    app.get(
      '/api/roles/:key/delegate-grants',
      { schema: { params: RoleParams, response: { 200: DelegateGrantsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return getRoleDelegateGrants(ctx, a.session.user, a.orgId, req.params.key);
      },
    );
    app.put(
      '/api/roles/:key/delegate-grants',
      {
        schema: {
          params: RoleParams,
          body: SetDelegateGrantRequestSchema,
          response: { 200: DelegateGrantsDtoSchema },
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return setRoleDelegateGrant(ctx, a.session.user, a.orgId, req.params.key, req.body);
      },
    );
    app.get(
      '/api/roles/:key/delegate-targets',
      { schema: { params: RoleParams, response: { 200: DelegateTargetOptionsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return { items: await roleDelegateTargetOptions(ctx, a.session.user, a.orgId, req.params.key) };
      },
    );

    app.get(
      '/api/sessions/:id/delegate-grants',
      { schema: { params: Params, response: { 200: DelegateGrantsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return getSessionDelegateGrants(ctx, a.session.user, req.params.id);
      },
    );
    app.put(
      '/api/sessions/:id/delegate-grants',
      {
        schema: {
          params: Params,
          body: SetDelegateGrantRequestSchema,
          response: { 200: DelegateGrantsDtoSchema },
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return setSessionDelegateGrant(ctx, a.session.user, req.params.id, req.body);
      },
    );
    app.get(
      '/api/sessions/:id/delegate-targets',
      { schema: { params: Params, response: { 200: DelegateTargetOptionsDtoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return { items: await delegateTargetOptions(ctx, a.session.user, 'session', req.params.id) };
      },
    );
  };
}
