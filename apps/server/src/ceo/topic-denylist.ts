import type { Queryable } from '../db/sql.ts';
import { rows } from '../db/sql.ts';

/**
 * The organization's own names, built here and never sent anywhere (docs/design/ceo-blog-topics.md section 3.1): the
 * scrubber rejects a question that contains one. Phrases are matched whole; the words of an organization, agent or
 * person name are added on their own (a person is named by one word as often as by two).
 */
export async function buildDenyList(db: Queryable, orgId: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (v: unknown, opts: { words?: boolean; min?: number } = {}) => {
    if (typeof v !== 'string') return;
    const phrase = v.trim().toLowerCase();
    if (phrase.length >= 3) out.add(phrase);
    if (opts.words) for (const w of phrase.split(/[^a-z0-9]+/)) if (w.length >= (opts.min ?? 4)) out.add(w);
  };
  const addHost = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return;
    const host = v
      .trim()
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/)[0]
      ?.replace(/:\d+$/, '');
    add(host);
  };

  for (const r of await rows(db, 'SELECT name FROM organizations WHERE id=$1', [orgId]))
    add(r.name, { words: true });
  for (const r of await rows(db, 'SELECT key, name FROM projects WHERE org_id=$1', [orgId])) {
    // a three-letter key (WEB, API) is also an everyday word: a ticket key in the text is caught by the pattern gate
    if (String(r.key).length >= 4) add(r.key);
    add(r.name);
  }
  for (const r of await rows(
    db,
    `SELECT r.name, r.remote_url_normalized FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE p.org_id=$1`,
    [orgId],
  )) {
    add(r.name);
    // github.com/acme/web: the owner and the repository are names too (the host is public)
    const parts = String(r.remote_url_normalized ?? '').split('/');
    for (const seg of parts.slice(1)) add(seg.replace(/\.git$/, ''));
  }
  for (const r of await rows(db, 'SELECT name FROM vaults WHERE org_id=$1', [orgId])) add(r.name);
  for (const r of await rows(db, 'SELECT name FROM agents WHERE org_id=$1', [orgId]))
    add(r.name, { words: true });
  for (const r of await rows(
    db,
    `SELECT u.display_name, u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id=$1`,
    [orgId],
  )) {
    add(r.display_name, { words: true, min: 3 });
    add(String(r.email ?? '').split('@')[0]);
  }
  for (const r of await rows(
    db,
    `SELECT w.name, w.hostname FROM workstations w JOIN org_members m ON m.user_id = w.user_id AND m.org_id=$1`,
    [orgId],
  )) {
    add(r.name);
    addHost(r.hostname);
  }
  for (const r of await rows(db, 'SELECT name, host, app_url FROM deploy_targets WHERE org_id=$1', [orgId])) {
    add(r.name);
    addHost(r.host);
    addHost(r.app_url);
  }
  return [...out];
}
