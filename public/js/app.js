import * as llc from './llcrypto.js';
import { h, $, show, message, api, busy, fmtDate, relDays, download, itemsToText } from './ui.js';

const AUTO_LOCK_MS = 15 * 60 * 1000;

const STARTER = [
  ['Accounts & passwords', 'Main email account', 'Email address:\nPassword:\nRecovery phone / backup codes:\n\nThis unlocks most other accounts through "forgot password".'],
  ['Devices', 'Phone and laptop', 'Phone passcode:\nLaptop password:\nPassword manager master password:'],
  ['Money & investments', 'Bank accounts', 'Bank / branch:\nAccount numbers:\nNominee:\nInternet banking login:'],
  ['Documents & insurance', 'Insurance policies', 'Insurer:\nPolicy numbers:\nAgent / helpline:\nWhere the papers are:'],
  ['Documents & insurance', 'Important documents', 'Where to find: property papers, will, ID documents, tax returns…'],
  ['Money & investments', 'Investments and crypto', 'Demat / broker:\nMutual funds:\nCrypto wallets (how to access, NOT the seed phrase if you prefer to keep it elsewhere):'],
  ['Instructions & wishes', 'Subscriptions to cancel', 'Streaming, cloud storage, gym, domains, hosting…'],
  ['Instructions & wishes', 'People to contact', 'Lawyer / CA / employer / close friends and how to reach them:'],
].map(([category, title, body]) => ({ category, title, body }));

const state = {
  me: null,
  vaultKey: null,
  vault: null, // { version, letter, items: [{ id, category, title, forWhom, body }] }
  editingId: null,
  registrationOpen: false,
  lockTimer: null,
};

const views = ['loading', 'auth', 'unlock', 'released', 'dash'];
function view(name) {
  for (const v of views) show($(`#view-${v}`), v === name);
  const loggedIn = name === 'dash' || name === 'unlock' || name === 'released';
  show($('#logout-btn'), loggedIn);
  show($('#lock-btn'), name === 'dash' && !!state.vaultKey);
}

// ---------- session ----------

async function refreshMe() {
  state.me = await api('GET', '/api/me');
  return state.me;
}

async function openVault(password) {
  const { wrapKey } = await llc.deriveAccountKeys(password, state.me.salt);
  try {
    state.vaultKey = await llc.open(wrapKey, state.me.wrappedKey);
  } catch {
    throw new Error('That password is not right.');
  }
  state.vault = await llc.openJSON(state.vaultKey, state.me.ciphertext);
  state.vault.items ||= [];
  state.vault.letter ||= '';
  startAutoLock();
  showDashboard();
}

function lock() {
  if (state.vaultKey) state.vaultKey.fill(0);
  state.vaultKey = null;
  state.vault = null;
  $('#cards').replaceChildren();
  show($('#cards-section'), false);
  $('#unlock-password').value = '';
  view('unlock');
}

function startAutoLock() {
  const reset = () => {
    clearTimeout(state.lockTimer);
    if (state.vaultKey) state.lockTimer = setTimeout(lock, AUTO_LOCK_MS);
  };
  for (const ev of ['click', 'keydown', 'pointermove']) document.addEventListener(ev, reset, { passive: true });
  reset();
}

async function saveVault() {
  const ciphertext = await llc.sealJSON(state.vaultKey, state.vault);
  await api('PUT', '/api/vault', { ciphertext });
  await refreshMe();
  renderStatus();
}

// ---------- auth views ----------

function authTab(name) {
  for (const b of document.querySelectorAll('[data-auth-tab]')) b.setAttribute('aria-selected', String(b.dataset.authTab === name));
  show($('#login-form'), name === 'login');
  show($('#register-form'), name === 'register');
  show($('#register-closed'), name === 'register' && !state.registrationOpen);
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button[type=submit]');
  busy(btn, $('#login-msg'), async () => {
    const email = $('#login-email').value.trim().toLowerCase();
    const password = $('#login-password').value;
    const { salt } = await api('POST', '/api/prelogin', { email });
    const { authKey } = await llc.deriveAccountKeys(password, salt);
    await api('POST', '/api/login', { email, authKey });
    await refreshMe();
    if (state.me.state === 'released') return showReleased();
    await openVault(password);
    $('#login-password').value = '';
  }, 'Unlocking…');
});

