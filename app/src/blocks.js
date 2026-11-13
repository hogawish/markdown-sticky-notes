// ブロックの操作。各行を「ブロック」として扱い、行の左に出るつまみ(⋮⋮)から、種類を切り替える。
// 中身は、行頭の記号(# - 1. > など)の付け替えだけで、保存される内容は、Markdownのまま。
import { ViewPlugin } from "@codemirror/view";
import { blockTypeOf, convertLine } from "./block-model.js";

/** [種類, 表示名, 記号] */
export const BLOCK_TYPES = [
  ["text", "テキスト", "T"],
  ["h1", "見出し1", "H1"],
  ["h2", "見出し2", "H2"],
  ["h3", "見出し3", "H3"],
  ["bullet", "箇条書き", "•"],
  ["number", "番号つきリスト", "1."],
  ["todo", "チェックボックス", "☐"],
  ["quote", "引用", "❝"],
  ["code", "コードブロック", "</>"],
];

/** 行 `lineNo`(1始まり)を、種類 `type` に変える。 */
export function setBlockType(view, lineNo, type) {
  const { doc } = view.state;
  if (lineNo < 1 || lineNo > doc.lines) return;
  const line = doc.line(lineNo);
  const insert = convertLine(line.text, lineNo > 1 ? doc.line(lineNo - 1).text : "", type);
  if (insert === null) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert } });
}

/** 行の左に出す、つまみ(⋮⋮)と、種類のメニュー。 */
export const blockHandle = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.line = 0;
      this.menu = null;
      const h = (this.handle = document.createElement("button"));
      h.type = "button";
      h.className = "cm-block-handle";
      h.textContent = "⋮⋮";
      h.title = "クリック: ブロックの種類を変える";
      h.setAttribute("aria-label", "ブロックの操作");
      h.hidden = true;
      h.addEventListener("mousedown", (e) => e.preventDefault()); // 入力欄のカーソルを動かさない
      h.addEventListener("click", () => this.toggleMenu());
      view.dom.appendChild(h);

      this.onMove = (e) => this.track(e);
      this.onLeave = () => { if (!this.menu) this.hide(); };
      this.onScroll = () => { if (!this.menu) this.hide(); };
      this.onDocDown = (e) => {
        if (this.menu && !this.menu.contains(e.target) && !this.handle.contains(e.target)) this.closeMenu();
      };
      this.onKey = (e) => { if (e.key === "Escape" && this.menu) { e.preventDefault(); this.closeMenu(); } };
      view.dom.addEventListener("mousemove", this.onMove);
      view.dom.addEventListener("mouseleave", this.onLeave);
      view.scrollDOM.addEventListener("scroll", this.onScroll);
      document.addEventListener("mousedown", this.onDocDown, true);
      document.addEventListener("keydown", this.onKey, true);
    }

    /** マウスのある行に、つまみを合わせる。 */
    track(e) {
      if (this.menu || this.handle.contains(e.target)) return;
      const view = this.view;
      const rect = view.contentDOM.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom) { this.hide(); return; }
      const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
      this.place(view.state.doc.lineAt(block.from).number);
    }

    place(lineNo) {
      const view = this.view;
      const c = view.coordsAtPos(view.state.doc.line(lineNo).from);
      if (!c) { this.hide(); return; }
      const host = view.dom.getBoundingClientRect();
      this.line = lineNo;
      const h = this.handle;
      h.style.top = `${c.top - host.top}px`;
      h.style.height = `${c.bottom - c.top}px`;
      h.dataset.line = String(lineNo);
      h.hidden = false;
    }

    hide() { this.handle.hidden = true; }

    toggleMenu() {
      if (this.menu) { this.closeMenu(); return; }
      const view = this.view;
      if (this.line < 1 || this.line > view.state.doc.lines) return;
      const m = document.createElement("div");
      m.className = "cm-block-menu";
      m.setAttribute("role", "menu");
      const cur = blockTypeOf(view.state.doc.line(this.line).text);
      for (const [type, label, icon] of BLOCK_TYPES) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.type = type;
        b.setAttribute("role", "menuitem");
        if (type === cur) b.classList.add("cur");
        const i = document.createElement("span");
        i.className = "ic";
        i.textContent = icon;
        const t = document.createElement("span");
        t.textContent = label;
        b.append(i, t);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          const lineNo = this.line;
          this.closeMenu();
          setBlockType(view, lineNo, type);
          view.focus();
        });
        m.appendChild(b);
      }
      view.dom.appendChild(m);
      // つまみの下に出す。入力欄からはみ出すなら、上へ。それでも入らなければ、中でスクロールする
      const host = view.dom.getBoundingClientRect();
      const hr = this.handle.getBoundingClientRect();
      m.style.maxHeight = `${Math.max(60, host.height - 8)}px`;
      const mh = m.offsetHeight;
      let top = hr.bottom - host.top + 2;
      if (top + mh > host.height) top = hr.top - host.top - mh - 2;
      if (top < 2) top = Math.max(2, host.height - mh - 4);
      m.style.top = `${top}px`;
      this.menu = m;
    }

    closeMenu() {
      if (this.menu) { this.menu.remove(); this.menu = null; }
    }

    update(u) {
      // 文字が変わったら、行の位置がずれるので、いったん隠す(次にマウスが動いたら、また出る)
      if (u.docChanged) { this.closeMenu(); this.hide(); }
    }

    destroy() {
      this.closeMenu();
      this.handle.remove();
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.dom.removeEventListener("mouseleave", this.onLeave);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("mousedown", this.onDocDown, true);
      document.removeEventListener("keydown", this.onKey, true);
    }
  },
);
