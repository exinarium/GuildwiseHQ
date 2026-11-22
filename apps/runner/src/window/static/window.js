// Approvals on this computer (easy-runner-setup): the page script. No framework, no inline script, no HTML parsing: every
// string from the runner (organization, helper and repository names, held summaries and details) is set as text [S2].
// The browser key is a non-extractable ECDSA P-256 key in IndexedDB; the session token lives only in this script's
// memory and is never stored [B1].

(() => {
  const S = {
    token: null,
    key: null,
    hello: null,
    state: null,
    dialogOpen: false,
    timer: null,
    pairTimer: null,
  };

  // ------------------------------------------------------------ DOM (text only)
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = String(v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled') e[k] = true;
      else e.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return e;
  }
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  };
  const badge = (text, tone) => h('span', { class: `badge ${tone || ''}`, text });
  const row = (label, ...value) =>
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'label', text: label }),
      h('span', { class: 'value' }, ...value),
    );

  function commandBox(command) {
    const copy = h('button', { class: 'btn small', type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => {
      const done = () => {
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(command).then(done, () => {});
    });
    return h('div', { class: 'cmd' }, h('code', { text: command }), copy);
  }

  // ------------------------------------------------------------ header
  function headerText(info) {
    return `Approvals on this computer · instance ${info.instance} · ${info.serverHost}`;
  }
  function renderHeader(info) {
    const where = document.getElementById('where');
    if (where) where.textContent = headerText(info);
    const top = document.getElementById('top');
    if (top) top.classList.toggle('warn', !!info.warn);
    document.title = `Approvals · ${info.instance}`;
  }

  // ------------------------------------------------------------ runner calls
  async function api(method, path, body) {
    const headers = {};
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    return { status: r.status, data: data || {} };
  }

  // ------------------------------------------------------------ the browser key (IndexedDB, not extractable)
  function db() {
    return new Promise((resolve, reject) => {
      const q = indexedDB.open('gw-approvals', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('keys');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('keys', mode);
      const q = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(q.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  async function loadKey() {
    try {
      return (await idb('readonly', (s) => s.get('device'))) || null;
    } catch {
      return null;
    }
  }
  async function makeKey() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const rec = {
      privateKey: kp.privateKey,
      spki: b64(spki),
      keyHash: hex(await crypto.subtle.digest('SHA-256', spki)),
    };
    await idb('readwrite', (s) => s.put(rec, 'device'));
    return rec;
  }

  /** A fresh challenge, signed with the browser key, gives a session (memory only). */
  async function signIn() {
    if (!S.key) return false;
    const ch = await api('GET', '/api/challenge');
    if (ch.status !== 200 || !S.hello) return false;
    const text = `gw-approvals|${S.hello.instance}|${S.hello.port}|${ch.data.nonce}`;
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      S.key.privateKey,
      new TextEncoder().encode(text),
    );
    const r = await api('POST', '/api/session', {
      keyHash: S.key.keyHash,
      nonce: ch.data.nonce,
      sig: b64(sig),
    });
    if (r.status !== 200) return false;
    S.token = r.data.token;
    return true;
  }

  // ------------------------------------------------------------ sign-in page (pairing)
  function showSignIn(note) {
    stopTimers();
    S.token = null;
    const app = document.getElementById('app');
    const steps = h('div', { class: 'steps' });
    const start = h('button', { class: 'btn primary', type: 'button', text: 'Pair this browser' });
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        if (!S.key) S.key = await makeKey();
        const r = await api('POST', '/api/pair', { spki: S.key.spki });
        if (r.status !== 200) throw new Error(r.data.error || `error ${r.status}`);
        steps.replaceChildren(...pairSteps(r.data));
        S.pairTimer = setInterval(async () => {
          if (await signIn()) showMain();
        }, 3000);
      } catch (err) {
        start.disabled = false;
        steps.replaceChildren(h('p', { class: 'error', text: `Could not start pairing: ${err.message}` }));
      }
    });
    app.replaceChildren(
      h(
        'section',
        { class: 'panel narrow' },
        h('h1', { text: 'Pair this browser' }),
        note ? h('p', { class: 'notice', text: note }) : null,
        h('p', {
          text: 'This page can change what this computer allows. So that only you can use it, each browser is paired once by typing one command on this computer.',
        }),
        start,
        steps,
      ),
    );
  }
  function pairSteps(p) {
    return [
      h(
        'ol',
        { class: 'list' },
        h('li', null, 'Copy this command:', commandBox(p.command)),
        h('li', {
          text: 'Paste it into a terminal on this computer and press Enter. Type yes when it asks.',
        }),
        h('li', { text: 'This page opens by itself. The code works for 10 minutes.' }),
      ),
      h(
        'p',
        { class: 'muted' },
        'Fingerprint ',
        h('strong', { text: p.fingerprint }),
        ' (the terminal shows the same).',
      ),
    ];
  }

  // ------------------------------------------------------------ main page
  function renderStatus(st) {
    const servers = st.servers.length
      ? st.servers.map((s) =>
          h(
            'span',
            { class: 'server' },
            `${s.host} `,
            s.connected ? badge('Connected', 'ok') : badge('Not connected', 'warn'),
          ),
        )
      : [h('span', { text: 'Not paired with a server' })];
    return h(
      'section',
      { class: 'panel' },
      h('h2', { text: 'This computer' }),
      st.policyError
        ? h('p', {
            class: 'error',
            text: `The local settings file is not valid, so the safe defaults apply: ${st.policyError}`,
          })
        : null,
      row('Runner version', st.version),
      row('Guildwise server', ...servers),
      row('Instance', st.instance),
      row('Runner account', st.runnerUser),
      row('Docker', st.docker),
      row(
        'Working now',
        st.shifts.length
          ? h(
              'ul',
              { class: 'plain' },
              st.shifts.map((s) => h('li', { text: s.title })),
            )
          : 'Nothing is running',
      ),
      row(
        'Setup',
        st.setupDone
          ? badge('Finished', 'ok')
          : h(
              'span',
              null,
              badge('Not finished', 'warn'),
              ' Run this on this computer: ',
              commandBox(st.setupCommand),
            ),
      ),
    );
  }

  function renderWaiting(items) {
    const list = items.map((it) =>
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('strong', { text: it.what }), badge(it.kind, '')),
        h('p', { text: it.summary }),
        it.note ? h('p', { class: 'muted', text: it.note }) : null,
        h('p', { class: 'muted', text: `Asked ${when(it.createdAt)}. Waits until ${when(it.expiresAt)}.` }),
        it.terminalOnly
          ? h(
              'div',
              null,
              h('p', { text: 'This one is approved in a terminal on this computer:' }),
              commandBox(it.command),
            )
          : h(
              'div',
              { class: 'actions' },
              h('button', {
                class: 'btn primary',
                type: 'button',
                text: 'Look and approve',
                onclick: () => confirmHeld(it, true),
              }),
              h('button', {
                class: 'btn',
                type: 'button',
                text: 'Deny',
                onclick: () => confirmHeld(it, false),
              }),
            ),
      ),
    );
    return h(
      'section',
      { class: 'panel' },
      h('h2', { text: 'Waiting for your yes' }),
      list.length ? list : h('p', { class: 'muted', text: 'Nothing is waiting for your yes.' }),
    );
  }

  function check(label, sub, checked, onChange, disabled) {
    const box = h('input', { type: 'checkbox', checked, disabled });
    box.addEventListener('change', () => onChange(box));
    return h(
      'label',
      { class: `check${disabled ? ' off' : ''}` },
      box,
      h('span', null, h('span', { text: label }), sub ? h('small', { text: sub }) : null),
    );
  }
  /** A checkbox change asks first; a cancel puts the box back. */
  const toggle = (question, change) => (box) => {
    const want = box.checked;
    box.checked = !want;
    ask(question(want), null, want ? 'Yes, allow' : 'Yes, turn off', async () => send(change(want)));
  };

  function renderAllows(a) {
    const devops = a.devops.map((o) => {
      const helper = o.agentName ? `DevOps helper "${o.agentName}"` : 'its DevOps helper';
      return check(
        `${o.orgName}: let ${helper} work outside the safety box`,
        o.agentId ? `The server says you are ${o.role} there.` : 'No DevOps helper on this computer yet.',
        o.granted,
        toggle(
          (on) =>
            on
              ? `Let ${o.orgName}'s ${helper} install tools and run commands on this computer outside the safety box?`
              : `Stop ${o.orgName}'s ${helper} from working outside the safety box here?`,
          (on) => ({ action: on ? 'devops.grant' : 'devops.revoke', orgId: o.orgId }),
        ),
        !o.agentId,
      );
    });
    const repos = a.repos.map((r) =>
      check(
        `Let "${r.name}" run its own install scripts`,
        `${r.url} · they run outside the safety box`,
        r.allowed,
        toggle(
          (on) =>
            on
              ? `Let "${r.name}" run its own install scripts on this computer?`
              : `Stop "${r.name}" from running install scripts here?`,
          (on) => ({ action: 'repo.scripts', url: r.url, allow: on }),
        ),
      ),
    );
    const pk = a.passkeys;
    return h(
      'section',
      { class: 'panel' },
      h('h2', { text: 'What this computer allows' }),
      h('h3', { text: 'DevOps helpers' }),
      devops.length
        ? devops
        : h('p', { class: 'muted', text: 'No organization offers a DevOps helper to this computer yet.' }),
      check(
        'Let DevOps tasks from the website start without asking me',
        'Safe choice: off, so each task waits for your yes.',
        a.devopsRequests === 'auto',
        toggle(
          (on) =>
            on
              ? 'Let DevOps tasks start without asking you first?'
              : 'Ask you first before each DevOps task?',
          (on) => ({ action: 'devops.requests', mode: on ? 'auto' : 'ask' }),
        ),
      ),
      h('h3', { text: 'Install scripts' }),
      repos.length
        ? repos
        : h('p', { class: 'muted', text: 'No code project is offered to this computer yet.' }),
      h('h3', { text: 'Publishing your apps' }),
      check(
        'Allow publishing from this computer (each publish still asks you)',
        null,
        a.deploy.mode === 'ask',
        toggle(
          (on) =>
            on
              ? 'Allow publishing from this computer? Each publish still waits for your yes.'
              : 'Never publish from this computer?',
          (on) => ({ action: 'deploy.mode', mode: on ? 'ask' : 'off' }),
        ),
      ),
      check(
        'Pinned publishes must also match the exact version',
        'Safer: a new version asks again.',
        a.deploy.pinCommit,
        toggle(
          (on) =>
            on
              ? 'Make pinned publishes ask again for every new version?'
              : 'Let pinned publishes run for any new version?',
          (on) => ({ action: 'deploy.pinCommit', on }),
        ),
      ),
      a.deploy.pins
        ? h(
            'div',
            { class: 'actions' },
            h('span', {
              class: 'muted',
              text: `${a.deploy.pins} pinned publish${a.deploy.pins === 1 ? '' : 'es'} run without asking. `,
            }),
            h('button', {
              class: 'btn small',
              type: 'button',
              text: 'Forget them',
              onclick: () =>
                ask('Forget every pinned publish? Each will ask again.', null, 'Yes, forget', () =>
                  send({ action: 'deploy.unpin', hash: 'all' }),
                ),
            }),
          )
        : null,
      a.formatterPins.length ? h('h3', { text: 'Approved release formats' }) : null,
      a.formatterPins.map((f) =>
        h(
          'div',
          { class: 'actions' },
          h('code', { text: f.slice(0, 16) }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Remove',
            onclick: () =>
              ask('Remove this approved release format?', null, 'Yes, remove', () =>
                send({ action: 'formatter.pin', hash: f, add: false }),
              ),
          }),
        ),
      ),
      h('h3', { text: 'Passkeys' }),
      pk.trusted.length || pk.offered.length
        ? null
        : h('p', { class: 'muted', text: 'No passkey is trusted or offered.' }),
      pk.trusted.map((k) =>
        h(
          'div',
          { class: 'actions' },
          h('span', { text: `${k.name || 'Passkey'} (trusted)` }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Remove',
            onclick: () =>
              ask(
                `Stop trusting passkey "${k.name || k.credentialId.slice(0, 12)}"?`,
                null,
                'Yes, remove',
                () => send({ action: 'passkey.remove', credentialId: k.credentialId }),
              ),
          }),
        ),
      ),
      pk.offered.map((k) =>
        h(
          'div',
          { class: 'actions' },
          h('span', { text: `${k.name} (offered by the server, not trusted)` }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Trust',
            onclick: () =>
              ask(
                `Trust passkey "${k.name}" (made ${when(k.createdAt)})? It can then approve a pinned publish at a new version and a recipe change.`,
                null,
                'Yes, trust',
                () => send({ action: 'passkey.trust', credentialId: k.credentialId }),
              ),
          }),
        ),
      ),
      (a.vaultRemotes || []).length ? h('h3', { text: 'Online locations for shared notes' }) : null,
      (a.vaultRemotes || []).map((v) =>
        h(
          'div',
          { class: 'actions' },
          h('span', { text: `${v.remote} (approved; set-up with it runs without asking)` }),
          h('button', {
            class: 'btn small',
            type: 'button',
            text: 'Forget',
            onclick: () =>
              ask(
                `Forget ${v.remote}? The next set-up that uses it waits for your yes again.`,
                null,
                'Yes, forget',
                () => send({ action: 'vault.forget', vaultId: v.vaultId, remote: v.remote }),
              ),
          }),
        ),
      ),
      h('h3', { text: 'Changed only in a terminal' }),
      h(
        'div',
        { class: 'ro' },
        a.readOnly.map((r) =>
          h(
            'div',
            { class: 'ro-row' },
            h('span', { class: 'label', text: r.label }),
            h('span', { class: 'value', text: r.value }),
            h('code', { class: 'small', text: r.command }),
          ),
        ),
      ),
    );
  }

  function renderState(state) {
    return [renderStatus(state.status), renderWaiting(state.waiting), renderAllows(state.allows)];
  }

  // ------------------------------------------------------------ confirm dialog
  function ask(question, detail, yes, onYes, extra) {
    const dlg = h('dialog', { class: 'dialog' });
    const close = () => {
      S.dialogOpen = false;
      dlg.close();
      dlg.remove();
    };
    const err = h('p', { class: 'error' });
    const yesBtn = h('button', { class: 'btn primary', type: 'button', text: yes });
    yesBtn.addEventListener('click', async () => {
      yesBtn.disabled = true;
      const msg = await onYes();
      if (msg) {
        err.textContent = msg;
        yesBtn.disabled = false;
      } else {
        close();
        refresh();
      }
    });
    dlg.append(
      h('p', { class: 'q', text: question }),
      detail ? h('pre', { class: 'detail', text: detail }) : null,
      extra || null,
      err,
      h(
        'div',
        { class: 'actions' },
        yesBtn,
        h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: close }),
      ),
    );
    dlg.addEventListener('cancel', () => {
      S.dialogOpen = false;
      dlg.remove();
    });
    document.body.appendChild(dlg);
    S.dialogOpen = true;
    dlg.showModal();
  }
  function confirmHeld(it, approve) {
    if (!approve) {
      ask(`Deny "${it.what}"? It will not run.`, it.detail, 'Yes, deny', () =>
        send({ action: 'held.deny', id: it.id }),
      );
      return;
    }
    const pin = it.canPin ? h('input', { type: 'checkbox' }) : null;
    const extra = pin
      ? h(
          'label',
          { class: 'check' },
          pin,
          h('span', { text: 'Also allow unchanged re-publishes of this app without asking (pin)' }),
        )
      : null;
    ask(
      `${it.what}: run exactly this?`,
      it.detail,
      'Yes, approve',
      () => send({ action: 'held.approve', id: it.id, ...(pin?.checked ? { pin: true } : {}) }),
      extra,
    );
  }
  /** Sends one change; returns an error text, or null when it worked. */
  async function send(change) {
    let r = await api('POST', '/api/change', change);
    if (r.status === 401 && (await signIn())) r = await api('POST', '/api/change', change);
    if (r.status === 401) {
      showSignIn('Signed out. Pair or sign in again.');
      return null;
    }
    return r.status === 200 ? null : r.data.error || `error ${r.status}`;
  }

  // ------------------------------------------------------------ refresh
  async function refresh() {
    if (S.dialogOpen) return;
    let r = await api('GET', '/api/state');
    if (r.status === 401 && (await signIn())) r = await api('GET', '/api/state');
    if (r.status === 401) return showSignIn('This browser is not signed in any more. Pair it again.');
    if (r.status !== 200) return;
    S.state = r.data;
    renderHeader(r.data.header);
    document.getElementById('app').replaceChildren(...renderState(r.data));
  }
  function stopTimers() {
    clearInterval(S.timer);
    clearInterval(S.pairTimer);
    S.timer = null;
    S.pairTimer = null;
  }
  function showMain() {
    stopTimers();
    refresh();
    S.timer = setInterval(refresh, 5000);
  }

  async function start() {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const theme = () => document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    theme();
    mq.addEventListener('change', theme);
    const hello = await api('GET', '/api/hello');
    if (hello.status !== 200) {
      document
        .getElementById('app')
        .replaceChildren(
          h('p', { class: 'error', text: 'Open this page at the 127.0.0.1 address the runner shows.' }),
        );
      return;
    }
    S.hello = hello.data;
    renderHeader(S.hello);
    S.key = await loadKey();
    if (S.key && (await signIn())) showMain();
    else showSignIn(S.key ? 'This browser is not paired with this runner (or it was forgotten).' : null);
  }

  // for the rendering test (a minimal DOM): the renderers, without starting anything
  self.gwApprovals = { renderState, headerText, pairSteps };
  if (typeof document.getElementById === 'function' && document.getElementById('app')) start();
})();