$('#register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#register-form button[type=submit]');
  busy(btn, $('#register-msg'), async () => {
    const name = $('#reg-name').value.trim();
    const email = $('#reg-email').value.trim().toLowerCase();
    const password = $('#reg-password').value;
    if (password.length < 12) throw new Error('Please use at least 12 characters.');
    if (password !== $('#reg-password2').value) throw new Error('The two passwords are different.');
    const salt = llc.newSalt();
    const { authKey, wrapKey } = await llc.deriveAccountKeys(password, salt);
    const vaultKey = llc.newVaultKey();
    const wrappedKey = await llc.seal(wrapKey, vaultKey);
    const ciphertext = await llc.sealJSON(vaultKey, { version: 1, letter: '', items: [] });
    await api('POST', '/api/register', { name, email, salt, authKey, wrappedKey, ciphertext });
    await refreshMe();
    await openVault(password);
    $('#reg-password').value = '';
    $('#reg-password2').value = '';
  }, 'Creating your vault…');
});

$('#unlock-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#unlock-form button[type=submit]');
  busy(btn, $('#unlock-msg'), async () => {
    await refreshMe();
    await openVault($('#unlock-password').value);
    $('#unlock-password').value = '';
  }, 'Unlocking…');
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch { /* already logged out */ }
  location.reload();
});

$('#lock-btn').addEventListener('click', lock);

for (const b of document.querySelectorAll('[data-auth-tab]')) b.addEventListener('click', () => authTab(b.dataset.authTab));

// ---------- dashboard ----------

function selectTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-panel]')) show(p, p.dataset.panel === name);
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));

function showDashboard() {
  view('dash');
  for (const b of document.querySelectorAll('[data-tab]')) show(b, true);
  show($('#signal-btn'), true);
  renderStatus();
  renderItems();
  $('#letter-body').value = state.vault.letter;
  renderKeepers();
  renderSettings();
}

function showReleased() {
  view('released');
  show($('#view-dash'), true);
  for (const b of document.querySelectorAll('[data-tab]')) show(b, b.dataset.tab === 'account');
  show($('#password-form'), false);
  show($('#signal-btn'), false);
  renderStatus();
  selectTab('account');
}

function renderStatus() {
  const me = state.me;
  const pill = $('#status-pill');
  const labels = { active: 'All good', overdue: 'Waiting for your signal', going_dark: 'Gone quiet', released: 'Released' };
  pill.className = `pill ${me.state}`;
  pill.textContent = labels[me.state] || me.state;
  const hint = $('#setup-hint');

  if (me.state === 'released') {
    $('#status-text').textContent = `Released on ${fmtDate(me.releasedAt)}.`;
    show(hint, false);
    return;
  }
  if (!me.threshold) {
    $('#status-text').textContent = `Last signal ${fmtDate(me.lastSignalAt)}.`;
    message(hint, 'Your signal checks are paused until you choose your Lightkeepers. Without them, nobody can ever open this vault.', 'warn');
    return;
  }
  show(hint, false);
  const lines = {
    active: `Last signal ${fmtDate(me.lastSignalAt)}. Next one due ${fmtDate(me.signalDueAt)} (${relDays(me.signalDueAt)}).`,
    overdue: `We're waiting for your signal. If we don't hear from you, your Lightkeepers will be alerted ${fmtDate(me.keepersAlertedAt)}.`,
    going_dark: `Your Lightkeepers have been told you've gone quiet. Send your signal now to stop the release on ${fmtDate(me.releaseAt)}.`,
  };
  $('#status-text').textContent = lines[me.state] || '';
}

$('#signal-btn').addEventListener('click', (e) => {
  busy(e.currentTarget, null, async () => {
    await api('POST', '/api/signal');
    await refreshMe();
    renderStatus();
    message($('#setup-hint'), 'Signal received. Thank you — see you next time.', 'ok');
  }, 'Sending…');
});

// ---------- vault items ----------

function renderItems() {
  const box = $('#items');
  box.replaceChildren();
  const items = state.vault.items;
  if (!items.length) {
    box.append(h('div', { class: 'empty' },
      h('p', {}, 'Your vault is empty.'),
      h('p', {}, 'Start with the starter checklist — it covers what families most often struggle to find.')));
    return;
  }
  for (const it of items) {
    const body = h('pre', { class: 'hidden' }, it.body || '');
    const toggle = h('button', { class: 'btn small', type: 'button', onclick: () => {
      const hidden = body.classList.toggle('hidden');
      toggle.textContent = hidden ? 'Show' : 'Hide';
    } }, 'Show');
    box.append(h('article', { class: 'item' },
      h('div', { class: 'item-head' },
        h('div', {}, h('strong', {}, it.title || 'Untitled'), ' ', h('span', { class: 'tag' }, it.category || 'Other')),
        h('div', { class: 'row' },
          toggle,
          h('button', { class: 'btn small', type: 'button', onclick: () => editItem(it.id) }, 'Edit'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteItem(it.id) }, 'Delete'))),
      it.forWhom ? h('div', { class: 'muted' }, `For: ${it.forWhom}`) : null,
      body));
  }
}

