import { randomBytes } from "node:crypto";

export interface SidebarSection {
  id: string;
  label: string;
  rows: { id: string; label: string; value: string; action?: string }[];
}

/** Dynamic values are sent as messages and assigned with textContent, never HTML. */
export function statusHtml(): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { margin: 0; padding: 0 0 8px; color: var(--vscode-sideBar-foreground); background: var(--vscode-sideBar-background); font: 13px/22px var(--vscode-font-family); }
* { box-sizing: border-box; }
details { border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border)); }
summary { padding: 7px 12px; font-weight: 600; cursor: pointer; background: var(--vscode-sideBarSectionHeader-background); color: var(--vscode-sideBarSectionHeader-foreground); }
.rows { padding: 2px 8px 6px; }
.rows > .row { margin: 0; min-height: 22px; line-height: 22px; }
.row svg { width: 16px; height: 16px; flex: none; color: var(--vscode-icon-foreground); }
.row .label { display: flex; align-items: center; gap: 6px; }
.row span:first-child { white-space: nowrap; }
.row .value { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row { position: relative; }
.row { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px; align-items: center; width: 100%; padding: 0 4px; border: 0; text-align: left; color: inherit; background: transparent; font: inherit; }
.row span { min-width: 0; overflow-wrap: anywhere; }
.value { color: var(--vscode-descriptionForeground); }
button.row { cursor: pointer; }
button.row:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground); }
button.row:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.row:not(:has(.value)) { grid-template-columns: 1fr; }
</style></head><body><main aria-label="Agent Gateway"></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const main = document.querySelector('main');
const icons = {
  state: 'M3 3h10v10H3z', owner: 'm3 8 3 3 7-7', version: 'M3 3h10v10H3z M5 1h6 M5 15h6',
  copilot: 'M4 5h8v7H4z M6 2h4 M8 2v3 M6 8h.1 M10 8h.1',
  listener: 'M5 1v4 M11 1v4 M4 5h8v2a4 4 0 0 1-8 0z M8 11v4',
  models: 'M2 5h5v8H2z M9 5h5v8H9z M5 2h6',
  restart: 'M3 5a5 5 0 1 1-1 5 M3 1v4h4',
  clients: 'M3 3h10v8H3z M6 14h4 M8 11v3',
  fallback: 'M2 5h11m-3-3 3 3-3 3 M14 11H3m3-3-3 3 3 3',
  search: 'M10 10l4 4 M11 6a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  remotes: 'm6 3-4 5 4 5 m4-10 4 5-4 5',
  sharing: 'M8 8v7 M5 5a4 4 0 0 0 0 6 M11 5a4 4 0 0 1 0 6 M3 2a8 8 0 0 0 0 12 M13 2a8 8 0 0 1 0 12',
  apiKey: 'M9 7 3 13H1v-2l6-6 M14 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  apiUrls: 'M6 5H4a3 3 0 0 0 0 6h2 M10 5h2a3 3 0 0 1 0 6h-2 M5 8h6',
  changePort: 'M5 1v4 M11 1v4 M4 5h8v2a4 4 0 0 1-8 0z M8 11v4',
  output: 'M2 2h12v12H2z M4 5h8 M4 8h6 M4 11h7',
  errors: 'M3 1h7l3 3v11H3z M10 1v4h3',
  logLevel: 'M2 4h12 M2 8h12 M2 12h12 M5 2v4 M11 6v4 M7 10v4',
  error: 'M8 3v6 M8 12h.1 M8 1 1 14h14z'
};
let previous = '';
window.addEventListener('message', ({data}) => {
  if (data.type !== 'sections') return;
  const serialized = JSON.stringify(data.sections);
  if (serialized === previous) return;
  previous = serialized;
  const state = vscode.getState() || {};
  const focused = document.activeElement?.dataset?.id;
  const scroll = window.scrollY;
  main.replaceChildren();
  for (const section of data.sections) {
    const details = document.createElement('details');
    details.open = state[section.id] !== false;
    const summary = document.createElement('summary');
    summary.textContent = section.label;
    summary.dataset.id = section.id;
    details.append(summary);
    details.addEventListener('toggle', () => { state[section.id] = details.open; vscode.setState(state); });
    const rows = document.createElement('div');
    rows.className = 'rows';
    for (const item of section.rows) {
      const row = document.createElement(item.action ? 'button' : 'div');
      row.className = 'row';
      row.dataset.id = item.id;
      row.title = item.value ? item.label + ': ' + item.value : item.label;
      if (item.action) {
        row.type = 'button';
        row.addEventListener('click', () => vscode.postMessage({type:'action', action:item.action}));
      }
      const label = document.createElement('span');
      label.className = 'label';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', icons[item.id] || icons.state);
      svg.append(path);
      const text = document.createElement('span');
      text.textContent = item.label;
      label.append(svg, text);
      row.append(label);
      if (item.value) {
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = item.value;
        row.append(value);
      }
      rows.append(row);
    }
    details.append(rows);
    main.append(details);
  }
  if (focused) Array.from(main.querySelectorAll('[data-id]')).find(el => el.dataset.id === focused)?.focus();
  window.scrollTo(0, scroll);
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
