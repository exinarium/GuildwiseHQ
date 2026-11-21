import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { type ExecOptions, type Executor, realExecutor } from '../src/toolchain/exec.ts';
import {
  ANDROID_CMDLINE_TOOLS,
  BUN_VERSION,
  GRADLE_VERSION,
  MAVEN_VERSION,
  UV_VERSION,
} from '../src/toolchain/pins.ts';
import {
  androidCmdlineUserInstall,
  bunUserInstall,
  dotnetUserInstall,
  goUserInstall,
  gradleUserInstall,
  jdkUserInstall,
  mavenUserInstall,
  nodeUserInstall,
  pythonUserInstall,
  rustUserInstall,
  uvToolUserInstall,
  uvUserInstall,
} from '../src/toolchain/sources.ts';
import { TOOLS } from '../src/toolchain/stacks.ts';
import {
  createUserInstaller,
  runUserInstall,
  sumFromText,
  toolchainsRoot,
  type UserInstallDeps,
  type UserInstallResolver,
} from '../src/toolchain/user-install.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

// ------------------------------------------------------------------------------------------------ fixtures

const sha = (algo: 'sha256' | 'sha512', file: string): string =>
  createHash(algo).update(readFileSync(file)).digest('hex');

/** Writes `files` (relative path -> content) under a fresh folder and returns it. */
function tree(files: Record<string, string>): string {
  const d = tmp('aom-ui-src-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), text, { mode: 0o755 });
  }
  return d;
}

/** A tar archive (`z` gzip, `J` xz) of the given files. */
function tarball(files: Record<string, string>, compress: 'z' | 'J' = 'z'): string {
  const src = tree(files);
  const out = join(tmp('aom-ui-arc-'), compress === 'J' ? 'a.tar.xz' : 'a.tar.gz');
  execFileSync('tar', [`-c${compress}f`, out, '-C', src, ...readdirSync(src)]);
  return out;
}

/** A stored (uncompressed) zip of the given files; no zip binary needed. */
function zipball(files: Record<string, string>): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const out = join(tmp('aom-ui-arc-'), 'a.zip');
  writeFileSync(out, Buffer.concat([...locals, cd, end]));
  return out;
}

/** A pretend internet: text answers and downloadable files by URL; records what was fetched. */
function net() {
  const texts = new Map<string, string>();
  const files = new Map<string, string>();
  const downloads: string[] = [];
  return {
    texts,
    files,
    downloads,
    fetchText: async (url: string) => {
      const t = texts.get(url);
      if (t === undefined) throw new Error(`no fixture for ${url}`);
      return t;
    },
    download: async (url: string, dest: string) => {
      const f = files.get(url);
      if (!f) throw new Error(`no fixture for ${url}`);
      downloads.push(url);
      copyFileSync(f, dest);
    },
  };
}

