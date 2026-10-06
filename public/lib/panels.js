// Read-only status panels: signal, connection, data plan.

import { el } from "./dom.js";
import {
  daysUntil,
  formatBytes,
  formatNumber,
  metricFraction,
  metricState,
  planState,
} from "./format.js";
import { baseCss } from "./styles.js";

const THEME = { green: "green", amber: "amber", red: "red", neutral: "" };

class Panel extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  constructor() {
    super();
    const style = el("style");
    style.textContent = baseCss + this.constructor.css;
    this.#root.append(style);
  }
  /** Replace the panel body. */
  mount(node) {
    for (const n of [...this.#root.childNodes])
      if (n.nodeName !== "STYLE") n.remove();
    this.#root.append(node);
  }
  static css = "";
}

const bars = (fraction, n = 5) => {
  const wrap = el("div", "bars");
  const lit = Math.round(fraction * n);
  for (let i = 0; i < n; i++) wrap.append(el("i", i < lit ? "on" : ""));
  wrap.setAttribute("aria-hidden", "true");
  return wrap;
};

export class LteSignal extends Panel {
  static css = `
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .m { --c: var(--color-grey); --c-rgb: var(--color-grey-rgb); border: 2px solid rgba(var(--c-rgb), 0.65);
         background: var(--bg-panel-muted); padding: 10px; }
    .m.green { --c: var(--color-green); --c-rgb: var(--color-green-rgb); }
    .m.amber { --c: var(--color-orange); --c-rgb: var(--color-orange-rgb); }
    .m.red { --c: var(--color-red); --c-rgb: var(--color-red-rgb); }
    .name { font-size: 0.75rem; letter-spacing: 0.1em; color: var(--text-muted); }
    .val { font-size: 1.9rem; line-height: 1.2; color: var(--c); margin: 2px 0 6px; }
    .val small { font-size: 0.85rem; color: var(--text-muted); margin-left: 4px; }
    .bars { display: flex; gap: 3px; height: 12px; }
    .bars i { flex: 1; background: rgba(var(--color-grey-rgb), 0.5); }
    .bars i.on { background: var(--c); }
  `;
  /** @param {{signal?: object, stale: boolean}} d */
  set data({ signal, stale }) {
    const s = signal ?? {};
    const defs = [
      ["RSRP", "rsrp", s.rsrp, "dBm"],
      ["SINR", "sinr", s.sinr, "dB"],
      ["RSSI", "rssi", s.rssi, "dBm"],
      ["RSRQ", "rsrq", s.rsrq, "dB"],
    ];
    const panel = el("section", "panel");
    panel.append(el("h2", "", "Signal quality"));
    const grid = el("div", "grid");
    let worst = "neutral";
    for (const [label, key, value, unit] of defs) {
      const state = metricState(key, value, { stale });
      if (
        state === "red" ||
        (state === "amber" && worst !== "red") ||
        (state === "green" && worst === "neutral")
      )
        worst = state;
      const known =
        !stale && typeof value === "number" && Number.isFinite(value);
      const m = el("div", `m ${THEME[state]}`.trim());
      m.append(el("div", "name", label));
      const v = el("div", "val mono", known ? formatNumber(value) : "-");
      v.append(el("small", "", unit));
      m.append(v, bars(known ? metricFraction(key, value) : 0));
      grid.append(m);
    }
    if (THEME[worst]) panel.classList.add(THEME[worst]);
    panel.append(grid);
    this.mount(panel);
  }
}

export class LteConnection extends Panel {
  static css = `
    dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; }
    dt { color: var(--text-muted); }
    dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
    .banner { margin: 0 0 12px; padding: 10px; font-weight: 600; border: 2px solid var(--color-red);
              background: rgba(var(--color-red-rgb), 0.16); color: var(--color-red); }
    .banner.warn { border-color: var(--color-orange); background: rgba(var(--color-orange-rgb), 0.16); color: var(--color-orange); }
  `;
  /** @param {{status?: object, stale: boolean}} d */
  set data({ status, stale }) {
    const st = status ?? {};
    const link = st.link;
    const c = st.connection ?? {};
    const sig = st.signal ?? {};
    const panel = el("section", "panel");
    panel.append(el("h2", "", "Connection"));
    if (link === "unreachable") {
      panel.append(
        el("p", "banner", "Router unreachable. Values shown as unknown."),
      );
    } else if (link === "auth-failed") {
      panel.append(
        el(
          "p",
          "banner",
          "Router login failed. Check the username and password in the plugin settings.",
        ),
      );
    } else if (link === "connecting") {
      panel.append(el("p", "banner warn", "Connecting to router..."));
    }
    const dash = (v) =>
      stale || v === undefined || v === null || v === "" ? "-" : String(v);
    const yes = (v) =>
      stale || typeof v !== "boolean" ? "-" : v ? "yes" : "no";
    const rows = [
      ["Link", link ?? "-"],
      ["Operator", dash(st.operator?.name)],
      ["Network", dash(sig.networkType)],
      ["Band", dash(sig.band)],
      ["Cell", dash(sig.cellId)],
      ["Roaming", yes(c.roaming)],
      ["WAN IP", dash(c.wanIp)],
    ];
    const dl = el("dl");
    for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "mono", v));
    const tone =
      !stale && c.serviceAvailable && link === "ok"
        ? c.roaming
          ? "amber"
          : "green"
        : link === "unreachable" || link === "auth-failed"
          ? "red"
          : "";
    if (tone) panel.classList.add(tone);
    panel.append(dl);
    this.mount(panel);
  }
}

