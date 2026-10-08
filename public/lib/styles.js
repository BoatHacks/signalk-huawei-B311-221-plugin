// Shared shadow-DOM styles. Colours come from the :root custom properties.
// The look follows Status Tiles: flat panels (no radius, shadow or gradient),
// thick state-coloured borders with a faint tint, 4px corner brackets,
// uppercase labels in the state colour, and white monospace numbers. Sizes
// use clamp() so they grow on a wall display and stay readable on a phone.
export const baseCss = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .panel {
    --c: var(--color-grey);
    --c-rgb: var(--color-grey-rgb);
    --edge: clamp(18px, 2.2vh, 30px);
    position: relative;
    height: 100%;
    padding: var(--edge) calc(var(--edge) + 4px);
    background: var(--bg-panel-muted);
    border: 4px solid rgba(var(--color-grey-rgb), 0.5);
    border-radius: 0;
    box-shadow: none;
    transition: background 0.2s, border-color 0.2s;
  }
  .panel.green, .panel.amber, .panel.red, .panel.teal {
    background: rgba(var(--c-rgb), 0.16);
    border-color: rgba(var(--c-rgb), 0.65);
  }
  .panel.green { --c: var(--color-green); --c-rgb: var(--color-green-rgb); }
  .panel.amber { --c: var(--color-orange); --c-rgb: var(--color-orange-rgb); }
  .panel.red { --c: var(--color-red); --c-rgb: var(--color-red-rgb); }
  .panel.teal { --c: var(--color-teal); --c-rgb: var(--color-teal-rgb); }
  /* Corner brackets, top-left and bottom-right, in the state colour. */
  .panel::before, .panel::after {
    content: ""; position: absolute; width: clamp(14px, 2.8vh, 28px); height: clamp(14px, 2.8vh, 28px);
    pointer-events: none;
  }
  .panel::before { top: 6px; left: 6px; border-top: 4px solid var(--c); border-left: 4px solid var(--c); }
  .panel::after { bottom: 6px; right: 6px; border-bottom: 4px solid var(--c); border-right: 4px solid var(--c); }
  .panel:not(.green):not(.amber):not(.red):not(.teal)::before,
  .panel:not(.green):not(.amber):not(.red):not(.teal)::after { border-color: rgba(var(--color-grey-rgb), 0.5); }
  .panel.red { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { border-color: rgba(var(--c-rgb), 0.55); background: rgba(var(--c-rgb), 0.12); }
    50% { border-color: rgba(var(--c-rgb), 1); background: rgba(var(--c-rgb), 0.3); }
  }
  @media (prefers-reduced-motion: reduce) { .panel.red { animation: none; } }
  h2 {
    margin: 0 0 14px; text-align: center;
    font-size: clamp(1rem, 2.6vh, 1.7rem); font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--c);
  }
  .panel:not(.green):not(.amber):not(.red):not(.teal) h2 { color: var(--text-muted); }
  .mono { font-family: ui-monospace, "Fira Code", monospace; font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-muted); }
  button {
    font: inherit; font-size: 0.85rem; letter-spacing: 0.1em; text-transform: uppercase;
    min-height: 44px; padding: 0 16px; cursor: pointer;
    color: var(--text-main); background: none;
    border: 2px solid rgba(var(--color-grey-rgb), 0.9); border-radius: 0;
  }
  button:hover:not(:disabled) { border-color: var(--color-teal); }
  button:disabled { cursor: not-allowed; border-color: rgba(var(--color-grey-rgb), 0.5); color: var(--text-muted); }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-teal); outline-offset: 2px; }
`;
