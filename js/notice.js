/**
 * Long API errors stay readable on a narrow screen.
 * The diagnosis is always visible. The API text can be collapsed, and it wraps.
 */
export function renderNotice(el, text) {
  const raw = String(text || '');
  const splitAt = raw.indexOf('\n\n');
  el.replaceChildren();
  if (splitAt < 0 || raw.length < 140) {
    el.textContent = raw;
    return;
  }
  const lead = document.createElement('p');
  lead.className = 'notice-lead';
  lead.textContent = raw.slice(0, splitAt);
  const details = document.createElement('details');
  details.className = 'notice-more';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'APIのメッセージと上限の詳細';
  const body = document.createElement('p');
  body.className = 'notice-body';
  body.textContent = raw.slice(splitAt + 2);
  details.append(summary, body);
  el.append(lead, details);
}
