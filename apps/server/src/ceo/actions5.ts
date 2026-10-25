import {
  BACKLOG_PRIORITY_LABEL,
  BACKLOG_SEND_MAX,
  BacklogFilter,
  type BacklogItemDto,
  BacklogPriority,
  BacklogTag,
  type CeoActionName,
} from '@aom/shared';
import { z } from 'zod';
import type { AuthSession } from '../auth/sessions.ts';
import {
  addBacklogItem,
  dropBacklogItem,
  editBacklogItem,
  getBacklogItem,
  listBacklog,
  sendBacklogItems,
} from '../commands/backlog.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { refuse, truncate } from './actions.ts';
import type { ActionDef } from './types.ts';

/** The CEO's list line: `<id> GWP [Open] High ★ ui,onboarding "Title" (owner | agent Ada on GWP-3) -> GWP-12`. */
export function backlogLine(i: BacklogItemDto): string {
  const status = i.status === 'open' ? 'Open' : i.status === 'done' ? 'Done' : 'Dropped';
  const source =
    i.source.kind === 'owner'
      ? 'owner'
      : `agent ${i.source.agentName}${i.source.cardRef ? ` on ${i.source.cardRef}` : ''}`;
  return `${i.id} ${i.projectKey} [${status}] ${BACKLOG_PRIORITY_LABEL[i.priority]}${i.flagged ? ' ★' : ''}${i.tags.length ? ` ${i.tags.join(',')}` : ''} "${i.title}" (${source})${i.cardRef ? ` -> ${i.cardRef}` : ''}`;
}

/** Items of the organization that match the filter, optionally in one project (a key); without a project: all of them. */
export async function findBacklogItems(
  ctx: Ctx,
  owner: AuthSession['user'],
  orgId: string,
  projectKey: string | undefined,
  filter: BacklogFilter,
): Promise<BacklogItemDto[]> {
  const { items } = await listBacklog(ctx, owner, { orgId }, filter);
  return projectKey ? items.filter((i) => i.projectKey === projectKey.toUpperCase()) : items;
}

const Tags = z.array(BacklogTag).max(20);

// -------------------------------------------------------------------------------------------------- add

const AddP = z.object({
  project: z.string().min(2).max(10),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000).optional(),
  priority: BacklogPriority.optional(),
  tags: Tags.optional(),
  flagged: z.coerce.boolean().optional(),
});

const add: ActionDef<z.infer<typeof AddP>> = {
  cls: 'backlog.manage',
  schema: AddP,
  describe: (p) => `Put on the ${p.project.toUpperCase()} backlog: ${truncate(p.title, 100)}`,
  async prepare(env, p) {
    const project = await one(
      env.ctx.pool,
      `SELECT id, key FROM projects WHERE org_id=$1 AND key=upper($2) AND kind='project' AND status='active'`,
      [env.orgId, p.project],
    );
    if (!project) return refuse(`project ${p.project.toUpperCase()} not found`);
    return {
      subjectKind: 'project',
      subjectId: project.id as string,
      subjectLabel: `${project.key}: ${truncate(p.title, 80)}`,
      data: { pid: project.id },
    };
  },
  async execute(env, p, pr) {
    const item = await addBacklogItem(env.ctx, env.owner, pr.data?.pid as string, {
      title: p.title,
      description: p.description ?? '',
      priority: p.priority ?? 'normal',
      tags: [...new Set(p.tags ?? [])],
      flagged: p.flagged ?? false,
    });
    return {
      message: `Added to the ${item.projectKey} backlog: ${backlogLine(item)}`,
      result: { itemId: item.id, projectKey: item.projectKey },
    };
  },
};

// ----------------------------------------------------------------------------------------------- update

const UpdateP = z.object({
  item: z.uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(8000).optional(),
  priority: BacklogPriority.optional(),
  tags: Tags.optional(),
  flagged: z.coerce.boolean().optional(),
  drop: z.coerce.boolean().optional(),
});

