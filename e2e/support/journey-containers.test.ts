import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxArgs, NO_DOCKER_MESSAGE, registryArgs, startJourneyContainers } from './journey-containers.ts';

test('container arguments publish the given ports', () => {
  assert.ok(registryArgs('r', 4720).includes('127.0.0.1:4720:5000'));
  const box = boxArgs('b', { sshPort: 4721, httpPort: 4722, shopPort: 4723 });
  for (const p of ['127.0.0.1:4721:22', '127.0.0.1:4722:5500', '127.0.0.1:4723:8090'])
    assert.ok(box.includes(p));
});

test('without a Docker daemon the start fails with a message naming DevOps', () => {
  const docker = () => {
    throw new Error('Cannot connect');
  };
  assert.throws(
    () => startJourneyContainers(docker, '/nonexistent/state.json'),
    (e: Error) => e.message === NO_DOCKER_MESSAGE && /DevOps/.test(e.message),
  );
});
