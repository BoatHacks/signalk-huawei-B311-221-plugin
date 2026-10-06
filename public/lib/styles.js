// Shared shadow-DOM styles. Colours come from the :root custom properties.
export const baseCss = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .panel {
    --c: var(--color-grey);
    --c-rgb: var(--color-grey-rgb);
    background: linear-gradient(rgba(var(--c-rgb), 0.12), rgba(var(--c-rgb), 0.12)), var(--bg-panel);
    border: 2px solid rgba(var(--c-rgb), 0.65);
    border-radius: 0;
    box-shadow: none;
    padding: 14px;
    height: 100%;
  }
  .panel.green { --c: var(--color-green); --c-rgb: var(--color-green-rgb); }
  .panel.amber { --c: var(--color-orange); --c-rgb: var(--color-orange-rgb); }
  .panel.red { --c: var(--color-red); --c-rgb: var(--color-red-rgb); }
  .panel.teal { --c: var(--color-teal); --c-rgb: var(--color-teal-rgb); }
  h2 {
    margin: 0 0 12px; font-size: 0.8rem; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted);
  }
  .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-muted); }
  button {
    font: inherit; min-height: 44px; padding: 0 16px; cursor: pointer;
    color: var(--text-main); background: var(--bg-panel-muted);
    border: 2px solid rgba(var(--color-teal-rgb), 0.65); border-radius: 0;
  }
  button:disabled { cursor: not-allowed; border-color: rgba(var(--color-grey-rgb), 0.65); color: var(--text-muted); }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-teal); outline-offset: 2px; }
`;