interface StepCall {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** tar/unzip run for real; any other command (uv, rustup-init) is recorded and `effect` fakes its result. */
function executor(effect: (s: StepCall) => void = () => {}): Executor & { steps: StepCall[] } {
  const steps: StepCall[] = [];
  return {
    steps,
    async run(cmd: string, args: string[], opts?: ExecOptions) {
      if (cmd === 'tar' || cmd === 'unzip') return realExecutor.run(cmd, args, opts);
      const s: StepCall = { cmd, args, ...(opts?.env ? { env: opts.env } : {}) };
      steps.push(s);
      effect(s);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function world(effect?: (s: StepCall) => void) {
  const home = realpathSync(tmp('aom-ui-home-'));
  const n = net();
  const exec = executor(effect);
  const deps: UserInstallDeps = {
    fetchText: n.fetchText,
    download: n.download,
    exec,
    home: () => home,
    accountHome: () => home,
    uid: () => 1000,
    platform: 'linux',
    arch: 'x64',
  };
  const root = toolchainsRoot(home);
  const log: string[] = [];
  const install = (id: string, resolver: UserInstallResolver, params = {}) =>
    createUserInstaller(deps).install(id, resolver, params, (l) => log.push(l));
  return { home, root, net: n, exec, deps, log, install };
}

/** The link in `<root>/bin` exists and points into the root. */
function linkedInto(root: string, name: string): string {
  const link = join(root, 'bin', name);
  expect(lstatSync(link).isSymbolicLink(), `${name} is a link`).toBe(true);
  const target = readlinkSync(link);
  expect(target.startsWith(`${root}/`), `${name} -> ${target}`).toBe(true);
  expect(existsSync(target), `${target} exists`).toBe(true);
  return target;
}

/** After a refused download: nothing unpacked, nothing linked, nothing left in .tmp. */
function nothingInstalled(root: string, tool: string) {
  expect(existsSync(join(root, tool))).toBe(false);
  expect(existsSync(join(root, 'bin'))).toBe(false);
  expect(readdirSync(join(root, '.tmp'))).toEqual([]);
}

const corrupt = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

// ------------------------------------------------------------------------------------------------ the rows

describe('user-space installs per stack (fixture downloads)', () => {
  const NODE_FILE = 'node-v22.4.0-linux-x64.tar.xz';
  function nodeFixture(w: ReturnType<typeof world>, good = true) {
    const arc = tarball(
      {
        'node-v22.4.0-linux-x64/bin/node': '#!node',
        'node-v22.4.0-linux-x64/bin/npm': '#!npm',
        'node-v22.4.0-linux-x64/bin/npx': '#!npx',
        'node-v22.4.0-linux-x64/bin/corepack': '#!corepack',
      },
      'J',
    );
    w.net.texts.set(
      'https://nodejs.org/dist/index.json',
      JSON.stringify([
        { version: 'v23.1.0', lts: false },
        { version: 'v22.4.0', lts: 'Jod' },
        { version: 'v20.15.0', lts: 'Iron' },
      ]),
    );
    const hex = sha('sha256', arc);
    w.net.texts.set(
      'https://nodejs.org/dist/v22.4.0/SHASUMS256.txt',
      `${'f'.repeat(64)}  node-v22.4.0-darwin-arm64.tar.gz\n${good ? hex : corrupt(hex)}  ${NODE_FILE}\n`,
    );
    w.net.files.set(`https://nodejs.org/dist/v22.4.0/${NODE_FILE}`, arc);
  }

  it('node: newest LTS from index.json, SHASUMS256 checked, linked', async () => {
    const w = world();
    nodeFixture(w);
    const r = await w.install('node', nodeUserInstall);
    expect(r).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'node')).toBe(join(w.root, 'node', '22.4.0', 'bin', 'node'));
    for (const b of ['npm', 'npx', 'corepack']) linkedInto(w.root, b);
    expect(w.log.join('\n')).toContain('sha256 verified');
  });

  it('node: the major the repository asks for', async () => {
    const w = world();
    nodeFixture(w);
    expect(await w.install('node', nodeUserInstall, { nodeMajor: '22' })).toMatchObject({ ok: true });
    expect(existsSync(join(w.root, 'node', '22.4.0'))).toBe(true);
  });

  it('node: a bad checksum is refused and nothing is unpacked', async () => {
    const w = world();
    nodeFixture(w, false);
    const r = await w.install('node', nodeUserInstall);
    expect(r?.ok).toBe(false);
    expect(r?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'node');
  });

  function uvFixture(w: ReturnType<typeof world>, good = true) {
    const t = 'uv-x86_64-unknown-linux-gnu';
    const arc = tarball({ [`${t}/uv`]: '#!uv', [`${t}/uvx`]: '#!uvx' });
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${t}.tar.gz`;
    const hex = sha('sha256', arc);
    w.net.texts.set(`${url}.sha256`, `${good ? hex : corrupt(hex)}  ${t}.tar.gz\n`);
    w.net.files.set(url, arc);
  }

  it('uv: pinned release, its .sha256 checked, uv and uvx linked', async () => {
    const w = world();
    uvFixture(w);
    expect(await w.install('python-uv', uvUserInstall)).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'uv')).toBe(join(w.root, 'uv', UV_VERSION, 'uv'));
    linkedInto(w.root, 'uvx');
  });

  it('uv: a bad checksum is refused', async () => {
    const w = world();
    uvFixture(w, false);
    expect((await w.install('python-uv', uvUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'uv');
  });

  it('python: `uv python install` with every uv folder under the root, python3 linked to the minor', async () => {
    const w = world((s) => {
      if (s.args[0] === 'python') {
        const bin = s.env?.UV_PYTHON_BIN_DIR as string;
        mkdirSync(join(s.env?.UV_PYTHON_INSTALL_DIR as string, 'cpython-3.11.9'), { recursive: true });
        symlinkSync(join(s.env?.UV_PYTHON_INSTALL_DIR as string, 'cpython-3.11.9'), join(bin, 'python3.11'));
      }
    });
    uvFixture(w);
    expect(await w.install('python', pythonUserInstall, { pythonVersion: '3.11' })).toMatchObject({
      ok: true,
    });
    const step = w.exec.steps[0];
    expect(step?.cmd).toBe(join(w.root, 'bin', 'uv'));
    expect(step?.args).toEqual(['python', 'install', '3.11']);
    for (const k of [
      'UV_PYTHON_INSTALL_DIR',
      'UV_PYTHON_BIN_DIR',
      'UV_TOOL_DIR',
      'UV_TOOL_BIN_DIR',
      'UV_CACHE_DIR',
    ])
      expect(step?.env?.[k]?.startsWith(`${w.root}/`), k).toBe(true);
    expect(readlinkSync(join(w.root, 'bin', 'python3'))).toBe(join(w.root, 'bin', 'python3.11'));
  });

  it('python: a bad uv checksum stops before uv runs', async () => {
    const w = world();
    uvFixture(w, false);
    expect((await w.install('python', pythonUserInstall))?.ok).toBe(false);
    expect(w.exec.steps).toEqual([]);
  });

  it.each(['poetry', 'pipenv'])('%s: `uv tool install` into the root (never pip --user)', async (pkg) => {
    const w = world();
    uvFixture(w);
    expect(await w.install(`python-${pkg}`, uvToolUserInstall(pkg))).toMatchObject({ ok: true });
    expect(w.exec.steps.map((s) => s.args)).toEqual([['tool', 'install', pkg]]);
    expect(w.exec.steps[0]?.env?.UV_TOOL_BIN_DIR).toBe(join(w.root, 'bin'));
  });

  function bunFixture(w: ReturnType<typeof world>, good = true) {
    const arc = zipball({ 'bun-linux-x64/bun': '#!bun' });
    const base = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}`;
    const hex = sha('sha256', arc);
    w.net.texts.set(`${base}/SHASUMS256.txt`, `${good ? hex : corrupt(hex)}  bun-linux-x64.zip\n`);
    w.net.files.set(`${base}/bun-linux-x64.zip`, arc);
  }

  it('bun: SHASUMS256 of the release, bun and bunx linked', async () => {
    const w = world();
    bunFixture(w);
    expect(await w.install('node-bun', bunUserInstall)).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'bun')).toBe(join(w.root, 'bun', BUN_VERSION, 'bun'));
    expect(linkedInto(w.root, 'bunx')).toBe(join(w.root, 'bun', BUN_VERSION, 'bun'));
  });

  it('bun: a bad checksum is refused', async () => {
    const w = world();
    bunFixture(w, false);
    expect((await w.install('node-bun', bunUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'bun');
  });

  function dotnetFixture(w: ReturnType<typeof world>, good = true) {
    const sdk = tarball({ dotnet: '#!muxer', 'sdk/10.0.401/dotnet.dll': 'sdk' });
    const rt = tarball({ dotnet: '#!muxer', 'shared/Microsoft.NETCore.App/8.0.12/x.dll': 'rt' });
    const sdkHash = sha('sha512', sdk);
    w.net.texts.set(
      'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json',
      JSON.stringify({
        'latest-sdk': '10.0.401',
        'latest-runtime': '10.0.12',
        releases: [
          {
            sdk: { version: '10.0.300', files: [] },
            sdks: [
              {
                version: '10.0.401',
                files: [
                  {
                    name: 'dotnet-sdk-linux-arm64.tar.gz',
                    rid: 'linux-arm64',
                    url: 'https://b/arm.tar.gz',
                    hash: 'x',
                  },
                  {
                    name: 'dotnet-sdk-linux-x64.tar.gz',
                    rid: 'linux-x64',
                    url: 'https://b/sdk-10.tar.gz',
                    hash: good ? sdkHash : corrupt(sdkHash),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    w.net.texts.set(
      'https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json',
      JSON.stringify({
        'latest-sdk': '8.0.425',
        'latest-runtime': '8.0.12',
        releases: [
          {
            runtime: {
              version: '8.0.12',
              files: [
                {
                  name: 'dotnet-runtime-linux-x64.tar.gz',
                  rid: 'linux-x64',
                  url: 'https://b/rt-8.tar.gz',
                  hash: sha('sha512', rt),
                },
              ],
            },
          },
        ],
      }),
    );
    w.net.files.set('https://b/sdk-10.tar.gz', sdk);
    w.net.files.set('https://b/rt-8.tar.gz', rt);
  }

  it('.NET: the release metadata sha512, SDK and runtime merged into one root of our own, dotnet linked', async () => {
    const w = world();
    dotnetFixture(w);
    expect(await w.install('dotnet-sdk', dotnetUserInstall(undefined, ['10.0'], ['8.0']))).toMatchObject({
      ok: true,
    });
    const dn = join(w.root, 'dotnet');
    expect(existsSync(join(dn, 'sdk', '10.0.401', 'dotnet.dll'))).toBe(true);
    expect(existsSync(join(dn, 'shared', 'Microsoft.NETCore.App', '8.0.12', 'x.dll'))).toBe(true);
    expect(linkedInto(w.root, 'dotnet')).toBe(join(dn, 'dotnet'));
    // a second run downloads nothing: both are already there
    w.net.downloads.length = 0;
    expect(await w.install('dotnet-sdk', dotnetUserInstall(undefined, ['10.0'], ['8.0']))).toMatchObject({
      ok: true,
    });
    expect(w.net.downloads).toEqual([]);
  });

  it('.NET: into the chosen user root (~/.dotnet), which is not linked', async () => {
    const w = world();
    dotnetFixture(w);
    const chosen = join(w.home, '.dotnet');
    expect(await w.install('dotnet-sdk', dotnetUserInstall(chosen, ['10.0'], []))).toMatchObject({
      ok: true,
    });
    expect(existsSync(join(chosen, 'sdk', '10.0.401'))).toBe(true);
    expect(existsSync(join(w.root, 'bin', 'dotnet'))).toBe(false);
  });

  it('.NET: a bad sha512 is refused', async () => {
    const w = world();
    dotnetFixture(w, false);
    const r = await w.install('dotnet-sdk', dotnetUserInstall(undefined, ['10.0'], []));
    expect(r?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'dotnet');
  });

  function jdkFixture(w: ReturnType<typeof world>, good = true) {
    const arc = tarball({ 'jdk-17.0.12+7/bin/javac': '#!javac', 'jdk-17.0.12+7/bin/java': '#!java' });
    const hex = sha('sha256', arc);
    w.net.texts.set(
      'https://api.adoptium.net/v3/assets/latest/17/hotspot?os=linux&architecture=x64&image_type=jdk',
      JSON.stringify([
        {
          release_name: 'jdk-17.0.12+7',
          binary: {
            package: {
              name: 'OpenJDK17U-jdk_x64_linux_hotspot_17.0.12_7.tar.gz',
              link: 'https://github.com/adoptium/temurin17-binaries/releases/download/x/jdk.tar.gz',
              checksum: good ? hex : corrupt(hex),
            },
          },
        },
      ]),
    );
    w.net.files.set('https://github.com/adoptium/temurin17-binaries/releases/download/x/jdk.tar.gz', arc);
  }

  it('jdk: Adoptium package checksum, java/javac linked', async () => {
    const w = world();
    jdkFixture(w);
    expect(await w.install('jdk', jdkUserInstall, { javaMajor: '11' })).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'javac')).toBe(join(w.root, 'jdk', 'jdk-17.0.12+7', 'bin', 'javac'));
    linkedInto(w.root, 'java');
  });

  it('jdk: a bad checksum is refused', async () => {
    const w = world();
    jdkFixture(w, false);
    expect((await w.install('jdk', jdkUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'jdk');
  });

  function mavenFixture(w: ReturnType<typeof world>, good = true) {
    const v = MAVEN_VERSION;
    const arc = tarball({ [`apache-maven-${v}/bin/mvn`]: '#!mvn' });
    const url = `https://archive.apache.org/dist/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.tar.gz`;
    const hex = sha('sha512', arc);
    w.net.texts.set(`${url}.sha512`, good ? hex : corrupt(hex));
    w.net.files.set(url, arc);
  }

  it('maven: the .sha512 beside the file, mvn linked', async () => {
    const w = world();
    mavenFixture(w);
    expect(await w.install('maven', mavenUserInstall)).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'mvn')).toBe(join(w.root, 'maven', MAVEN_VERSION, 'bin', 'mvn'));
  });

  it('maven: a bad checksum is refused', async () => {
    const w = world();
    mavenFixture(w, false);
    expect((await w.install('maven', mavenUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'maven');
  });

  function gradleFixture(w: ReturnType<typeof world>, good = true) {
    const v = GRADLE_VERSION;
    const arc = zipball({ [`gradle-${v}/bin/gradle`]: '#!gradle' });
    const url = `https://services.gradle.org/distributions/gradle-${v}-bin.zip`;
    const hex = sha('sha256', arc);
    w.net.texts.set(`${url}.sha256`, good ? hex : corrupt(hex));
    w.net.files.set(url, arc);
  }

  it('gradle: the .sha256 beside the file, gradle linked', async () => {
    const w = world();
    gradleFixture(w);
    expect(await w.install('gradle', gradleUserInstall)).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'gradle')).toBe(join(w.root, 'gradle', GRADLE_VERSION, 'bin', 'gradle'));
  });

  it('gradle: a bad checksum is refused', async () => {
    const w = world();
    gradleFixture(w, false);
    expect((await w.install('gradle', gradleUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'gradle');
  });

  function goFixture(w: ReturnType<typeof world>, good = true) {
    const arc = tarball({ 'go/bin/go': '#!go', 'go/bin/gofmt': '#!gofmt' });
    const hex = sha('sha256', arc);
    w.net.texts.set(
      'https://go.dev/dl/?mode=json&include=all',
      JSON.stringify([
        { version: 'go1.24rc1', stable: false, files: [] },
        {
          version: 'go1.23.1',
          stable: true,
          files: [
            { filename: 'go1.23.1.src.tar.gz', os: '', arch: '', sha256: 'x', kind: 'source' },
            {
              filename: 'go1.23.1.linux-amd64.tar.gz',
              os: 'linux',
              arch: 'amd64',
              sha256: good ? hex : corrupt(hex),
              kind: 'archive',
            },
          ],
        },
      ]),
    );
    w.net.files.set('https://go.dev/dl/go1.23.1.linux-amd64.tar.gz', arc);
  }

  it('go: the sha256 from go.dev JSON, go and gofmt linked', async () => {
    const w = world();
    goFixture(w);
    expect(await w.install('go', goUserInstall, { goVersion: '1.22' })).toMatchObject({ ok: true });
    expect(linkedInto(w.root, 'go')).toBe(join(w.root, 'go', '1.23.1', 'bin', 'go'));
    linkedInto(w.root, 'gofmt');
  });

  it('go: a bad checksum is refused', async () => {
    const w = world();
    goFixture(w, false);
    expect((await w.install('go', goUserInstall))?.detail).toContain('checksum mismatch: refused');
    nothingInstalled(w.root, 'go');
  });

  function rustFixture(w: ReturnType<typeof world>, good = true) {
    const dir = tmp('aom-ui-arc-');
    writeFileSync(join(dir, 'rustup-init'), '#!rustup-init');
    const url = 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init';
    const hex = sha('sha256', join(dir, 'rustup-init'));
    w.net.texts.set(`${url}.sha256`, `${good ? hex : corrupt(hex)}  *rustup-init\n`);
    w.net.files.set(url, join(dir, 'rustup-init'));
  }

  it('rust: rustup-init.sha256 checked, run with CARGO_HOME/RUSTUP_HOME under the root, proxies linked', async () => {
    const w = world((s) => {
      const bin = join(s.env?.CARGO_HOME as string, 'bin');
      mkdirSync(bin, { recursive: true });
      for (const b of ['cargo', 'rustc', 'rustup']) writeFileSync(join(bin, b), '#!proxy');
    });
    rustFixture(w);
    expect(await w.install('rust', rustUserInstall)).toMatchObject({ ok: true });
    const step = w.exec.steps[0];
    expect(step?.args).toEqual(['-y', '--no-modify-path', '--profile', 'minimal']);
    expect(step?.env).toEqual({
      CARGO_HOME: join(w.root, 'rust', 'cargo'),
      RUSTUP_HOME: join(w.root, 'rust', 'rustup'),
    });
    expect(lstatSync(step?.cmd as string).mode & 0o111).not.toBe(0);
    for (const b of ['cargo', 'rustc', 'rustup']) linkedInto(w.root, b);
  });

  it('rust: a bad checksum is refused and rustup-init never runs', async () => {
    const w = world();
    rustFixture(w, false);
    expect((await w.install('rust', rustUserInstall))?.detail).toContain('checksum mismatch: refused');
    expect(w.exec.steps).toEqual([]);
    nothingInstalled(w.root, 'rustup-init');
  });

  it('android cmdline-tools: the pinned build and sha256 from developer.android.com', async () => {
    const w = world();
    const sdk = join(w.home, 'Android', 'Sdk');
    const plan = await androidCmdlineUserInstall(sdk)({
      params: {},
      platform: 'linux',
      arch: 'x64',
      root: w.root,
      fetchText: w.net.fetchText,
    });
    expect(plan?.archives[0]).toMatchObject({
      url: `https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS.build}_latest.zip`,
      checksum: { algo: 'sha256', hex: ANDROID_CMDLINE_TOOLS.files.linux.sha256 },
      into: { dir: join(sdk, 'cmdline-tools', 'latest'), mode: 'replace' },
    });
    const mac = await androidCmdlineUserInstall(sdk)({
      params: {},
      platform: 'darwin',
      arch: 'arm64',
      root: w.root,
      fetchText: w.net.fetchText,
    });
    expect(mac?.archives[0]?.url).toContain('commandlinetools-mac_arm64-');
  });

  it('android cmdline-tools: a download that does not match the pin is refused; a matching one lands in latest', async () => {
    const w = world();
    const sdk = join(w.home, 'Android', 'Sdk');
    const arc = zipball({ 'cmdline-tools/bin/sdkmanager': '#!sdkmanager' });
    w.net.files.set(
      `https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS.build}_latest.zip`,
      arc,
    );
    const bad = await w.install('android-cmdline-tools', androidCmdlineUserInstall(sdk));
    expect(bad?.detail).toContain('checksum mismatch: refused');
    expect(existsSync(join(sdk, 'cmdline-tools'))).toBe(false);
    // the same plan with the fixture's own checksum (the real pin cannot match a fixture)
    const plan = await androidCmdlineUserInstall(sdk)({
      params: {},
      platform: 'linux',
      arch: 'x64',
      root: w.root,
      fetchText: w.net.fetchText,
    });
    if (!plan?.archives[0]) throw new Error('no plan');
    plan.archives[0].checksum = { algo: 'sha256', hex: sha('sha256', arc) };
    await runUserInstall(plan, w.deps, () => {});
    expect(existsSync(join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))).toBe(true);
    expect(w.exec.steps[0]?.args[1]).toContain('--licenses');
  });

  it('every resolver in the tool table is one of these rows', () => {
    const rows = Object.values(TOOLS)
      .filter((t) => t.userInstall)
      .map((t) => t.id)
      .sort();
    expect(rows).toEqual(
      [
        'android-cmdline-tools',
        'dotnet-sdk',
        'go',
        'gradle',
        'jdk',
        'maven',
        'node',
        'node-bun',
        'python',
        'python-pipenv',
        'python-poetry',
        'python-uv',
        'rust',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------- the account rules

describe('user-space installs: account and folder rules', () => {
  it('uid 0 is refused before anything is fetched', async () => {
    const w = world();
    nodeFixtureMinimal(w);
    w.deps.uid = () => 0;
    const r = await w.install('node', nodeUserInstall);
    expect(r).toMatchObject({ ok: false });
    expect(r?.detail).toContain('never installs stack tools as root');
    expect(w.net.downloads).toEqual([]);
    expect(existsSync(w.root)).toBe(false);
  });

  it("a HOME that is not the runner account's passwd home is refused (never the main user's home)", async () => {
    const w = world();
    nodeFixtureMinimal(w);
    const other = tmp('aom-ui-other-');
    w.deps.home = () => other;
    const r = await w.install('node', nodeUserInstall);
    expect(r?.detail).toContain("is not the runner account's home");
    expect(existsSync(toolchainsRoot(other))).toBe(false);
    expect(existsSync(w.root)).toBe(false);
  });

  it('an install folder outside the account home is refused', async () => {
    const w = world();
    const outside = tmp('aom-ui-out-');
    const arc = tarball({ 'x/y': '1' });
    w.net.files.set('https://e/x.tar.gz', arc);
    await expect(
      runUserInstall(
        {
          archives: [
            {
              url: 'https://e/x.tar.gz',
              checksum: { algo: 'sha256', hex: sha('sha256', arc) },
              format: 'tar',
              tool: 'x',
              version: '1',
              into: { dir: outside, mode: 'merge' },
            },
          ],
        },
        w.deps,
        () => {},
      ),
    ).rejects.toThrow(/outside the runner's home/);
    expect(w.net.downloads).toEqual([]);
  });

  it('plain http is refused', async () => {
    const w = world();
    await expect(
      runUserInstall(
        {
          archives: [
            {
              url: 'http://e/x.tar.gz',
              checksum: { algo: 'sha256', hex: 'a' },
              format: 'tar',
              tool: 'x',
              version: '1',
            },
          ],
        },
        w.deps,
        () => {},
      ),
    ).rejects.toThrow(/not an https URL/);
  });

  it('a link in bin that is not ours (a file, or a link outside the root) is left alone', async () => {
    const w = world();
    nodeFixtureMinimal(w);
    mkdirSync(join(w.root, 'bin'), { recursive: true });
    writeFileSync(join(w.root, 'bin', 'npm'), 'mine');
    symlinkSync('/usr/bin/true', join(w.root, 'bin', 'npx'));
    expect(await w.install('node', nodeUserInstall)).toMatchObject({ ok: true });
    expect(readFileSync(join(w.root, 'bin', 'npm'), 'utf8')).toBe('mine');
    expect(readlinkSync(join(w.root, 'bin', 'npx'))).toBe('/usr/bin/true');
    linkedInto(w.root, 'node');
    expect(w.log.join('\n')).toContain('left');
  });

  it('a newer version replaces our own link', async () => {
    const w = world();
    mkdirSync(join(w.root, 'bin'), { recursive: true });
    mkdirSync(join(w.root, 'node', '20.0.0', 'bin'), { recursive: true });
    symlinkSync(join(w.root, 'node', '20.0.0', 'bin', 'node'), join(w.root, 'bin', 'node'));
    nodeFixtureMinimal(w);
    expect(await w.install('node', nodeUserInstall)).toMatchObject({ ok: true });
    expect(readlinkSync(join(w.root, 'bin', 'node'))).toBe(join(w.root, 'node', '22.4.0', 'bin', 'node'));
  });

  it('sumFromText reads SHASUMS lines and bare .sha256 files', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(sumFromText(`${a}  one.tgz\n${b} *two.tgz\n`, 'two.tgz')).toBe(b);
    expect(sumFromText(`${a}\n`)).toBe(a);
    expect(() => sumFromText(`${a}  one.tgz\n${b}  two.tgz\n`, 'three.tgz')).toThrow(/no checksum/);
  });
});

function nodeFixtureMinimal(w: ReturnType<typeof world>) {
  const file = 'node-v22.4.0-linux-x64.tar.xz';
  const arc = tarball(
    {
      'node-v22.4.0-linux-x64/bin/node': '#!node',
      'node-v22.4.0-linux-x64/bin/npm': '#!npm',
      'node-v22.4.0-linux-x64/bin/npx': '#!npx',
      'node-v22.4.0-linux-x64/bin/corepack': '#!corepack',
    },
    'J',
  );
  w.net.texts.set('https://nodejs.org/dist/index.json', JSON.stringify([{ version: 'v22.4.0', lts: 'Jod' }]));
  w.net.texts.set('https://nodejs.org/dist/v22.4.0/SHASUMS256.txt', `${sha('sha256', arc)}  ${file}\n`);
  w.net.files.set(`https://nodejs.org/dist/v22.4.0/${file}`, arc);
}