function editItem(id) {
  const it = state.vault.items.find((x) => x.id === id);
  state.editingId = id || null;
  $('#item-form-title').textContent = it ? 'Edit item' : 'New item';
  $('#item-title').value = it ? it.title : '';
  $('#item-category').value = it ? it.category : 'Accounts & passwords';
  $('#item-for').value = it ? it.forWhom || '' : '';
  $('#item-body').value = it ? it.body || '' : '';
  show($('#item-form'), true);
  $('#item-title').focus();
}

async function deleteItem(id) {
  const it = state.vault.items.find((x) => x.id === id);
  if (!it || !confirm(`Delete "${it.title}"?`)) return;
  const before = state.vault.items;
  state.vault.items = before.filter((x) => x.id !== id);
  try {
    await saveVault();
    message($('#vault-msg'), 'Item deleted.', 'ok');
  } catch (err) {
    state.vault.items = before;
    message($('#vault-msg'), err.message);
  }
  renderItems();
}

$('#add-item-btn').addEventListener('click', () => editItem(null));
$('#item-cancel').addEventListener('click', () => show($('#item-form'), false));

$('#item-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#item-form button[type=submit]');
  busy(btn, $('#vault-msg'), async () => {
    const data = {
      title: $('#item-title').value.trim(),
      category: $('#item-category').value,
      forWhom: $('#item-for').value.trim(),
      body: $('#item-body').value,
    };
    const before = state.vault.items;
    if (state.editingId) {
      state.vault.items = before.map((x) => (x.id === state.editingId ? { ...x, ...data } : x));
    } else {
      state.vault.items = [...before, { id: crypto.randomUUID(), ...data }];
    }
    try {
      await saveVault();
    } catch (err) {
      state.vault.items = before;
      throw err;
    }
    show($('#item-form'), false);
    renderItems();
    message($('#vault-msg'), 'Saved and encrypted.', 'ok');
  }, 'Encrypting…');
});

$('#starter-btn').addEventListener('click', (e) => {
  busy(e.currentTarget, $('#vault-msg'), async () => {
    const have = new Set(state.vault.items.map((x) => x.title));
    const add = STARTER.filter((x) => !have.has(x.title)).map((x) => ({ id: crypto.randomUUID(), forWhom: '', ...x }));
    if (!add.length) throw new Error('The starter checklist is already in your vault.');
    const before = state.vault.items;
    state.vault.items = [...before, ...add];
    try {
      await saveVault();
    } catch (err) {
      state.vault.items = before;
      throw err;
    }
    renderItems();
    message($('#vault-msg'), `Added ${add.length} items. Open each one and fill in the details.`, 'ok');
  });
});

$('#export-btn').addEventListener('click', () => {
  if (!confirm('This downloads your vault as a plain, unencrypted text file. Keep it somewhere safe, or delete it after use. Continue?')) return;
  let text = itemsToText(`Last Light — ${state.me.name}`, state.vault.items);
  if (state.vault.letter) text = `LETTER\n\n${state.vault.letter}\n\n\n${text}`;
  download('last-light-vault.txt', text);
});

// ---------- letter ----------

$('#letter-save').addEventListener('click', (e) => {
  busy(e.currentTarget, $('#letter-msg'), async () => {
    const before = state.vault.letter;
    state.vault.letter = $('#letter-body').value;
    try {
      await saveVault();
    } catch (err) {
      state.vault.letter = before;
      throw err;
    }
    message($('#letter-msg'), 'Your letter is saved and encrypted.', 'ok');
  }, 'Encrypting…');
});

// ---------- lightkeepers ----------

