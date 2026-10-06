import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

const COLS: Record<string, string> = {
  model: 'model',
  effort: 'effort',
  runtime: 'runtime',
  roleKey: 'role_key',
  roleVersion: 'role_version',
  seniority: 'seniority',
  skills: 'skills',
  permissions: 'permissions',
  capacity: 'capacity',
};

export const agentProjectors: Record<string, Projector> = {
  AgentHired: async (tx, e) => {
    const p = (e.event as EventOf<'AgentHired'>).payload;
    await exec(
      tx,
      `INSERT INTO agents (id, org_id, project_id, hired_by_user_id, manager_user_id, workstation_id, name, role_key,
         role_version, seniority, runtime, model, effort, skills, permissions, capacity, is_devops, status, hired_at,
         avatar_seed, avatar_style)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17,COALESCE($18::text, $20::text),$19)`,
      [
        p.agentId,
        p.orgId,
        p.projectId ?? null,
        p.hiredByUserId,
        p.workstationId,
        p.name,
        p.roleKey,
        p.roleVersion,
        p.seniority,
        p.runtime,
        p.model,
        p.effort ?? null,
        p.skills,
        JSON.stringify(p.permissions),
        p.capacity,
        p.isDevops,
        e.createdAt,
        p.avatarSeed ?? null,
        p.avatarStyle ?? 'notionists',
        p.agentId,
      ],
    );
  },
  AgentAvatarRerolled: async (tx, e) => {
    const p = (e.event as EventOf<'AgentAvatarRerolled'>).payload;
    await exec(tx, 'UPDATE agents SET avatar_seed=$2, avatar_style=$3 WHERE id=$1', [
      p.agentId,
      p.avatarSeed,
      p.avatarStyle,
    ]);
  },
  AgentChanged: async (tx, e) => {
    const p = (e.event as EventOf<'AgentChanged'>).payload;
    const sets: string[] = [];
    const params: unknown[] = [p.agentId];
    for (const [k, v] of Object.entries(p.changes)) {
      const col = COLS[k];
      if (!col || v === undefined) continue;
      params.push(k === 'permissions' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) await exec(tx, `UPDATE agents SET ${sets.join(', ')} WHERE id=$1`, params);
  },
  AgentRetired: async (tx, e) => {
    const p = (e.event as EventOf<'AgentRetired'>).payload;
    await exec(tx, `UPDATE agents SET status='retired', retired_at=$2 WHERE id=$1`, [p.agentId, e.createdAt]);
  },
  AgentRehomed: async (tx, e) => {
    const p = (e.event as EventOf<'AgentRehomed'>).payload;
    await exec(tx, `UPDATE agents SET workstation_id=$2, runtime=$3, model=$4, status='active' WHERE id=$1`, [
      p.agentId,
      p.workstationId,
      p.runtime,
      p.model,
    ]);
  },
};
