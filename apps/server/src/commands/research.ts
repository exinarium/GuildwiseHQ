import {
  isPublishRequest,
  isSafeVaultPath,
  PublicationDataSchema,
  projectVaultFolder,
  streamId,
} from '@aom/shared';
import type { Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';

export type PublicationResult =
  | { ok: true; events: AppendInput[]; summary: string; handoffData: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Turns the checker's `published` outcome into the `ResearchPublished` event (docs/SPEC.md "Research and feeds"). The
 * note itself was written into the vault by the checker's runner (`aom publish`), which only forwards the path and the
 * citations; the server refuses a publication that is not a note in the project's vault folder or that carries no
 * citations ("no citations, no publication").
 */
export function buildPublicationEvents(a: {
  card: Row;
  agent: Row;
  project: Row;
  data: Record<string, unknown>;
}): PublicationResult {
  if (isPublishRequest(a.data))
    return {
      ok: false,
      error:
        'a note is published with `aom publish` (the runner writes it into the vault); it cannot be sent as a plain outcome',
    };
  const parsed = PublicationDataSchema.safeParse(a.data);
  if (!parsed.success)
    return {
      ok: false,
      error: `invalid publication: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'data'}: ${i.message}`).join('; ')}`,
    };
  const pub = parsed.data;
  const folder = projectVaultFolder({
    key: a.project.key,
    vaultFolder: a.project.vault_folder,
    vaultDir: a.project.vault_dir,
  });
  if (
    !isSafeVaultPath(pub.vaultPath) ||
    !pub.vaultPath.endsWith('.md') ||
    !pub.vaultPath.startsWith(`${folder}/`)
  )
    return { ok: false, error: `the note must be a markdown file under ${folder}/ in the project's vault` };
  const seen = new Set<string>();
  const citations = pub.citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));

  const summary = `Published "${pub.title}" to ${pub.vaultPath} with ${citations.length} citation${citations.length === 1 ? '' : 's'}.`;
  const events: AppendInput[] = [
    {
      streamId: streamId.card(a.card.id),
      event: {
        type: 'ResearchPublished',
        payload: {
          cardId: a.card.id,
          projectId: a.card.project_id,
          vaultPath: pub.vaultPath,
          title: pub.title,
          citations,
          excerpt: pub.excerpt,
        },
      },
      actor: agentActor(a.agent.id),
      scope: projectScope(a.card.org_id, a.card.project_id),
    },
    cardMessage(a.card, { kind: 'agent', agentId: a.agent.id }, 'system', summary),
  ];
  // A research run of an interest is done with its note (the event `interest_run_done` schedule triggers listen to).
  if (a.card.interest_run_id && a.card.interest_id)
    events.push({
      streamId: streamId.interest(a.card.interest_id),
      event: {
        type: 'InterestRunDone',
        payload: {
          runId: a.card.interest_run_id,
          interestId: a.card.interest_id,
          cardId: a.card.id,
          kind: 'research',
          status: 'published',
          published: 1,
          duplicatesDropped: 0,
          overMaximumDropped: 0,
          itemIds: [],
        },
      },
      actor: agentActor(a.agent.id),
      scope: projectScope(a.card.org_id, a.card.project_id),
    });
  return {
    ok: true,
    events,
    summary,
    handoffData: { vaultPath: pub.vaultPath, title: pub.title, citations: citations.length },
  };
}