function keeperRow(name = '', email = '') {
  const row = h('div', { class: 'keeper-row' },
    h('div', {}, h('label', {}, 'Name'), h('input', { class: 'k-name', maxlength: '120', value: name, required: true })),
    h('div', {}, h('label', {}, 'Email'), h('input', { class: 'k-email', type: 'email', value: email, required: true })),
    h('button', { class: 'btn small danger', type: 'button', onclick: () => {
      if (document.querySelectorAll('.keeper-row').length <= 2) return;
      row.remove();
      updateThreshold();
    } }, 'Remove'));
  return row;
}

function updateThreshold(preferred) {
  const n = document.querySelectorAll('.keeper-row').length;
  const sel = $('#threshold');
  const current = preferred || Number(sel.value) || Math.min(2, n);
  sel.replaceChildren();
  for (let k = 2; k <= n; k++) sel.append(h('option', { value: String(k) }, `${k} of ${n}`));
  sel.value = String(Math.min(Math.max(current, 2), n));
}

function renderKeepers() {
  const me = state.me;
  const box = $('#keepers-current');
  box.replaceChildren();
  if (!me.keepers.length) {
    box.append(h('p', { class: 'muted' }, 'You haven\'t chosen anyone yet.'));
  } else {
    box.append(h('p', {}, `Any ${me.threshold} of these ${me.keepers.length} people can open your vault together after a release:`));
    box.append(h('ul', {}, me.keepers.map((k) => h('li', {}, `${k.name} — ${k.email}`))));
  }
  $('#keepers-form-title').textContent = me.keepers.length ? 'Replace your Lightkeepers' : 'Choose your Lightkeepers';

  const rows = $('#keeper-rows');
  rows.replaceChildren();
  const seed = me.keepers.length ? me.keepers : [{}, {}, {}];
  for (const k of seed) rows.append(keeperRow(k.name, k.email));
  updateThreshold(me.threshold || 2);

  const codes = $('#rehearse-codes');
  codes.replaceChildren();
  for (let i = 0; i < Math.max(me.threshold, 2); i++) {
    codes.append(h('input', { class: 'r-code', placeholder: 'LL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX', autocomplete: 'off', spellcheck: 'false' }));
  }
}

$('#add-keeper-row').addEventListener('click', () => {
  if (document.querySelectorAll('.keeper-row').length >= 10) return;
  $('#keeper-rows').append(keeperRow());
  updateThreshold();
});

$('#keepers-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#keepers-form button[type=submit]');
  busy(btn, $('#keepers-msg'), async () => {
    const people = [...document.querySelectorAll('.keeper-row')].map((r) => ({
      name: r.querySelector('.k-name').value.trim(),
      email: r.querySelector('.k-email').value.trim().toLowerCase(),
    }));
    if (new Set(people.map((p) => p.email)).size !== people.length) throw new Error('Each Lightkeeper needs their own email address.');
    if (people.some((p) => p.email === state.me.email)) throw new Error("You can't be your own Lightkeeper.");
    const threshold = Number($('#threshold').value);
    if (state.me.keepers.length && !confirm('This replaces your current Lightkeepers. Their old Keeper Cards will stop working. Continue?')) return;

    const shares = await llc.makeKeeperShares(state.vaultKey, people.length, threshold);
    const keepers = people.map((p, i) => ({ ...p, shareIndex: shares[i].shareIndex, encryptedShare: shares[i].encryptedShare }));
    await api('PUT', '/api/keepers', { threshold, keepers, notify: $('#notify-keepers').checked });
    await refreshMe();
    renderStatus();
    renderKeepers();
    showCards(people, shares, threshold);
  }, 'Creating cards…');
});

function showCards(people, shares, threshold) {
  const box = $('#cards');
  box.replaceChildren();
  people.forEach((p, i) => {
    box.append(h('div', { class: 'keeper-card' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), 'Last Light · Keeper Card'),
      h('p', {}, `For ${p.name}, from ${state.me.name}`),
      h('div', { class: 'code' }, shares[i].codeText),
      h('p', { class: 'muted' },
        `Keep this card safe and private. If ${state.me.name} ever goes quiet for a long time, you'll get an email from ${location.host} with a link. ` +
        `${threshold} Lightkeepers must enter their codes together to open what was left for you.`)));
  });
  show($('#cards-section'), true);
  $('#cards-section').scrollIntoView({ behavior: 'smooth' });
}

$('#print-cards').addEventListener('click', () => window.print());
$('#done-cards').addEventListener('click', () => {
  if (!confirm('Have you printed or copied every card? They won\'t be shown again.')) return;
  $('#cards').replaceChildren();
  show($('#cards-section'), false);
});

