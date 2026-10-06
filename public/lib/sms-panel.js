// SMS inbox and compose form. All message content is set via textContent.

import { el } from "./dom.js";
import { smsSegments } from "./format.js";
import { baseCss } from "./styles.js";

const css = `
  .list { list-style: none; margin: 0 0 16px; padding: 0; max-height: 420px; overflow-y: auto; }
  .msg { border: 2px solid rgba(var(--color-grey-rgb), 0.65); background: var(--bg-panel-muted); padding: 10px; margin-bottom: 8px; }
  .msg.unread { border-color: rgba(var(--color-teal-rgb), 0.9); }
  .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 0.85rem; color: var(--text-muted); }
  .peer { color: var(--text-main); font-weight: 600; }
  .dot { width: 10px; height: 10px; background: var(--color-teal); display: inline-block; }
  .body { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row button { min-height: 44px; min-width: 88px; }
  form { display: grid; gap: 8px; border-top: 2px solid rgba(var(--color-grey-rgb), 0.65); padding-top: 14px; }
  label { font-size: 0.8rem; color: var(--text-muted); letter-spacing: 0.08em; text-transform: uppercase; }
  input, textarea { font: inherit; width: 100%; min-height: 44px; padding: 8px; color: var(--text-main);
    background: var(--bg-panel-muted); border: 2px solid rgba(var(--color-grey-rgb), 0.9); border-radius: 0; }
  textarea { min-height: 96px; resize: vertical; }
  .count { font-size: 0.85rem; color: var(--text-muted); }
  .count.warn { color: var(--color-orange); }
  .result { min-height: 1.2em; }
  .result.err { color: var(--color-red); } .result.ok { color: var(--color-green); } .result.warn { color: var(--color-orange); }
`;

export class LteSms extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #sending = false;
  #draft = { to: "", text: "" };
  #result = null;
  #state = { messages: [], canWrite: true, error: null, handlers: {} };

  constructor() {
    super();
    const style = el("style");
    style.textContent = baseCss + css;
    this.#root.append(style);
  }

  /** @param {{messages: object[], canWrite: boolean, error?: string, handlers: object}} s */
  set data(s) {
    this.#state = s;
    this.#render();
  }

  /** Called by the app after a send attempt. */
  setResult(kind, message) {
    this.#sending = false;
    this.#result = { kind, message };
    if (kind === "ok") this.#draft = { to: this.#draft.to, text: "" };
    this.#render();
  }

  #render() {
    // Keep what the user is typing across the re-render.
    const old = this.#root.querySelector("form");
    if (old) {
      this.#draft = {
        to: old.elements.to.value,
        text: old.elements.text.value,
      };
    }
    const scroll = this.#root.querySelector(".list")?.scrollTop ?? 0;
    const hadFocus = this.#root.activeElement?.name;
    for (const n of [...this.#root.childNodes])
      if (n.nodeName !== "STYLE") n.remove();
    const { messages, canWrite, error, handlers } = this.#state;

    const panel = el("section", "panel teal");
    const unread = messages.filter(
      (m) => m.direction !== "out" && !m.read,
    ).length;
    panel.append(el("h2", "", unread ? `SMS (${unread} unread)` : "SMS"));
    if (error) panel.append(el("p", "result err", error));

    const list = el("ul", "list");
    if (messages.length === 0) list.append(el("li", "muted", "No messages."));
    for (const m of messages) {
      const li = el(
        "li",
        `msg${m.read === false && m.direction !== "out" ? " unread" : ""}`,
      );
      const head = el("div", "head");
      if (m.read === false && m.direction !== "out") {
        const dot = el("span", "dot");
        dot.setAttribute("role", "img");
        dot.setAttribute("aria-label", "unread");
        head.append(dot);
      }
      head.append(
        el(
          "span",
          "peer mono",
          `${m.direction === "out" ? "To " : ""}${m.peer ?? "?"}`,
        ),
      );
      const when = Date.parse(m.timestamp ?? "");
      head.append(
        el(
          "span",
          "mono",
          Number.isNaN(when) ? "" : new Date(when).toLocaleString(),
        ),
      );
      li.append(head, el("div", "body", String(m.text ?? "")));
      if (canWrite) {
        const row = el("div", "row");
        if (m.read === false && m.direction !== "out") {
          const b = el("button", "", "Mark read");
          b.type = "button";
          b.addEventListener("click", () => handlers.markRead?.(m.id));
          row.append(b);
        }
        const d = el("button", "", "Delete");
        d.type = "button";
        d.addEventListener("click", () => {
          if (globalThis.confirm("Delete this message from the router?"))
            handlers.remove?.(m.id);
        });
        row.append(d);
        li.append(row);
      }
      list.append(li);
    }
    panel.append(list);

    if (canWrite) panel.append(this.#form());
    else
      panel.append(
        el(
          "p",
          "muted",
          "Admin rights are required to send or manage messages.",
        ),
      );
    this.#root.append(panel);
    list.scrollTop = scroll;
    if (hadFocus) this.#root.querySelector(`[name="${hadFocus}"]`)?.focus();
  }

  #form() {
    const form = el("form");
    form.noValidate = true;
    const lblTo = el("label", "", "Recipient");
    lblTo.htmlFor = "to";
    const to = el("input");
    Object.assign(to, {
      id: "to",
      name: "to",
      type: "tel",
      autocomplete: "off",
      placeholder: "+358401234567",
      value: this.#draft.to,
    });
    to.inputMode = "tel";
    const lblText = el("label", "", "Message");
    lblText.htmlFor = "text";
    const text = el("textarea");
    Object.assign(text, { id: "text", name: "text", value: this.#draft.text });
    const count = el("div", "count mono");
    const send = el("button", "", this.#sending ? "Sending..." : "Send");
    send.type = "submit";
    const result = el(
      "div",
      `result${this.#result ? ` ${this.#result.kind}` : ""}`,
      this.#result?.message ?? "",
    );
    result.setAttribute("role", "status");

    const update = () => {
      const s = smsSegments(text.value);
      count.textContent = `${s.length} chars, ${s.segments} SMS (${s.encoding === "gsm7" ? "7-bit" : "Unicode"}), ${s.remaining} left`;
      count.classList.toggle("warn", s.segments > 1);
      send.disabled =
        this.#sending || to.value.trim() === "" || text.value.trim() === "";
    };
    to.addEventListener("input", update);
    text.addEventListener("input", update);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.#sending) return;
      this.#sending = true;
      this.#result = null;
      this.#draft = { to: to.value.trim(), text: text.value };
      this.#render();
      this.#state.handlers.send?.(this.#draft.to, this.#draft.text);
    });
    update();
    form.append(lblTo, to, lblText, text, count, send, result);
    return form;
  }
}

customElements.define("lte-sms", LteSms);
