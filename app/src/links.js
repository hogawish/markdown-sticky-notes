// リンクの操作。文字を選んで右クリック →「リンクを貼る…」、リンクの上で右クリック → 開く・編集・外す・URLをコピー。
// 書き込むのは、Markdownの [文字](URL) だけ。
import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const URL_RE = /https?:\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]/g;
const IS_URL = /^https?:\/\/\S+$/;

/** pos にあるリンク。[文字](URL) なら kind="md"、素のURLなら kind="bare"。無ければ null。 */
export function linkAt(state, pos) {
  for (const side of [1, -1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name !== "Link") continue;
      const url = n.getChild("URL");
      const marks = n.getChildren("LinkMark");
      if (!url || marks.length < 2) break;
      return {
        kind: "md", from: n.from, to: n.to,
        label: state.sliceDoc(marks[0].to, marks[1].from).replace(/\\([\[\]])/g, "$1"),
        url: state.sliceDoc(url.from, url.to),
      };
    }
  }
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(URL_RE)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return { kind: "bare", from, to: from + m[0].length, label: m[0], url: m[0] };
  }
  return null;
}

/** 入力されたURLを整える。空なら null。スキームが無ければ https:// を付ける。 */
export function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  return s.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export const mdLink = (label, url) => `[${label.replace(/([\[\]])/g, "\\$1")}](${url})`;

function openExternal(url) {
  const o = window.__TAURI__ && window.__TAURI__.opener;
  if (o && o.openUrl) o.openUrl(url).catch(() => {});
  else window.open(url, "_blank");
}