$('#rehearse-btn').addEventListener('click', (e) => {
  busy(e.currentTarget, $('#rehearse-msg'), async () => {
    const me = state.me;
    if (!me.keepers.length) throw new Error('Choose your Lightkeepers first.');
    const codes = [...document.querySelectorAll('.r-code')].map((i) => i.value.trim()).filter(Boolean);
    const { shares, unmatched } = await llc.openKeeperShares(codes, me.keepers.map((k) => k.encryptedShare));
    if (unmatched.length) throw new Error(`${unmatched.length} code(s) didn't match any current Keeper Card. Check for typos.`);
    if (shares.length < me.threshold) throw new Error(`Those codes are valid, but you need ${me.threshold} different cards.`);
    const rebuilt = llc.rebuildVaultKey(shares);
    const same = rebuilt.length === state.vaultKey.length && rebuilt.every((b, i) => b === state.vaultKey[i]);
    rebuilt.fill(0);
    if (!same) throw new Error('These cards did not rebuild your vault key. Please create new Keeper Cards.');
    message($('#rehearse-msg'), 'It works. These cards can open your vault.', 'ok');
  }, 'Testing…');
});

// ---------- signal settings ----------

function renderSettings() {
  $('#interval-days').value = state.me.intervalDays;
  $('#grace-days').value = state.me.graceDays;
  summarizeSettings();
}

function summarizeSettings() {
  const i = Number($('#interval-days').value) || 0;
  const g = Number($('#grace-days').value) || 0;
  $('#settings-summary').textContent = `If you stop responding, your Lightkeepers are alerted after about ${i + g} days of silence, and the vault opens after about ${i + 2 * g} days.`;
}
$('#interval-days').addEventListener('input', summarizeSettings);
$('#grace-days').addEventListener('input', summarizeSettings);

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#settings-form button[type=submit]');
  busy(btn, $('#settings-msg'), async () => {
    await api('PUT', '/api/settings', { intervalDays: Number($('#interval-days').value), graceDays: Number($('#grace-days').value) });
    await refreshMe();
    renderStatus();
    message($('#settings-msg'), 'Saved.', 'ok');
  }, 'Saving…');
});

$('#test-email-btn').addEventListener('click', (e) => {
  busy(e.currentTarget, $('#test-email-msg'), async () => {
    await api('POST', '/api/test-email');
    message($('#test-email-msg'), `Sent to ${state.me.email}. Check your inbox (and spam folder).`, 'ok');
  }, 'Sending…');
});

// ---------- account ----------

$('#password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#password-form button[type=submit]');
  busy(btn, $('#password-msg'), async () => {
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    if (next.length < 12) throw new Error('Please use at least 12 characters.');
    if (next !== $('#pw-new2').value) throw new Error('The two new passwords are different.');
    const old = await llc.deriveAccountKeys(current, state.me.salt);
    try {
      await llc.open(old.wrapKey, state.me.wrappedKey);
    } catch {
      throw new Error('Your current password is incorrect.');
    }
    const salt = llc.newSalt();
    const fresh = await llc.deriveAccountKeys(next, salt);
    const wrappedKey = await llc.seal(fresh.wrapKey, state.vaultKey);
    await api('PUT', '/api/password', { currentAuthKey: old.authKey, salt, authKey: fresh.authKey, wrappedKey });
    await refreshMe();
    for (const id of ['#pw-current', '#pw-new', '#pw-new2']) $(id).value = '';
    message($('#password-msg'), 'Password changed. Other devices have been signed out.', 'ok');
  }, 'Changing…');
});

$('#delete-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#delete-form button[type=submit]');
  busy(btn, $('#delete-msg'), async () => {
    if (!confirm('Delete your vault and everything in it, forever?')) return;
    const { authKey } = await llc.deriveAccountKeys($('#delete-password').value, state.me.salt);
    await api('DELETE', '/api/account', { currentAuthKey: authKey });
    location.href = '/';
  }, 'Deleting…');
});

// ---------- start ----------

(async function init() {
  try {
    const status = await api('GET', '/api/status');
    state.registrationOpen = status.registrationOpen;
  } catch { /* server unreachable; login will show the error */ }
  try {
    await refreshMe();
    if (state.me.state === 'released') showReleased();
    else view('unlock');
  } catch {
    view('auth');
    authTab(state.registrationOpen && location.hash !== '#login' ? 'register' : 'login');
  }
})();
