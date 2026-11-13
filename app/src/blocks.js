// ブロックの操作。各行を「ブロック」として扱い、行の左に出るつまみ(⋮⋮)から、
// 種類を切り替えたり(クリック)、ドラッグで動かしたりする。
// 中身は、行頭の記号の付け替えと、行の並べ替え・字下げの付け替えだけで、保存される内容は、Markdownのまま。
import { ViewPlugin } from "@codemirror/view";
import {
  blockTypeOf, convertLine, blockRange, fenceRange, moveBlock, siblingDest, indentTarget,
  indentOf, isListLine, childIndentOf,
} from "./block-model.js";

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

const DRAG_START_PX = 4;   // これだけ動いたら、クリックではなく、ドラッグとみなす
const CHILD_OFFSET_PX = 28; // 行の文字の始まりより、これだけ右へ落とすと、「子」にする

/** 行 `lineNo`(1始まり)を、種類 `type` に変える。 */
export function setBlockType(view, lineNo, type) {
  const { doc } = view.state;
  if (lineNo < 1 || lineNo > doc.lines) return;
  const line = doc.line(lineNo);
  const insert = convertLine(line.text, lineNo > 1 ? doc.line(lineNo - 1).text : "", type);
  if (insert === null) return;
  view.dispatch({ changes: { from: line.from, to: line.to, insert } });
}

const linesOf = (view) => view.state.doc.toString().split("\n");
const offsetOf = (lines, idx) => { let n = 0; for (let i = 0; i < idx; i++) n += lines[i].length + 1; return n; };

/** 行の並び `oldLines` → `newLines`(行数は同じ)の差を、変わった範囲だけの1つの変更として反映する。 */
function applyLines(view, oldLines, newLines, cursor) {
  const n = oldLines.length;
  if (newLines.length !== n) return false;
  let p = 0;
  while (p < n && oldLines[p] === newLines[p]) p++;
  if (p === n) return false;
  let s = 0;
  while (s < n - p - 1 && oldLines[n - 1 - s] === newLines[n - 1 - s]) s++;
  const { doc } = view.state;
  view.dispatch({
    changes: { from: doc.line(p + 1).from, to: doc.line(n - s).to, insert: newLines.slice(p, n - s).join("\n") },
    ...(cursor == null ? {} : { selection: { anchor: cursor }, scrollIntoView: true }),
    userEvent: "move.block",
  });
  return true;
}

/** Alt+↑ / Alt+↓: カーソルのあるブロックを、子ごと、兄弟の前後へ動かす。 */
export function moveBlockBy(view, dir) {
  const { doc, selection } = view.state;
  const head = selection.main.head;
  const lines = linesOf(view);
  const cur = doc.lineAt(head).number - 1;
  const [from, to] = blockRange(lines, cur);
  const dest = siblingDest(lines, from, to, dir);
  if (dest === null) return true; // 動かせなくても、キーは消費する(ほかの動作を出さない)
  const r = moveBlock(lines, from, to, dest, indentOf(lines[from]));
  if (!r) return true;
  const idx = r.start + (cur - from);
  const col = Math.min(head - doc.line(cur + 1).from, r.lines[idx].length);
  applyLines(view, lines, r.lines, offsetOf(r.lines, idx) + col);
  return true;
}

/** Tab / Shift+Tab: リストの行を、子ごと、1段深く・浅くする。リストの行でなければ、何もしない(false)。 */
export function indentBlockBy(view, dir) {
  const { doc, selection } = view.state;
  if (!selection.main.empty) return false;
  const head = selection.main.head;
  const lines = linesOf(view);
  const cur = doc.lineAt(head).number - 1;
  if (!isListLine(lines[cur]) || fenceRange(lines, cur)) return false;
  const [from, to] = blockRange(lines, cur);
  const ind = indentTarget(lines, from, dir);
  if (ind === null) return true;
  const r = moveBlock(lines, from, to, from, ind);
  if (!r) return true;
  const col = Math.max(0, head - doc.line(cur + 1).from + (ind - indentOf(lines[from])));
  applyLines(view, lines, r.lines, offsetOf(r.lines, cur) + Math.min(col, r.lines[cur].length));
  return true;
}

