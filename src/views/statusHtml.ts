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
body { margin: 0; padding: 8px 0 16px; color: var(--vscode-sideBar-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
* { box-sizing: border-box; }
details { border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border)); }
summary { padding: 7px 12px; font-weight: 600; cursor: pointer; background: var(--vscode-sideBarSectionHeader-background); color: var(--vscode-sideBarSectionHeader-foreground); }
.rows { padding: 3px 8px 8px; }
.rows > .row { margin: 0; min-height: 26px; line-height: 1.35; }
.row span:first-child { white-space: nowrap; }
.row .value { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row { position: relative; }
.row { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: baseline; width: 100%; padding: 5px 6px; border: 0; text-align: left; color: inherit; background: transparent; font: inherit; }
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
      label.textContent = item.label;
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
