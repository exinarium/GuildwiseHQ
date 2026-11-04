import assert from 'node:assert/strict';
import { test } from 'node:test';

const load = async (noDocker: boolean) => {
  if (noDocker) process.env.AOM_E2E_NO_DOCKER = '1';
  else delete process.env.AOM_E2E_NO_DOCKER;
  const m = (await import(`../playwright.config.ts?docker=${noDocker}`)) as {
    default: { projects: { name: string }[]; metadata?: { excludedProjects?: { name: string }[] } };
    DOCKER_PROJECTS: string[];
  };
  return m;
};

test('the Docker projects are present by default and left out, and named, with AOM_E2E_NO_DOCKER=1', async () => {
  const on = await load(false);
  const off = await load(true);
  const onNames = on.default.projects.map((p) => p.name);
  const offNames = off.default.projects.map((p) => p.name);
  for (const n of on.DOCKER_PROJECTS) {
    assert.ok(onNames.includes(n), `${n} present by default`);
    assert.ok(!offNames.includes(n), `${n} left out`);
  }
  assert.deepEqual(
    off.default.metadata?.excludedProjects?.map((p) => p.name),
    on.DOCKER_PROJECTS,
  );
  assert.deepEqual(
    offNames,
    onNames.filter((n) => !on.DOCKER_PROJECTS.includes(n)),
  );
});
