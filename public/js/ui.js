// Small DOM and API helpers shared by every page. User data is only ever
// inserted with textContent, never as HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function show(el, visible = true) {
  el.classList.toggle('hidden', !visible);
}

export function message(el, text, kind = 'error') {
  el.replaceChildren();
  if (!text) return show(el, false);
  el.className = `msg ${kind}`;
  el.textContent = text;
  show(el, true);
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { 'X-Last-Light': '1' } : { 'Content-Type': 'application/json', 'X-Last-Light': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Disable a button while an async action runs, and show errors in `msgEl`. */
export async function busy(button, msgEl, fn, workingText) {
  const label = button.textContent;
  button.disabled = true;
  if (workingText) button.textContent = workingText;
  if (msgEl) message(msgEl, '');
  try {
    return await fn();
  } catch (err) {
    if (msgEl) message(msgEl, err.message || String(err));
    else alert(err.message || String(err));
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relDays(ms) {
  const days = Math.round((ms - Date.now()) / 86400000);
  if (days === 0) return 'today';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  return `${-days} day${days === -1 ? '' : 's'} ago`;
}

export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Plain-text export of vault items, for the owner's own backup or a Lightkeeper's copy. */
export function itemsToText(title, items) {
  const lines = [title, '='.repeat(title.length), ''];
  for (const it of items) {
    lines.push(`## ${it.title || 'Untitled'}`);
    if (it.forWhom) lines.push(`For: ${it.forWhom}`);
    lines.push('', it.body || '', '');
  }
  return lines.join('\n');
}
