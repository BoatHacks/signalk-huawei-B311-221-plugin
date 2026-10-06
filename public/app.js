// Huawei B311 webapp: polls the plugin REST API and renders four panels.
import { api, ApiError } from "./lib/api.js";
import { el } from "./lib/dom.js";
import { formatAge, isStale } from "./lib/format.js";
import { startModePolling } from "./lib/mode.js";
import "./lib/panels.js";
import "./lib/sms-panel.js";
import { baseCss } from "./lib/styles.js";

const STATUS_POLL_MS = 10_000;
const SMS_POLL_MS = 30_000;

const css = `
  :host { display: block; min-height: 100vh; padding: 12px 16px 32px; max-width: 1200px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 1.1rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .age { font-size: 0.85rem; color: var(--text-muted); }
  .notice { margin: 0 0 12px; padding: 10px 12px; border: 2px solid var(--color-orange); color: var(--color-orange);
            background: rgba(var(--color-orange-rgb), 0.16); font-weight: 600; }
  .notice.err { border-color: var(--color-red); color: var(--color-red); background: rgba(var(--color-red-rgb), 0.16); }
  main { display: grid; gap: 12px; grid-template-columns: 1fr; }
  @media (min-width: 900px) {
    main { grid-template-columns: 1fr 1fr; }
    lte-sms { grid-column: 1 / -1; }
  }
  @media (min-width: 1100px) {
    main { grid-template-columns: 1.3fr 1fr 1fr; }
    lte-signal { grid-column: 1; } lte-connection { grid-column: 2; } lte-plan { grid-column: 3; }
  }
`;

class LteApp extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #status = null;
  #statusAt = 0; // Date.now() of last successful fetch
  #statusError = null;
  #authError = null; // "401" | null
  #canWrite = true;
  #messages = [];
  #smsError = null;
  #timers = [];
  #refs = {};

  connectedCallback() {
    const style = el("style");
    style.textContent = baseCss + css;
    const header = el("header");
    const h1 = el("h1", "", "Huawei B311 LTE");
    const age = el("span", "age mono");
    header.append(h1, age);
    const notices = el("div");
    const main = el("main");
    const signal = el("lte-signal");
    const connection = el("lte-connection");
    const plan = el("lte-plan");
    const sms = el("lte-sms");
    main.append(signal, connection, plan, sms);
    this.#root.append(style, header, notices, main);
    this.#refs = { age, notices, signal, connection, plan, sms };

    this.#timers.push(startModePolling());
    this.#timers.push(setInterval(() => this.#tick(), 1000));
    this.#timers.push(setInterval(() => !document.hidden && this.#pollStatus(), STATUS_POLL_MS));
    this.#timers.push(setInterval(() => !document.hidden && this.#pollSms(), SMS_POLL_MS));
    document.addEventListener("visibilitychange", this.#onVisible);
    this.#render();
    this.#pollStatus();
    this.#pollSms();
  }

  disconnectedCallback() {
    for (const t of this.#timers) clearInterval(t);
    document.removeEventListener("visibilitychange", this.#onVisible);
  }

  #onVisible = () => {
    if (!document.hidden) {
      this.#pollStatus();
      this.#pollSms();
    }
  };

  #tick() {
    const st = this.#status;
    if (st?.updatedAt) this.#refs.age.textContent = `Updated ${formatAge(Date.now() - Date.parse(st.updatedAt))}`;
  }

  #noteError(e) {
    if (e instanceof ApiError && e.status === 401) this.#authError = true;
    if (e instanceof ApiError && e.status === 403) this.#canWrite = false;
  }

  async #pollStatus() {
    try {
      this.#status = await api.status();
      this.#statusAt = Date.now();
      this.#statusError = null;
      this.#authError = null;
    } catch (e) {
      this.#noteError(e);
      this.#statusError = e instanceof ApiError && e.status === 0 ? "Cannot reach Signal K server." : e.message;
    }
    this.#render();
  }

  async #pollSms() {
    try {
      this.#messages = await api.sms(50);
      this.#smsError = null;
    } catch (e) {
      this.#noteError(e);
      this.#smsError = e.status === 401 ? null : `Could not load messages: ${e.message}`;
    }
    this.#render();
  }

  async #action(fn) {
    try {
      await fn();
      return null;
    } catch (e) {
      this.#noteError(e);
      return e;
    }
  }

  #handlers = {
    send: async (to, text) => {
      const err = await this.#action(() => api.send(to, text));
      if (err) {
        this.#refs.sms.setResult("err", err.status === 403 ? "Admin rights required to send." : `Send failed: ${err.message}`);
      } else {
        this.#refs.sms.setResult("ok", "Message sent.");
        this.#pollSms();
      }
      this.#render();
    },
    markRead: async (id) => {
      await this.#action(() => api.markRead(id));
      this.#pollSms();
      this.#pollStatus();
    },
    remove: async (id) => {
      await this.#action(() => api.remove(id));
      this.#pollSms();
      this.#pollStatus();
    },
    resetPlan: async () => {
      await this.#action(() => api.resetPlan());
      this.#pollStatus();
    },
  };

  #render() {
    const now = Date.now();
    const st = this.#status;
    // Stale: no snapshot, link not ok, router data older than 60 s, or our
    // own fetch older than 60 s (server unreachable).
    const stale = !st || isStale(st.updatedAt, now, st.link) || now - this.#statusAt > 60_000;
    const r = this.#refs;

    r.age.textContent = st ? `Updated ${formatAge(st.updatedAt ? now - Date.parse(st.updatedAt) : undefined)}` : "Loading...";

    const notices = [];
    if (this.#authError) notices.push(["err", "Log in to Signal K to see router data."]);
    else if (this.#statusError) notices.push(["err", this.#statusError]);
    if (!this.#canWrite) notices.push(["", "Admin rights required to send, delete or reset."]);
    r.notices.replaceChildren(...notices.map(([k, m]) => el("p", `notice ${k}`, m)));

    r.signal.data = { signal: st?.signal, stale };
    r.connection.data = { status: st ?? undefined, stale };
    r.plan.data = { plan: st?.plan, stale, canWrite: this.#canWrite, onReset: this.#handlers.resetPlan, now };
    r.sms.data = { messages: this.#messages, canWrite: this.#canWrite, error: this.#smsError, handlers: this.#handlers };
  }
}

customElements.define("lte-app", LteApp);