const update: ActionDef<z.infer<typeof UpdateP>> = {
  cls: 'backlog.manage',
  schema: UpdateP,
  describe: (p) => (p.drop ? 'Drop a backlog item' : 'Change a backlog item'),
  async prepare(env, p) {
    const hasChange =
      p.title !== undefined ||
      p.description !== undefined ||
      p.priority !== undefined ||
      p.tags !== undefined ||
      p.flagged !== undefined;
    if (p.drop && hasChange) return refuse('drop an item on its own: one call does one thing');
    if (!p.drop && !hasChange) return refuse('nothing to change: give a field, --flag/--unflag or --drop');
    const item = await getBacklogItem(env.ctx, env.owner, p.item).catch((e) => {
      if (e instanceof HttpError) return null;
      throw e;
    });
    if (!item) return refuse(`backlog item ${p.item} not found`);
    if (item.status !== 'open')
      return refuse(`"${item.title}" is ${item.status}: only an Open item can change`);
    return {
      subjectKind: 'backlog_item',
      subjectId: item.id,
      subjectLabel: `${item.projectKey}: ${truncate(item.title, 80)}`,
    };
  },
  async execute(env, p) {
    if (p.drop) {
      const item = await dropBacklogItem(env.ctx, env.owner, p.item);
      return { message: `Dropped: ${backlogLine(item)}`, result: { itemId: item.id, status: item.status } };
    }
    const item = await editBacklogItem(env.ctx, env.owner, p.item, {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.tags !== undefined ? { tags: [...new Set(p.tags)] } : {}),
      ...(p.flagged !== undefined ? { flagged: p.flagged } : {}),
    });
    return { message: `Updated: ${backlogLine(item)}`, result: { itemId: item.id } };
  },
};

// ---------------------------------------------------------------------------------------------- send

const SendP = z.object({
  item: z.uuid().optional(),
  project: z.string().min(2).max(10).optional(),
  tag: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  priority: z.array(BacklogPriority).optional(),
  flagged: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
});

const send: ActionDef<z.infer<typeof SendP>> = {
  cls: 'card.create_via_ba',
  schema: SendP,
  describe: (p, pr) => `Send ${pr.subjectLabel} to the BA`,
  async prepare(env, p) {
    const base = { subjectKind: 'backlog_item', subjectId: p.item ?? '' };
    if (p.item) {
      const item = await getBacklogItem(env.ctx, env.owner, p.item).catch((e) => {
        if (e instanceof HttpError) return null;
        throw e;
      });
      if (!item) return refuse(`backlog item ${p.item} not found`);
      if (item.status !== 'open')
        return refuse(
          item.status === 'done'
            ? `"${item.title}" already became ${item.cardRef ?? 'a card'}: it cannot be sent again`
            : `"${item.title}" was dropped: it cannot be sent`,
        );
      return {
        ...base,
        subjectLabel: `${item.projectKey}: ${truncate(item.title, 80)}`,
        data: { ids: [item.id] },
      };
    }
    if (!p.project && !p.tag?.length && !p.priority?.length && p.flagged === undefined && !p.q)
      return refuse('name an item or give filters (project, tag, priority, flagged): a bare send is refused');
    const filter = BacklogFilter.parse({
      status: ['open'],
      ...(p.tag?.length ? { tag: p.tag } : {}),
      ...(p.priority?.length ? { priority: p.priority } : {}),
      ...(p.flagged !== undefined ? { flagged: p.flagged } : {}),
      ...(p.q ? { q: p.q } : {}),
    });
    const items = await findBacklogItems(env.ctx, env.owner, env.orgId, p.project, filter);
    if (items.length === 0) return refuse('no Open backlog item matches');
    if (items.length > BACKLOG_SEND_MAX)
      return refuse(
        `${items.length} items match; at most ${BACKLOG_SEND_MAX} are sent at once: narrow the filters`,
      );
    return {
      ...base,
      subjectLabel: `${items.length} backlog ${items.length === 1 ? 'item' : 'items'}`,
      data: { ids: items.map((i) => i.id) },
    };
  },
  async execute(env, _p, pr) {
    const ids = pr.data?.ids as string[];
    const results = await sendBacklogItems(env.ctx, env.owner, ids);
    const lines = results.map((r) => (r.ok ? `${r.cardRef} <- ${r.title}` : `FAILED ${r.title}: ${r.error}`));
    const sent = results.filter((r) => r.ok).length;
    return {
      message: `${sent} of ${results.length} sent to the BA.\n${lines.join('\n')}`,
      result: { sent, failed: results.length - sent, results },
    };
  },
};

export const ACTIONS5: Partial<Record<CeoActionName, ActionDef>> = {
  'backlog-add': add,
  'backlog-update': update,
  'backlog-send': send,
};
