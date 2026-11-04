# GWP-109: deploy-setup-journey fails in the full E2E run on release/1.5.0

Base commit: `d81aa42f` (the card branch and `release/1.5.0` are the same commit). The spec, its fixtures and its helpers
are the same as at `caa6a44f`, the commit of the GWP-99 run.

## 1. The question

`e2e/tests/deploy-setup-journey.spec.ts` fails in the GWP-99 full E2E run. Which test and step fail, with what error?
Does the failure depend on run order? Does the fix belong in the product or in the test? Did a release/1.5.0 change
(for example the GWP-63 base merge) cause it?

## 2. The run log

`/home/exinarium/devbox-cache/gwp99-run/run.log` cannot be read from design shifts, so DevOps read it (request
`53ac81ea`). DevOps posted the failing test, the full error and the cause on the card. Their summary: **"the spec
hardcodes 172.17.0.1 but docker0 on this host is 10.250.0.1, so the registry bind fails."**

- **Failing test:** the first test, `setup: a throwaway server (sshd + fake docker) with the stack outside /opt, a
  throwaway registry, a repository and a runner` (spec l.196).
- **Failing step:** starting the throwaway registry (l.212-223):
  ```ts
  docker('run', '-d', '--rm', '--name', REG,
         '-p', `127.0.0.1:${regPort}:5000`,
         '-p', `172.17.0.1:${regPort}:5000`,   // <- the host has no 172.17.0.1
         'registry:2');
  ```
  `docker run` exits non-zero because the daemon cannot bind a published port on an address the host does not have.
  Docker reports this as `... listen tcp4 172.17.0.1:<port>: bind: cannot assign requested address`. The exact lines
  are in DevOps' comment on the card. `execFileSync` throws, and the test fails there.
- **Consequence:** the spec runs in serial mode, so the other 10 tests (connect, save/try/approve, real release, second
  environment, DevOps scan merge, other server, removals, registry release, app without Docker, key removal) are not
  run. The whole journey shows as failed.

## 3. Findings

### 3.1 Why the spec binds 172.17.0.1

The registry release works like this: the runner builds and pushes a real image to the registry on
`127.0.0.1:<regPort>`. The "server" is the sshd box, and its fake docker then checks that image with a real HTTP
request. The box cannot reach the host's `127.0.0.1`, so the spec does two things:

1. It also publishes the registry on `172.17.0.1:<regPort>`, the gateway of Docker's default bridge `docker0` on a
   default install.
2. It writes `127.0.0.1:<regPort>=172.17.0.1:<regPort>` into the box's `/var/fakedocker/registry-map` (l.301).
   `apps/runner/test/fixtures/fake-flow-docker.sh` `pull` (l.138-150) rewrites the host of the manifest URL with that
   map before it calls `wget http://$to/v2/<repo>/manifests/<tag>`. The image name it records stays
   `127.0.0.1:<regPort>/demo-server:<sha>`.

`172.17.0.1` is only Docker's built-in default. On this workstation `/etc/docker/daemon.json` sets
`default-address-pools: [{base: 10.250.0.0/16, size: 24}]` (the devbox setup: `devbox/setup.sh` l.436,
`config.env` `ADDRESS_POOL=10.250.0.0/16`). With that setting, `docker0` takes the first subnet from the pool and its
gateway becomes `10.250.0.1`. DevOps confirmed this on the host.

### 3.2 Run order: not a factor

- The failing line uses no state from other specs. It is a fixed host address that does not exist on this host. The
  spec fails the same way **when run on its own** (`--project=deploy-setup-journey`), and on any host whose `docker0`
  is not `172.17.0.1`. It is not flaky and does not depend on order. It shows up in the "full run" only because
  GWP-99 was the first run of the Docker specs on this workstation.
