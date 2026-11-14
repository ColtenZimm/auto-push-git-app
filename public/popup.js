'use strict';
// All dynamic text is inserted with textContent / value, never innerHTML.
const token = new URLSearchParams(location.search).get('t') || '';
const cardsEl = document.getElementById('cards');
const emptyEl = document.getElementById('empty');
const subtitleEl = document.getElementById('subtitle');
const cards = new Map(); // prompt id -> { el, state }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-autopush-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok && !data.message) data.message = data.error || `Request failed (${res.status})`;
  return data;
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const KIND = { added: 'new', modified: 'changed', deleted: 'deleted', renamed: 'renamed', untracked: 'new', conflict: 'conflict' };
const isSimple = (p) => p.mode === 'simple';

function defaultBranchName(p) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `feature/${p.repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`;
}

function buildCard(p, snoozeMinutes) {
  const state = { checked: new Set(p.files.map((f) => f.path)), known: new Set(p.files.map((f) => f.path)), paths: '', busy: false };
  const el = h('section', { class: 'card', 'data-id': p.id });
  cards.set(p.id, { el, state, p, snoozeMinutes });
  renderCard(p.id);
  return el;
}

function renderCard(id) {
  const c = cards.get(id);
  const { el, state, p, snoozeMinutes } = c;
  const prevMsg = el.querySelector('textarea')?.value ?? '';
  const prevBranch = el.querySelector('input[name=branch]')?.value ?? '';
  const prevSnooze = el.querySelector('select')?.value ?? '';
  const result = el.querySelector('.msg')?.cloneNode(true);
  el.replaceChildren();

  const simple = isSimple(p);
  const needsBranch = !simple && p.branchProtected;
  const title = h('h2', {}, h('span', { text: p.repoName }));
  if (!simple) title.append(h('span', { class: 'chip' + (p.branchProtected ? ' warn' : ''), text: p.branch ?? 'detached HEAD' }));
  if (p.ahead > 0 && !simple) title.append(h('span', { class: 'chip', text: `${p.ahead} unpushed` }));
  el.append(title);
  el.append(h('p', { class: 'muted', text: simple
    ? `${p.files.length} file${p.files.length === 1 ? ' has' : 's have'} unsaved changes.`
    : `${p.files.length} changed file${p.files.length === 1 ? '' : 's'} not yet committed.` }));

  const list = h('ul', { class: 'files' });
  for (const f of p.files) {
    const cb = h('input', { type: 'checkbox', id: `${id}-${f.path}`, ...(state.checked.has(f.path) ? { checked: true } : {}) });
    cb.checked = state.checked.has(f.path);
    cb.addEventListener('change', () => { cb.checked ? state.checked.add(f.path) : state.checked.delete(f.path); updateButtons(id); });
    list.append(h('li', {}, cb, h('label', { for: `${id}-${f.path}`, text: f.path }), h('span', { class: 'kind', text: KIND[f.kind] || f.kind })));
  }
  el.append(list);

  if (needsBranch) {
    el.append(h('label', { class: 'field', for: `br-${id}`, text: 'New branch name' }));
    el.append(h('input', { type: 'text', name: 'branch', id: `br-${id}`, value: prevBranch || defaultBranchName(p), autocomplete: 'off' }));
    el.append(h('p', { class: 'help', text: `"${p.branch ?? 'This branch'}" is protected, so your changes go on a new branch.` }));
  }

  el.append(h('label', { class: 'field', for: `msg-${id}`, text: simple ? 'What did you change?' : 'Commit message' }));
  const ta = h('textarea', { id: `msg-${id}`, maxlength: '10000', placeholder: simple ? 'e.g. Updated the Q3 onboarding checklist' : 'Short summary on the first line' });
  ta.value = prevMsg;
  ta.addEventListener('input', () => updateButtons(id));
  el.append(ta);

  const row = h('div', { class: 'row' });
  const sel = h('select', { 'aria-label': 'Remind me later', style: 'width:auto' });
  sel.append(h('option', { value: '', text: 'Remind me in…' }));
  for (const m of snoozeMinutes) sel.append(h('option', { value: String(m), text: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` }));
  sel.value = prevSnooze;
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    await act(id, '/api/snooze', { minutes: Number(sel.value) });
  });

  if (simple) {
    row.append(h('button', { class: 'primary', 'data-act': 'push', onclick: () => commit(id, true), text: 'Save and share' }));
  } else {
    row.append(h('button', { class: 'primary', 'data-act': 'push', onclick: () => commit(id, true), text: 'Commit & push' }));
    row.append(h('button', { 'data-act': 'commit', onclick: () => commit(id, false), text: 'Commit' }));
  }
  row.append(h('span', { class: 'spacer' }), sel, h('button', { onclick: () => act(id, '/api/dismiss', {}), text: 'Not now' }));
  el.append(row);
  if (result) el.append(result);
  updateButtons(id);
}

function updateButtons(id) {
  const c = cards.get(id);
  if (!c) return;
  const ready = c.state.checked.size > 0 && (c.el.querySelector('textarea')?.value.trim().length ?? 0) > 0 && !c.state.busy;
  for (const b of c.el.querySelectorAll('button[data-act]')) b.disabled = !ready;
}

function showResult(id, kind, text, url) {
  const c = cards.get(id);
  if (!c) return;
  c.el.querySelector('.msg')?.remove();
  const box = h('div', { class: `msg ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, h('span', { text }));
  if (url && /^https?:\/\//.test(url)) {
    box.append(document.createTextNode(' '), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View pull request' }));
  }
  c.el.append(box);
}

// The card disappears once its changes are saved, so keep the outcome visible in a banner.
const bannerEl = document.getElementById('banner');
let bannerTimer = null;
function showBanner(text, url) {
  bannerEl.replaceChildren(h('span', { text }));
  if (url && /^https?:\/\//.test(url)) {
    bannerEl.append(document.createTextNode(' '), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'View pull request' }));
  }
  bannerEl.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.add('hidden'), 30000);
}

