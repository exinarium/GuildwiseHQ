import type { CloudAuthMode } from '@aom/shared';
import { CODESPACES_MACHINES, estimateMonthlyCost, officeHoursPerMonth } from '@aom/shared';
import { useState } from 'react';
import {
  useCloudWorkstations,
  useCodespaceMachines,
  useConnectGithub,
  useCreateCodespace,
  useCreateVps,
  useDevcontainer,
  useGithubConnection,
} from '../../api/queries/cloud.ts';
import { copyText } from '../../lib/secure.ts';
import { Button, Callout, ErrorBox, Select, TextArea, TextInput, useToast } from '../ui.tsx';

/** Claude sign-in choice shared by both cloud forms (decision C3): the customer's API key by default. */
function AuthChoice({ value, onChange }: { value: CloudAuthMode; onChange: (v: CloudAuthMode) => void }) {
  return (
    <fieldset className="flex flex-col gap-2" data-testid="cloud-auth">
      <legend className="text-sm font-medium text-fg">How do the agents sign in to Claude?</legend>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="radio"
          name="cloud-auth"
          checked={value === 'api_key'}
          onChange={() => onChange('api_key')}
        />
        <span>
          <strong>With my own Anthropic API key</strong> (recommended). You pay for what the agents use. The
          key stays on that machine; Guildwise never receives it.
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="radio"
          name="cloud-auth"
          checked={value === 'subscription'}
          onChange={() => onChange('subscription')}
        />
        <span>
          <strong>With my Claude subscription</strong>. Allowed, for individual use only.
        </span>
      </label>
      {value === 'subscription' && (
        <Callout tone="warning" data-testid="individual-use-warning">
          A Claude subscription is meant for one person's own use. Many agents working in parallel can run
          into its limits, and Anthropic's terms apply to how you use it. For a team, use an API key.
        </Callout>
      )}
    </fieldset>
  );
}

export function AddVpsForm({ onDone }: { onDone: () => void }) {
  const create = useCreateVps();
  const toast = useToast();
  const existing = useCloudWorkstations();
  const [f, setF] = useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    secret: 'password' as 'password' | 'key',
    password: '',
    privateKey: '',
    passphrase: '',
    price: '',
  });
  const [auth, setAuth] = useState<CloudAuthMode>('api_key');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const taken = existing.data?.cloudWorkstations.some((c) => c.projectId === null);
  const price = f.price === '' ? null : Number(f.price);
  const est = estimateMonthlyCost({ provider: 'ssh', monthlyPriceUsd: price });
  const ready = f.name && f.host && f.username && (f.secret === 'password' ? f.password : f.privateKey);
  const submit = () =>
    create.mutate(
      {
        name: f.name.trim(),
        host: f.host.trim(),
        port: Number(f.port) || 22,
        username: f.username.trim(),
        ...(f.secret === 'password'
          ? { password: f.password }
          : { privateKey: f.privateKey, ...(f.passphrase ? { passphrase: f.passphrase } : {}) }),
        projectId: null,
        authMode: auth,
        monthlyPriceUsd: price,
      },
      {
        onSuccess: () => {
          toast.success('Installing. This takes a few minutes.');
          onDone();
        },
      },
    );
  return (
    <div className="flex flex-col gap-4" data-testid="add-vps">
      <p className="text-sm text-muted">
        Any Linux server you can reach with SSH works (Ubuntu or Debian is easiest). Guildwise logs in once,
        installs the runner and pairs it. The password or key is used for that one login and is not stored.
      </p>
      {taken && (
        <Callout tone="warning">
          This organization already has a cloud workstation. An organization gets one by default; remove the
          existing one first.
        </Callout>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Name"
          value={f.name}
          maxLength={80}
          onChange={set('name')}
          placeholder="Studio server"
        />
        <TextInput
          label="Host name or IP address"
          value={f.host}
          onChange={set('host')}
          placeholder="203.0.113.9"
        />
        <TextInput label="SSH port" type="number" value={f.port} onChange={set('port')} />
        <TextInput
          label="User"
          value={f.username}
          onChange={set('username')}
          hint="A normal user is safer than root. Needs sudo rights to install packages."
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">Log in with</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={f.secret === 'password'}
              onChange={() => setF({ ...f, secret: 'password' })}
            />
            A password
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={f.secret === 'key'} onChange={() => setF({ ...f, secret: 'key' })} />
            An SSH key
          </label>
        </div>
        {f.secret === 'password' ? (
          <TextInput
            label="Password"
            type="password"
            autoComplete="off"
            value={f.password}
            onChange={set('password')}
          />
        ) : (
          <>
            <TextArea
              label="Private key"
              autoComplete="off"
              spellCheck={false}
              rows={4}
              value={f.privateKey}
              onChange={set('privateKey')}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
            <TextInput
              label="Key passphrase (if it has one)"
              type="password"
              autoComplete="off"
              value={f.passphrase}
              onChange={set('passphrase')}
            />
          </>
        )}
      </fieldset>
      <TextInput
        label="What the server costs a month in US dollars (optional)"
        type="number"
        min={0}
        value={f.price}
        onChange={set('price')}
        hint={est.basis}
      />
      <AuthChoice value={auth} onChange={setAuth} />
      <ErrorBox error={create.error} />
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!ready || create.isPending || !!taken}
          onClick={submit}
          data-testid="vps-install"
        >
          Install and pair
        </Button>
      </div>
    </div>
  );
}