- The other three Docker specs pass on the same host because none of them uses the bridge address:
  - `deploy-setup` publishes only on `127.0.0.1`.
  - `deploy-connect` and `deploy-move` publish only `127.0.0.1::22`.
  ```
  $ grep -rn "172.17" e2e apps/runner/test/fixtures
  e2e/tests/deploy-setup-journey.spec.ts:221   e2e/tests/deploy-setup-journey.spec.ts:301   (only here)
  ```
- Nothing else that the planning note suspected is involved: the image tag `aom-test-sshd:1`, the per-spec runner home,
  JOURNEYER (only this spec uses it, in an organization of its own), the free-port probes, and the DB rows. For the
  record, I checked the order in which Playwright 1.63 runs the projects (`createPhasesTask`). This spec is in phase 1
  with the other `auth`-only projects. No spec that moves the test clock (core-loop, interests, schedules,
  journey-waits) runs before it.

### 3.3 Product or test

**Test (environment assumption).** No product code runs before the failure. The failing call is the spec's own
`docker run`, before the runner is paired. No deploy-setup behaviour regressed.

### 3.4 release/1.5.0

**Not caused by release/1.5.0.** The spec was added in `5e2a7c13` (2026-10-21) and last touched in `80c85b05`
(2026-10-25, names only). `fake-flow-docker.sh` was last changed in `5a266c79` (2026-10-21). The GWP-63 merge
(scheduler, journeys, storage, runner host) changed none of these files. The trigger is the workstation's Docker
address pool. The `172.17.0.1` assumption has been in the spec since `5e2a7c13`.

## 4. Options

| Option | What | Verdict |
|---|---|---|
| **A. Private Docker network for the box and the registry** | `docker network create aom-e2e-journey-net-<pid>`. Run REG and BOX with `--network` on it. Publish the registry on `127.0.0.1` only. The map becomes `127.0.0.1:<regPort>=<REG>:5000`, which Docker's embedded DNS resolves inside the box. Remove the network in `afterAll`. | **Recommended.** Works with any daemon configuration: custom pools, custom `bip`, rootless, Docker Desktop. Nothing listens on a host bridge address any more, which also fits the spec's own safety rule ("nothing outside the throwaway containers is touched"). About 8 changed lines. |
| B. Read the bridge gateway at run time | `docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`, then use it in both places. | Works here (`10.250.0.1`). It still depends on the host: `Gateway` can be empty (rootless, some Desktop setups), and the registry still listens on a host bridge address that every container on `docker0` can reach. Acceptable fallback, but not preferred. |
| C. `--add-host host.docker.internal:host-gateway` and publish the registry on `0.0.0.0` | | Rejected: it exposes the throwaway registry on every interface of the workstation (LAN). |
| D. Change the workstation's Docker config to `bip: 172.17.0.1/16` | | Rejected: the card says stay in GuildwiseHQ, the setting belongs to the owner's devbox, and the next machine would break the same way. |
| E. Skip the registry test when 172.17.0.1 is missing | | Rejected: it removes real deploy-setup coverage (registry release), which card requirement 4 forbids. |

## 5. Design (option A)

Only `e2e/tests/deploy-setup-journey.spec.ts` changes. No helper, no other spec, and no product code.

```ts
// next to BOX / REG
const NET = `aom-e2e-journey-net-${process.pid}`;

// afterAll: after the containers are removed (a network with containers on it cannot be removed)
for (const n of [BOX, REG]) { try { docker('rm', '-f', n); } catch { /* never started */ } }
try {
  docker('network', 'rm', NET);
} catch {
  // never made
}

// setup, before the registry
docker('network', 'create', NET);
regPort = await freePort();
docker('run', '-d', '--rm', '--name', REG, '--network', NET,
       '-p', `127.0.0.1:${regPort}:5000`, 'registry:2');            // the 172.17.0.1 binding goes

// the server
docker('run', '-d', '--rm', '--name', BOX, '--network', NET,
       '-p', '127.0.0.1::22', '-p', '127.0.0.1::5500', '-p', '127.0.0.1::8090', IMAGE);

// inside the box: pulls of 127.0.0.1:<regPort>/... reach the registry by its container name on the shared network
`printf '127.0.0.1:${regPort}=${REG}:5000\\n' > /var/fakedocker/registry-map`,
```

