import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uniqueEmail } from "./helpers/app.ts";
import { closeAdminPool, q } from "./helpers/db.ts";
import { addMember } from "./helpers/members.ts";
import {
  createWorld,
  markOnline,
  pairWorkstation,
  type Session,
  type World,
} from "./helpers/world.ts";

let w: World;
let orgId: string;
let adminS: Session & { workstationId: string };
let memberS: Session & { workstationId: string };
let outsider: Session & { workstationId: string };
let guest: Awaited<ReturnType<typeof addMember>>;
let target: string; // the owner's second workstation
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: "false" } });
  orgId = (
    await q("SELECT org_id FROM projects WHERE id=$1", [w.projectId])
  )[0]!.org_id;
  await markOnline(w.t, w.workstationId);
  target = (await pairWorkstation(w.t, w.owner, "target")).workstationId;
  await markOnline(w.t, target);
  const a = await w.t.userSession(uniqueEmail("adm"));
  await w.t.addOrgMember(orgId, a.id, "admin");
  adminS = { ...a, ...(await pairWorkstation(w.t, a, "admin-box")) };
  const m = await w.t.userSession(uniqueEmail("mem"));
  await w.t.addOrgMember(orgId, m.id, "member");
  memberS = { ...m, ...(await pairWorkstation(w.t, m, "member-box")) };
  await markOnline(w.t, memberS.workstationId);
  const o = await w.t.userSession(uniqueEmail("out"));
  outsider = { ...o, ...(await pairWorkstation(w.t, o, "outsider-box")) };
  guest = await addMember(w, "guest");
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => {
  const headers = { "x-aom-org": orgId }; // members also own a personal org: name the one under test
  return {
    get: (url: string) => w.t.req("GET", url, { cookie, headers }),
    post: (url: string, body: unknown = {}) =>
      w.t.req("POST", url, { cookie, body, headers }),
  };
};
const owner = () => as(w.owner.cookie);
const hire = () => w.hire(`Bulk${++n}`, "builder", "junior");
const agentRow = async (id: string) =>
  (await q("SELECT * FROM agents WHERE id=$1", [id]))[0]!;
const rehomed = (id: string) =>
  q(
    `SELECT actor_kind, actor_id, payload FROM events WHERE stream_id=$1 AND type='AgentRehomed' ORDER BY seq`,
    [`agent-${id}`],
  );

/** A fresh workstation holding `count` agents; `dead` unlinks it afterwards. */
async function station(count: number, dead = false) {
  const id = (await pairWorkstation(w.t, w.owner, `src${++n}`)).workstationId;
  await markOnline(w.t, id);
  const agents = [];
  for (let i = 0; i < count; i++) {
    const a = await hire();
    await q("UPDATE agents SET workstation_id=$2 WHERE id=$1", [a.id, id]);
    agents.push(a);
  }
  if (dead)
    await q(
      `UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`,
      [id],
    );
  return { id, agents };
}
const openShift = (agentId: string, wsId: string) =>
  q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
     VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
    [crypto.randomUUID(), orgId, agentId, wsId],
  );
const moveAll = (src: string, to = target, extra: object = {}) =>
  owner().post(`/api/workstations/${src}/move-agents`, {
    targetWorkstationId: to,
    ...extra,
  });