export function AddCodespaceForm({ onDone }: { onDone: () => void }) {
  const gh = useGithubConnection();
  const connect = useConnectGithub();
  const create = useCreateCodespace();
  const existing = useCloudWorkstations();
  const toast = useToast();
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [machine, setMachine] = useState('basicLinux32gb');
  const [auth, setAuth] = useState<CloudAuthMode>('api_key');
  const [stacks, setStacks] = useState('node');
  const connected = gh.data?.connected === true;
  const machines = useCodespaceMachines(repo, connected);
  const dev = useDevcontainer(stacks, connected);
  const taken = existing.data?.cloudWorkstations.some((c) => c.projectId === null);
  const est = estimateMonthlyCost({
    provider: 'codespaces',
    machine,
    hoursPerMonth: officeHoursPerMonth(null),
  });
  const options = machines.data?.length
    ? machines.data.map((m) => ({ name: m.name, label: m.displayName }))
    : CODESPACES_MACHINES.map((m) => ({ name: m.name, label: m.label }));
  const missingFile = create.error && (create.error as { code?: string }).code === 'devcontainer_missing';
  return (
    <div className="flex flex-col gap-4" data-testid="add-codespace">
      <Callout tone="info">
        You pay GitHub for a Codespace, not Guildwise. It works for repositories on GitHub and sleeps when
        idle. It cannot run Docker, so you still need a workstation or a VPS to deploy Docker images.
      </Callout>
      {taken && (
        <Callout tone="warning">
          This organization already has a cloud workstation. Remove the existing one first.
        </Callout>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">1. Connect GitHub</h3>
        {connected ? (
          <p className="text-sm text-fg" data-testid="github-connected">
            Connected as <strong>{gh.data?.login}</strong>.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Create a token on GitHub (Settings, Developer settings, Personal access tokens) with the{' '}
              <code className="rounded bg-sunken px-1">codespace</code> scope and paste it. Guildwise keeps it
              encrypted to wake and stop your codespace.
            </p>
            <TextInput
              label="GitHub token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <ErrorBox error={connect.error} />
            <div>
              <Button
                variant="secondary"
                disabled={token.length < 10 || connect.isPending}
                onClick={() => connect.mutate(token, { onSuccess: () => setToken('') })}
              >
                Connect GitHub
              </Button>
            </div>
          </>
        )}
      </section>
      {connected && (
        <>
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-fg">2. Pick the repository and machine</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              <TextInput
                label="Repository (owner/name)"
                value={repo}
                onChange={(e) => setRepo(e.target.value.trim())}
                placeholder="acme/website"
              />
              <Select label="Machine type" value={machine} onChange={(e) => setMachine(e.target.value)}>
                {options.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div className="text-sm text-muted" data-testid="codespace-estimate">
                <p className="font-medium text-fg">About ${est.monthlyUsd.toFixed(2)} a month</p>
                <p className="text-xs">{est.basis}</p>
              </div>
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-fg">3. Add this file to the repository</h3>
            <p className="text-sm text-muted">
              It tells the Codespace to install the Guildwise runner and pair itself. It holds no password or
              key. Commit it, then continue.
            </p>
            <TextInput
              label="Tools the project needs (comma separated: node, python, dotnet, java ...)"
              value={stacks}
              onChange={(e) => setStacks(e.target.value)}
            />
            {dev.data && (
              <>
                <p className="text-xs text-subtle">
                  Save as <code>{dev.data.path}</code>
                </p>
                <pre
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable
                  tabIndex={0}
                  data-testid="devcontainer"
                  className="max-h-48 overflow-auto rounded-control bg-side p-2.5 font-mono text-xs text-side-strong"
                >
                  {dev.data.content}
                </pre>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () =>
                      toast.success((await copyText(dev.data.content)) ? 'Copied' : 'Could not copy')
                    }
                  >
                    Copy file
                  </Button>
                </div>
              </>
            )}
            <p className="text-sm text-muted">
              Add your Anthropic API key as a Codespaces secret named <code>ANTHROPIC_API_KEY</code> (GitHub,
              Settings, Codespaces, Secrets) so the agents can sign in.
            </p>
          </section>
          <AuthChoice value={auth} onChange={setAuth} />
          {missingFile && (
            <Callout tone="warning">
              The repository does not have the file yet. Add it, then try again.
            </Callout>
          )}
          <ErrorBox error={missingFile ? null : create.error} />
          <div className="flex justify-end">
            <Button
              variant="primary"
              data-testid="codespace-create"
              disabled={!name || !repo || create.isPending || !!taken}
              onClick={() =>
                create.mutate(
                  {
                    name: name.trim(),
                    repo,
                    machine,
                    projectId: null,
                    authMode: auth,
                    devcontainerPath: '.devcontainer/guildwise/devcontainer.json',
                  },
                  {
                    onSuccess: () => {
                      toast.success('GitHub is creating the codespace');
                      onDone();
                    },
                  },
                )
              }
            >
              Create the codespace
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