async function commit(id, push) {
  const c = cards.get(id);
  if (!c || c.state.busy) return;
  c.state.busy = true;
  updateButtons(id);
  const body = {
    id,
    push,
    message: c.el.querySelector('textarea').value,
    files: [...c.state.checked],
    newBranch: c.el.querySelector('input[name=branch]')?.value || undefined,
  };
  const r = await api('/api/commit', body);
  c.state.busy = false;
  if (r.ok) {
    showResult(id, 'ok', r.message, r.pullRequestUrl);
    showBanner(r.message, r.pullRequestUrl);
    c.el.querySelector('textarea').value = '';
    setTimeout(refresh, 800);
  } else {
    showResult(id, 'err', r.message || 'Something went wrong.');
  }
  updateButtons(id);
}

async function act(id, path, extra) {
  const r = await api(path, { id, ...extra });
  if (r.error) showResult(id, 'err', r.error);
  refresh();
}

async function refresh() {
  let s;
  try {
    s = await api('/api/state');
  } catch {
    subtitleEl.textContent = 'Lost contact with the background service.';
    return;
  }
  if (!s.prompts) {
    subtitleEl.textContent = s.message || 'This window is no longer authorised. Close it.';
    return;
  }
  const live = new Set(s.prompts.map((p) => p.id));
  for (const [id, c] of cards) if (!live.has(id)) { c.el.remove(); cards.delete(id); }
  for (const p of s.prompts) {
    const existing = cards.get(p.id);
    if (!existing) {
      cardsEl.append(buildCard(p, s.snoozeMinutes));
    } else {
      const sig = p.files.map((f) => f.path + f.kind).join('|');
      if (sig !== existing.state.paths) {
        existing.state.paths = sig;
        existing.p = p;
        const paths = new Set(p.files.map((f) => f.path));
        existing.state.checked = new Set([...existing.state.checked].filter((x) => paths.has(x)));
        // Newly appeared files default to checked; files the user already saw keep their choice.
        for (const f of p.files) {
          if (!existing.state.known.has(f.path)) existing.state.checked.add(f.path);
        }
        existing.state.known = paths;
        renderCard(p.id);
      }
    }
    const c = cards.get(p.id);
    if (c && !c.state.paths) c.state.paths = p.files.map((f) => f.path + f.kind).join('|');
  }
  emptyEl.classList.toggle('hidden', s.prompts.length > 0);
  subtitleEl.textContent = s.prompts.length
    ? (s.mode === 'simple' ? 'Save your changes so your team can see them.' : 'You have uncommitted work.')
    : '';
  if (s.paused) subtitleEl.textContent += ' (Reminders are paused.)';
}

refresh();
setInterval(refresh, 3000);