export const linkUI = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.menu = null;
      this.pop = null;
      this.onContext = (e) => this.contextMenu(e);
      this.onDocDown = (e) => {
        if (this.menu && !this.menu.contains(e.target)) this.closeMenu();
        if (this.pop && !this.pop.contains(e.target)) this.closePop(false);
      };
      this.onKey = (e) => {
        if (e.key !== "Escape") return;
        if (this.menu) { e.preventDefault(); this.closeMenu(); }
        else if (this.pop) { e.preventDefault(); this.closePop(true); }
      };
      view.dom.addEventListener("contextmenu", this.onContext);
      document.addEventListener("mousedown", this.onDocDown, true);
      document.addEventListener("keydown", this.onKey, true);
    }

    /** 右クリック: 文字を選んでいるか、リンクの上なら、専用のメニューを出す(それ以外は、標準のメニューのまま)。 */
    contextMenu(e) {
      const view = this.view;
      if ((this.menu && this.menu.contains(e.target)) || (this.pop && this.pop.contains(e.target))) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const sel = view.state.selection.main;
      const inSel = !sel.empty && pos >= sel.from && pos <= sel.to;
      const link = linkAt(view.state, pos);
      if (!inSel && !link) return;
      e.preventDefault();
      const items = [];
      if (link) {
        items.push(["open", "↗ リンクを開く", () => openExternal(link.url)]);
        items.push(["edit", "✎ リンクを編集…", () => this.openPop({ from: link.from, to: link.to, label: link.label, url: link.url })]);
        if (link.kind === "md") items.push(["unlink", "✕ リンクを外す", () => this.replace(link.from, link.to, link.label)]);
        items.push(["copy-url", "⧉ URLをコピー", () => { navigator.clipboard.writeText(link.url).catch(() => {}); }]);
      } else {
        const text = view.state.sliceDoc(sel.from, sel.to);
        if (!text.includes("\n")) items.push(["link", "🔗 リンクを貼る…", () => this.openPop({ from: sel.from, to: sel.to, label: text, url: "" })]);
      }
      if (inSel) {
        items.push(["cut", "切り取り", () => { view.focus(); document.execCommand("cut"); }]);
        items.push(["copy", "コピー", () => { view.focus(); document.execCommand("copy"); }]);
      }
      this.showMenu(items, e.clientX, e.clientY);
    }

    showMenu(items, x, y) {
      this.closeMenu();
      this.closePop(false);
      const view = this.view;
      const m = document.createElement("div");
      m.className = "cm-block-menu cm-ctx-menu";
      m.setAttribute("role", "menu");
      for (const [id, label, run] of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.act = id;
        b.setAttribute("role", "menuitem");
        b.textContent = label;
        b.addEventListener("mousedown", (e) => e.preventDefault()); // 選択範囲を外さない
        b.addEventListener("click", () => { this.closeMenu(); run(); });
        m.appendChild(b);
      }
      view.dom.appendChild(m);
      this.place(m, x, y);
      this.menu = m;
    }

    /** 入力欄の中に収まるように、(x, y) の近くへ置く。 */
    place(el, x, y) {
      const host = this.view.dom.getBoundingClientRect();
      el.style.maxHeight = `${Math.max(60, host.height - 8)}px`;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(2, Math.min(x - host.left, host.width - w - 4));
      let top = y - host.top + 2;
      if (top + h > host.height) top = Math.max(2, y - host.top - h - 2);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    closeMenu() { if (this.menu) { this.menu.remove(); this.menu = null; } }

    replace(from, to, insert) {
      this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      this.view.focus();
    }

    /** URLの入力欄を出す。target = { from, to, label, url }(from〜to を、[label](URL) に置き換える)。 */
    openPop(target) {
      this.closeMenu();
      this.closePop(false);
      const view = this.view;
      const pop = document.createElement("form");
      pop.className = "cm-link-pop";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "https://…";
      input.setAttribute("aria-label", "リンク先のURL");
      input.spellcheck = false;
      input.value = target.url || "";
      const okBtn = document.createElement("button");
      okBtn.type = "submit";
      okBtn.textContent = "OK";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => this.closePop(true));
      pop.append(input, okBtn, cancel);
      pop.addEventListener("submit", (e) => {
        e.preventDefault();
        // 途中で文字が変わっていたら(外部の更新など)、貼らない
        if (view.state.sliceDoc(target.from, target.to) !== this.popSnapshot) { this.closePop(true); return; }
        const url = normalizeUrl(input.value);
        this.closePop(false);
        if (url) this.replace(target.from, target.to, mdLink(target.label, url));
        else view.focus();
      });
      this.popSnapshot = view.state.sliceDoc(target.from, target.to);
      view.dom.appendChild(pop);
      const c = view.coordsAtPos(target.from) || view.dom.getBoundingClientRect();
      this.place(pop, c.left, c.bottom);
      this.pop = pop;
      input.focus();
      input.select();
    }

    closePop(refocus) {
      if (!this.pop) return;
      this.pop.remove();
      this.pop = null;
      if (refocus) this.view.focus();
    }

    update(u) {
      if (u.docChanged) { this.closeMenu(); }
    }

    destroy() {
      this.closeMenu();
      this.closePop(false);
      this.view.dom.removeEventListener("contextmenu", this.onContext);
      document.removeEventListener("mousedown", this.onDocDown, true);
      document.removeEventListener("keydown", this.onKey, true);
    }
  },
);

/** Ctrl+K: 文字を選んでいれば、URLの入力欄を出す。リンクの中なら、編集。どちらでもなければ false(従来の動き)。 */
export function linkCommandUI(view) {
  const ui = view.plugin(linkUI);
  if (!ui) return false;
  const sel = view.state.selection.main;
  const link = linkAt(view.state, sel.head);
  if (link && sel.from >= link.from && sel.to <= link.to) {
    ui.openPop({ from: link.from, to: link.to, label: link.label, url: link.url });
    return true;
  }
  if (sel.empty) return false;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (text.includes("\n") || IS_URL.test(text.trim())) return false;
  ui.openPop({ from: sel.from, to: sel.to, label: text, url: "" });
  return true;
}

/** 文字を選んだ状態でURLを貼り付けると、その文字のリンクにする(Obsidian・Notionと同じ)。 */
export const pasteUrlAsLink = EditorView.domEventHandlers({
  paste(e, view) {
    const sel = view.state.selection.main;
    if (sel.empty || !e.clipboardData) return false;
    const url = e.clipboardData.getData("text/plain").trim();
    if (!IS_URL.test(url)) return false;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (text.includes("\n") || IS_URL.test(text.trim()) || linkAt(view.state, sel.from)) return false; // URLの置き換え・リンクの中は、普通の貼り付け
    e.preventDefault();
    const insert = mdLink(text, normalizeUrl(url));
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.paste" });
    return true;
  },
});
