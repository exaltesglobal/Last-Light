import * as llc from './llcrypto.js';
import { h, $, show, message, api, busy, fmtDate, download, itemsToText } from './ui.js';

const publicId = location.pathname.split('/').filter(Boolean).pop();
let data = null;

function view(name) {
  for (const v of ['loading', 'sealed', 'missing', 'codes', 'open']) show($(`#view-${v}`), v === name);
}

function codeInput() {
  const n = document.querySelectorAll('.code-input').length + 1;
  const input = h('input', { class: 'code-input', 'aria-label': `Keeper Card code ${n}`, placeholder: 'LL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' });
  input.addEventListener('input', updateLights);
  return input;
}

function updateLights() {
  const filled = [...document.querySelectorAll('.code-input')].filter((i) => {
    try { llc.parseKeeperCode(i.value); return true; } catch { return false; }
  }).length;
  const box = $('#lights');
  box.replaceChildren();
  for (let i = 0; i < data.threshold; i++) box.append(h('span', { class: i < filled ? 'lit' : '' }));
}

function renderOpen(vault) {
  $('#owner-name-2').textContent = data.ownerName;
  $('#released-at').textContent = fmtDate(data.releasedAt);
  if (vault.letter) {
    $('#letter').textContent = vault.letter;
    show($('#letter-section'), true);
  }
  const box = $('#open-items');
  box.replaceChildren();
  const groups = new Map();
  for (const it of vault.items || []) {
    const key = it.category || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const [category, items] of groups) {
    box.append(h('h2', {}, category));
    for (const it of items) {
      box.append(h('article', { class: 'item' },
        h('strong', {}, it.title || 'Untitled'),
        it.forWhom ? h('div', { class: 'muted' }, `For: ${it.forWhom}`) : null,
        h('pre', {}, it.body || '')));
    }
  }
  if (!groups.size && !vault.letter) box.append(h('div', { class: 'empty' }, 'The vault is empty.'));

  $('#print-btn').onclick = () => window.print();
  $('#download-btn').onclick = () => {
    let text = itemsToText(`Last Light — from ${data.ownerName}`, vault.items || []);
    if (vault.letter) text = `LETTER\n\n${vault.letter}\n\n\n${text}`;
    download('last-light.txt', text);
  };
  view('open');
}

$('#more-codes').addEventListener('click', () => {
  if (document.querySelectorAll('.code-input').length < 10) $('#code-inputs').append(codeInput());
});

$('#codes-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#codes-form button[type=submit]');
  busy(btn, $('#codes-msg'), async () => {
    const codes = [...document.querySelectorAll('.code-input')].map((i) => i.value.trim()).filter(Boolean);
    const { shares, unmatched } = await llc.openKeeperShares(codes, data.shares);
    if (unmatched.length) {
      throw new Error(`${unmatched.length === 1 ? 'One code doesn\'t' : `${unmatched.length} codes don't`} match any Keeper Card for this vault. Please check each character.`);
    }
    if (shares.length < data.threshold) {
      const more = data.threshold - shares.length;
      throw new Error(`Those codes are right. ${more} more Keeper Card${more === 1 ? ' is' : 's are'} needed.`);
    }
    const key = llc.rebuildVaultKey(shares);
    let vault;
    try {
      vault = await llc.openJSON(key, data.ciphertext);
    } catch {
      throw new Error('The cards were accepted but the vault could not be opened. It may have been changed after these cards were made.');
    } finally {
      key.fill(0);
    }
    for (const i of document.querySelectorAll('.code-input')) i.value = '';
    renderOpen(vault);
  }, 'Opening…');
});

(async function init() {
  try {
    data = await api('GET', `/api/retrieve/${encodeURIComponent(publicId)}`);
  } catch (err) {
    view('missing');
    if (err.status !== 404) {
      $('#view-missing h1').textContent = 'Something went wrong';
      $('#view-missing .lead').textContent = `${err.message} You can simply reload this page and try again.`;
    }
    return;
  }
  if (!data.released) return view('sealed');
  $('#owner-name').textContent = data.ownerName;
  $('#need-count').textContent = String(data.threshold);
  for (let i = 0; i < data.threshold; i++) $('#code-inputs').append(codeInput());
  updateLights();
  view('codes');
  message($('#codes-msg'), '');
})();