export class LtePlan extends Panel {
  static css = `
    .gauge { height: 22px; background: rgba(var(--color-grey-rgb), 0.5); margin: 4px 0 12px; position: relative; }
    .fill { height: 100%; background: var(--c); }
    .big { font-size: 1.9rem; color: var(--c); }
    dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
    dt { color: var(--text-muted); } dd { margin: 0; text-align: right; }
    .actions { margin-top: 14px; }
  `;
  /** @param {{plan?: object, stale: boolean, canWrite: boolean}} d */
  set data({ plan, stale, canWrite, onReset, now = Date.now() }) {
    const panel = el("section", "panel");
    panel.append(el("h2", "", "Data plan"));
    if (!plan) {
      panel.append(
        el(
          "p",
          "muted",
          "Not configured. Set the plan size and reset day in the plugin settings.",
        ),
      );
      this.mount(panel);
      return;
    }
    const ratio =
      plan.usedRatio ??
      (plan.totalBytes ? plan.usedBytes / plan.totalBytes : undefined);
    const state = stale ? "neutral" : planState(ratio);
    if (THEME[state]) panel.classList.add(THEME[state]);
    const pct =
      typeof ratio === "number" ? Math.min(100, Math.max(0, ratio * 100)) : 0;
    panel.append(
      el(
        "div",
        "big mono",
        typeof ratio === "number" ? `${Math.round(ratio * 100)} %` : "-",
      ),
    );
    const gauge = el("div", "gauge");
    gauge.setAttribute("role", "progressbar");
    gauge.setAttribute("aria-valuenow", String(Math.round(pct)));
    gauge.setAttribute("aria-valuemin", "0");
    gauge.setAttribute("aria-valuemax", "100");
    const fill = el("div", "fill");
    fill.style.width = `${pct}%`;
    gauge.append(fill);
    panel.append(gauge);
    const days = daysUntil(plan.periodEnd, now);
    const dl = el("dl");
    dl.append(
      el("dt", "", "Used"),
      el("dd", "mono", formatBytes(plan.usedBytes)),
      el("dt", "", "Remaining"),
      el("dd", "mono", formatBytes(plan.remainingBytes)),
      el("dt", "", "Plan size"),
      el("dd", "mono", formatBytes(plan.totalBytes)),
      el("dt", "", "Resets in"),
      el(
        "dd",
        "mono",
        days === undefined ? "-" : `${days} day${days === 1 ? "" : "s"}`,
      ),
    );
    panel.append(dl);
    if (canWrite && onReset) {
      const actions = el("div", "actions");
      const b = el("button", "", "Restart plan period");
      b.type = "button";
      b.addEventListener("click", () => {
        if (
          globalThis.confirm(
            "Restart the plan period now? Used data is reset to zero.",
          )
        )
          onReset();
      });
      actions.append(b);
      panel.append(actions);
    }
    this.mount(panel);
  }
}

customElements.define("lte-signal", LteSignal);
customElements.define("lte-connection", LteConnection);
customElements.define("lte-plan", LtePlan);