Notes for the builder:

- Keep the `AOM_JOURNEY_KEEP=1` early return. It now keeps the network too. Add "and the network" to its comment.
- Do not change `fake-flow-docker.sh`. Its map already takes any `host:port`, and the file header documents this use.
- **Every assertion stays as it is.** That includes the registry test's
  `image: "127.0.0.1:${regPort}/demo-server:<sha>"`, the tag list read from `http://127.0.0.1:${regPort}/v2/...`, and
  the container image line. The image name the box records does not change, because the map rewrites only the host of
  the manifest URL.
- `docker port` output and the `127.0.0.1::<port>` publishes behave the same on a user-defined network. ssh, httpd
  and shop ports are unchanged.
- Update the header comment: "a REAL registry (a throwaway registry:2 container on a private network with the box)".
- Use biome format and lint (`pnpm biome check e2e/tests/deploy-setup-journey.spec.ts`), and run `tsc` for e2e if
  the repository has an e2e typecheck script.

Not in scope (keep the fix small): this spec has two unscoped SQL reads. `workstation_capabilities` at l.391 is used
with `.some`, so it can only pass more easily. `deploy_runs WHERE env='shop'` at l.734 is unique to this spec today.
Neither is a cause, and both are filed as a backlog suggestion.

### Routing

The whole change is under `e2e/**`. Per the CEO rulings recorded in ledger `f87e3c86` (also `aadf93f9`, `69b39b28`),
builders get no exception to the `e2e/**` guard. The build goes to a **tester-role shift**, and DevOps runs the Docker
specs (ledger `51def9f4`, standing order on GWP-99).

## 6. Test plan (DevOps runs, the tester records; outside every sandbox)

From `e2e/`, after `pnpm -C .. build`, with the commit hash recorded for each run:

1. **Before the fix** (release/1.5.0 `d81aa42f`): `pnpm exec playwright test --project=deploy-setup-journey`. It is
   expected to fail in `setup` at the registry `docker run`, which confirms that the failure does not depend on order.
2. **With the fix:**
   - The spec on its own: `pnpm exec playwright test --project=deploy-setup-journey` → all 11 journey tests pass, plus the `auth` project it depends on.
   - The four Docker specs together: `pnpm exec playwright test --project=deploy-setup --project=deploy-connect
     --project=deploy-move --project=deploy-setup-journey` → all pass.
   - The full suite three times in a row: `pnpm exec playwright test` (or `pnpm e2e`). deploy-setup-journey passes
     every time. Compare the failures with the GWP-99 list. The only expected differences are this spec and whichever
     of GWP-105..108 have merged by then.
3. After each run: `docker ps -a --filter name=aom-e2e-journey` and `docker network ls --filter name=aom-e2e-journey`
   must both be empty. This checks that `afterAll` removes the containers and the network.

## 7. Acceptance criteria

| AC | How it is met |
|---|---|
| Root cause from the run log on the card | DevOps' comment on the card. This report, sections 2-3: test `setup` (l.196), step registry `docker run` (l.212-223), bind on `172.17.0.1` fails because docker0 is `10.250.0.1`. Not order-dependent; it fails on its own too. Test plan step 1 confirms it. |
| Passes in a full run via DevOps, evidence on the card | Design section 5. Test plan step 2, full run (command, commit, pass count). |
| Passes alone, and 3 full runs in a row | Test plan step 2. The fix removes a host assumption, not a race, so it should be stable. |
| Other Docker specs and the full run no worse | Only this spec's file changes. The four Docker specs run together in step 2. Each full run is compared with GWP-99. |
| No assertion removed or loosened | No `expect` changes. Only the registry's network wiring changes (section 5 notes). |
| Unit tests and tsc if product code changed | Not applicable: no product code changes. biome is still run on the spec. |