/** 行の左に出す、つまみ(⋮⋮)と、種類のメニュー、ドラッグでの移動。 */
export const blockHandle = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.line = 0;
      this.menu = null;
      this.press = null;   // つまみを押した位置 {x, y, line}
      this.drag = null;    // ドラッグ中 {lines, from, to, target}
      this.suppressClick = false;

      const h = (this.handle = document.createElement("button"));
      h.type = "button";
      h.className = "cm-block-handle";
      h.textContent = "⋮⋮";
      h.title = "クリック: ブロックの種類を変える / ドラッグ: 動かす";
      h.setAttribute("aria-label", "ブロックの操作");
      h.hidden = true;
      h.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 入力欄のカーソルを動かさない
        if (e.button === 0) this.press = { x: e.clientX, y: e.clientY, line: this.line };
      });
      h.addEventListener("click", () => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        this.toggleMenu();
      });
      view.dom.appendChild(h);

      const d = (this.dropLine = document.createElement("div"));
      d.className = "cm-drop-line";
      d.hidden = true;
      view.dom.appendChild(d);

      this.onMove = (e) => this.track(e);
      this.onLeave = () => { if (!this.menu && !this.drag) this.hide(); };
      this.onScroll = () => { if (!this.menu && !this.drag) this.hide(); };
      this.onDocDown = (e) => {
        if (this.menu && !this.menu.contains(e.target) && !this.handle.contains(e.target)) this.closeMenu();
      };
      this.onKey = (e) => {
        if (e.key !== "Escape") return;
        if (this.drag) { e.preventDefault(); this.endDrag(false); }
        else if (this.menu) { e.preventDefault(); this.closeMenu(); }
      };
      this.onDocMove = (e) => this.dragMove(e);
      this.onDocUp = () => {
        if (this.drag) { this.suppressClick = true; this.endDrag(true); setTimeout(() => { this.suppressClick = false; }, 0); }
        this.press = null;
      };
      view.dom.addEventListener("mousemove", this.onMove);
      view.dom.addEventListener("mouseleave", this.onLeave);
      view.scrollDOM.addEventListener("scroll", this.onScroll);
      document.addEventListener("mousedown", this.onDocDown, true);
      document.addEventListener("keydown", this.onKey, true);
      document.addEventListener("mousemove", this.onDocMove, true);
      document.addEventListener("mouseup", this.onDocUp, true);
    }

    /** マウスのある行に、つまみを合わせる。 */
    track(e) {
      if (this.menu || this.drag || this.press || this.handle.contains(e.target)) return;
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

    // ---- ドラッグでの移動 ----

    dragMove(e) {
      if (!this.press) return;
      const view = this.view;
      if (!this.drag) {
        if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < DRAG_START_PX) return;
        const lines = linesOf(view);
        const i = this.press.line - 1;
        if (i < 0 || i >= lines.length) { this.press = null; return; }
        const [from, to] = blockRange(lines, i);
        this.closeMenu();
        this.drag = { lines, from, to, target: null };
        view.dom.classList.add("cm-dragging");
      }
      e.preventDefault();
      // 端の近くでは、入力欄をスクロールする
      const sr = view.scrollDOM.getBoundingClientRect();
      if (e.clientY < sr.top + 14) view.scrollDOM.scrollTop -= 12;
      else if (e.clientY > sr.bottom - 14) view.scrollDOM.scrollTop += 12;
      this.drag.target = this.dropTarget(e.clientX, e.clientY);
      this.showDropLine(this.drag.target);
    }

    /** 落とす先を決める。落とせない場所(自分の上・中)なら null。 */
    dropTarget(x, y) {
      const view = this.view;
      const { doc } = view.state;
      const { lines, from, to } = this.drag;
      const content = view.contentDOM.getBoundingClientRect();
      const yy = Math.min(Math.max(y, content.top + 1), content.bottom - 1);
      const t = doc.lineAt(view.lineBlockAtHeight(yy - view.documentTop).from).number - 1;
      const fence = fenceRange(lines, t);
      const s = fence ? fence[0] : t;
      const e = fence ? fence[1] : t;
      if (s >= from && s <= to) return null; // 自分の上
      const top = view.lineBlockAt(doc.line(s + 1).from).top + view.documentTop;
      const bottom = view.lineBlockAt(doc.line(e + 1).from).bottom + view.documentTop;
      const blank = !lines[s].trim();
      const tIndent = blank ? 0 : indentOf(lines[s]);
      const textAt = view.coordsAtPos(doc.line(s + 1).from + Math.min(tIndent, lines[s].length));
      const textLeft = textAt ? textAt.left : content.left;
      let dest, indent, lineY, left = textLeft;
      if (yy < (top + bottom) / 2) {
        dest = s; indent = tIndent; lineY = top;                      // この行の前(同じ階層)
      } else {
        const ci = fence ? null : childIndentOf(lines[s]);
        if (ci !== null && x > textLeft + CHILD_OFFSET_PX) {
          dest = s + 1; indent = ci; lineY = bottom; left = textLeft + 22; // この行の子(先頭)
        } else {
          const end = fence ? e : blockRange(lines, s)[1];
          dest = end + 1; indent = tIndent;                            // この行(と、その子)の後ろ
          lineY = view.lineBlockAt(doc.line(end + 1).from).bottom + view.documentTop;
        }
      }
      if (dest > from && dest <= to) return null;
      if ((dest === from || dest === to + 1) && indent === indentOf(lines[from])) return null; // 同じ場所
      return { dest, indent, lineY, left };
    }

    showDropLine(target) {
      const d = this.dropLine;
      if (!target) { d.hidden = true; return; }
      const host = this.view.dom.getBoundingClientRect();
      d.style.top = `${target.lineY - host.top - 1}px`;
      d.style.left = `${Math.max(2, target.left - host.left)}px`;
      d.dataset.dest = String(target.dest);
      d.dataset.indent = String(target.indent);
      d.hidden = false;
    }

    endDrag(commit) {
      const { drag, view } = this;
      this.drag = null;
      this.press = null;
      this.dropLine.hidden = true;
      view.dom.classList.remove("cm-dragging");
      if (!commit || !drag || !drag.target) return;
      // ドラッグ中に、文字が変わっていたら(外部の更新など)、動かさない
      const now = linesOf(view);
      if (now.length !== drag.lines.length || now.some((l, i) => l !== drag.lines[i])) return;
      const r = moveBlock(drag.lines, drag.from, drag.to, drag.target.dest, drag.target.indent);
      if (r) applyLines(view, drag.lines, r.lines, null);
      view.focus();
    }

    // ---- 種類のメニュー ----

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
      this.dropLine.remove();
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.dom.removeEventListener("mouseleave", this.onLeave);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("mousedown", this.onDocDown, true);
      document.removeEventListener("keydown", this.onKey, true);
      document.removeEventListener("mousemove", this.onDocMove, true);
      document.removeEventListener("mouseup", this.onDocUp, true);
    }
  },
);