describe("move all agents from one workstation to another", () => {
  it("AC1/AC2/AC3/AC6: moves every agent of an unlinked workstation, keeps pause, one audit entry each", async () => {
    const s = await station(3, true);
    await q("UPDATE agents SET paused_at=now() WHERE id=$1", [s.agents[0]!.id]);
    const retired = await hire();
    await q(
      `UPDATE agents SET workstation_id=$2, status='retired' WHERE id=$1`,
      [retired.id, s.id],
    );
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.source).toMatchObject({ id: s.id, status: "unlinked" });
    expect(r.body.target).toMatchObject({ id: target, name: "target" });
    expect(r.body.moved.map((x: any) => x.agentId).sort()).toEqual(
      s.agents.map((a) => a.id).sort(),
    );
    expect(r.body.failed).toEqual([]);
    for (const a of s.agents) {
      const row = await agentRow(a.id);
      expect(row.workstation_id).toBe(target);
      const ev = await rehomed(a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actor_id).toBe(w.owner.id);
      expect(ev[0]!.payload).toMatchObject({
        fromWorkstationId: s.id,
        workstationId: target,
      });
    }
    expect((await agentRow(s.agents[0]!.id)).paused_at).not.toBeNull();
    expect((await agentRow(retired.id)).workstation_id).toBe(s.id);
    expect(await rehomed(retired.id)).toHaveLength(0);
  });

  it("AC2/AC3: an agent in a running shift is skipped with the reason, the rest move", async () => {
    const s = await station(3);
    await openShift(s.agents[1]!.id, s.id);
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.moved).toHaveLength(2);
    const shiftSkips = r.body.skipped.filter(
      (x: any) => x.reason === "running_shift",
    );
    expect(shiftSkips).toHaveLength(1); // the source's DevOps engineer is skipped too (workstation_devops)
    expect(shiftSkips[0]).toMatchObject({
      agentId: s.agents[1]!.id,
      name: s.agents[1]!.name,
      reason: "running_shift",
    });
    expect(shiftSkips[0].message).toContain("running shift");
    expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(s.id);
    expect(await rehomed(s.agents[1]!.id)).toHaveLength(0);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(target);
  });

  it("skips the DevOps engineer of the source and leaves it there", async () => {
    const dev = (
      await q(
        `SELECT id FROM agents WHERE is_devops AND status='active' AND workstation_id=$1`,
        [w.workstationId],
      )
    )[0]!;
    const a = await hire(); // hired onto the world's workstation, next to its DevOps engineer
    const r = await moveAll(w.workstationId);
    expect(r.status).toBe(200);
    expect(r.body.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: dev.id,
          reason: "workstation_devops",
        }),
      ]),
    );
    expect(r.body.moved.map((x: any) => x.agentId)).toContain(a.id);
    expect((await agentRow(dev.id)).workstation_id).toBe(w.workstationId);
    expect(await rehomed(dev.id)).toHaveLength(0);
  });

  it("preview reports the same plan and writes nothing", async () => {
    const s = await station(2);
    await openShift(s.agents[0]!.id, s.id);
    const r = await owner().get(
      `/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.moved.map((x: any) => x.agentId)).toEqual([s.agents[1]!.id]);
    expect(r.body.skipped.map((x: any) => x.reason)).toContain("running_shift");
    for (const a of s.agents) {
      expect((await agentRow(a.id)).workstation_id).toBe(s.id);
      expect(await rehomed(a.id)).toHaveLength(0);
    }
  });

  it("AC4: refuses the same workstation, an unknown one, another organization and unrelated sources", async () => {
    const s = await station(1);
    const same = await moveAll(s.id, s.id);
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body)).toContain("same_workstation");
    const unknown = "00000000-0000-4000-8000-000000000001";
    for (const [src, to] of [
      [s.id, unknown],
      [unknown, target],
      [s.id, outsider.workstationId],
      [outsider.workstationId, target],
      [s.id, guest.workstationId],
    ] as const) {
      const r = await moveAll(src, to);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).toContain("workstation_not_found");
    }
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it("AC4: an unpaired member workstation as target is 409 workstation_unpaired", async () => {
    const s = await station(1);
    const gone = (await pairWorkstation(w.t, w.owner, `gone${++n}`))
      .workstationId;
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [gone]);
    const r = await moveAll(s.id, gone);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain("workstation_unpaired");
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
  });

  it("AC5: a Member gets 403 on every route, an Admin is allowed", async () => {
    const s = await station(1);
    const m = as(memberS.cookie);
    expect(
      (
        await m.post(`/api/workstations/${s.id}/move-agents`, {
          targetWorkstationId: target,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await m.get(
          `/api/workstations/${s.id}/move-agents/preview?targetWorkstationId=${target}`,
        )
      ).status,
    ).toBe(403);
    expect((await m.get(`/api/workstations/${s.id}/move-targets`)).status).toBe(
      403,
    );
    expect((await m.get("/api/agents/workstations")).status).toBe(403);
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    const r = await as(adminS.cookie).post(
      `/api/workstations/${s.id}/move-agents`,
      {
        targetWorkstationId: target,
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.moved).toHaveLength(1);
  });

  it("partial success: an agent whose runtime the target lacks fails, the others move", async () => {
    const s = await station(2);
    await q(`UPDATE agents SET runtime='ghost' WHERE id=$1`, [s.agents[0]!.id]);
    await q(`UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1`, [
      target,
      JSON.stringify([
        { id: "mock", version: "1", available: true, capabilities: ["shell"] },
      ]),
    ]);
    const r = await moveAll(s.id);
    expect(r.status).toBe(200);
    expect(r.body.moved.map((x: any) => x.agentId)).toEqual([s.agents[1]!.id]);
    expect(r.body.failed[0]).toMatchObject({
      agentId: s.agents[0]!.id,
      code: "runtime_missing",
    });
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    expect((await agentRow(s.agents[1]!.id)).workstation_id).toBe(target);
  });

  it("an unsandboxed target needs the acknowledgement, flagged in the response", async () => {
    const s = await station(1);
    await q(`UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1`, [
      target,
      JSON.stringify([
        {
          id: "mock",
          version: "1",
          available: true,
          capabilities: ["shell"],
          sandbox: "unsandboxed",
        },
      ]),
    ]);
    const r = await moveAll(s.id);
    expect(r.body.needsUnsandboxedAck).toBe(true);
    expect(r.body.failed[0].code).toBe("unsandboxed_ack_required");
    expect((await agentRow(s.agents[0]!.id)).workstation_id).toBe(s.id);
    const ok = await moveAll(s.id, target, { acknowledgeUnsandboxed: true });
    expect(ok.body.moved).toHaveLength(1);
    await q(`UPDATE workstations SET runtimes='[]'::jsonb WHERE id=$1`, [
      target,
    ]);
  });

  it("serves the homes list and the source-keyed target list", async () => {
    const s = await station(2, true);
    const homes = await owner().get("/api/agents/workstations");
    expect(homes.status).toBe(200);
    expect(
      homes.body.workstations.find((h: any) => h.id === s.id),
    ).toMatchObject({
      status: "unlinked",
      agentCount: 2,
      runningCount: 0,
      mine: true,
    });
    const t = await owner().get(`/api/workstations/${s.id}/move-targets`);
    expect(t.status).toBe(200);
    expect(t.body.current).toMatchObject({ id: s.id, state: "unpaired" });
    expect(t.body.workstations.map((x: any) => x.id)).toContain(target);
    expect(t.body.workstations.map((x: any) => x.id)).not.toContain(s.id);
    expect(
      (
        await owner().get(
          `/api/workstations/${outsider.workstationId}/move-targets`,
        )
      ).status,
    ).toBe(404);
  });
});
