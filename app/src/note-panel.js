import { Facet } from "@codemirror/state";

export const editorMenuPanel = Facet.define({ combine: panels => panels[0] });

export function createNotePanel(invoke, onError) {
  let popup;
  let active;
  let opening;
  let operations = Promise.resolve();

  function native(command, args) {
    operations = operations.catch(() => {}).then(() => invoke(command, args));
    return operations;
  }

  function isOpen(element) {
    return !!active && (!element || active.element === element);
  }

  function close(element, { hide = true } = {}) {
    if (!isOpen(element)) return;
    const current = active;
    active = null;
    current.observer?.disconnect();
    current.home.replaceWith(current.element);
    for (const [extra, home] of current.extras) home.replaceWith(extra);
    current.element.hidden = current.hidden;
    if (current.popover !== null) current.element.setAttribute("popover", current.popover);
    current.onClose?.();
    if (hide) void native("hide_note_panel").catch(onError);
  }

  async function dismiss({ hide = true } = {}) {
    if (!active || active.dismissing) return false;
    const current = active;
    current.dismissing = true;
    try {
      if (current.onDismiss && await current.onDismiss() === false) {
        if (active === current) await current.focus();
        return false;
      }
      if (active === current) close(current.element, {hide});
      return true;
    } finally {
      current.dismissing = false;
    }
  }

  async function childDocument() {
    if (popup && !popup.closed) return popup.document;
    popup = window.open("about:blank", "sticky-note-panel", "popup");
    if (!popup) throw Error("メニューを開けませんでした");
    const doc = popup.document;
    doc.documentElement.lang = "ja";
    doc.title = "付箋メニュー";
    doc.body.className = "note-menu-panel";
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = document.querySelector("link[rel=stylesheet]").href;
    await new Promise((resolve, reject) => {
      sheet.onload = resolve;
      sheet.onerror = () => reject(Error("メニューのスタイルを読み込めませんでした"));
      doc.head.append(sheet);
    });
    popup.addEventListener("blur", () => {
      const current = active;
      if (!current?.shown) return;
      // Chromium's own select/color picker may briefly hold focus.
      setTimeout(() => {
        if (active === current && !doc.hasFocus() && !doc.querySelector("select:open, input:open")) {
          void dismiss().catch(onError);
        }
      }, 40);
    });
    doc.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.isComposing || doc.querySelector("select:open, input:open")) return;
      event.preventDefault();
      void dismiss().catch(onError);
    });
    doc.addEventListener("contextmenu", event => {
      if (!event.target.closest("input, textarea")) event.preventDefault();
    });
    return doc;
  }

  function open(element, options) {
    if (opening) return opening.then(() => open(element, options));
    if (!element.isConnected) return Promise.resolve();
    if (isOpen(element)) {
      active.anchor = options.anchor;
      return active.focus().catch(onError);
    }
    opening = mountPanel(element, options).finally(() => { opening = undefined; });
    return opening;
  }

  async function mountPanel(element, { anchor, width = 252, extras = [], mount, onDismiss, onClose }) {
    try {
      if (active && !(await dismiss({hide: false}))) return;
      const doc = await childDocument();
      const home = document.createComment("付箋メニュー");
      element.before(home);
      const popover = element.getAttribute("popover");
      if (popover !== null) element.removeAttribute("popover");
      const current = {
        element, home, popover, hidden: element.hidden, anchor, onDismiss, onClose,
        extras: extras.map(extra => {
          const marker = document.createComment("確認");
          extra.before(marker);
          return [extra, marker];
        }),
      };
      active = current;
      element.hidden = false;
      doc.body.append(element, ...extras);
      mount?.();

      const position = focus => {
        if (active !== current) return Promise.resolve();
        const height = Math.ceil(element.getBoundingClientRect().height);
        return native("show_note_panel", { x: Math.round(current.anchor.x), y: Math.round(current.anchor.y), width, height, focus });
      };
      current.focus = () => position(true);
      // Size the wrapping controls at the final width before the first paint.
      doc.body.style.width = width + "px";
      await position(true);
      doc.body.style.width = "";
      if (active !== current) return;
      current.shown = true;
      current.observer = new ResizeObserver(() => { void position(false).catch(onError); });
      current.observer.observe(element);
    } catch (error) {
      close(element);
      onError(error);
      if (!active) void native("hide_note_panel").catch(onError);
    }
  }

  return { open, close, isOpen, dismiss, getElement: id => popup && !popup.closed ? popup.document.getElementById(id) : null };
}
