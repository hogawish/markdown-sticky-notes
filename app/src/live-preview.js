// ライブプレビュー: カーソルのない行では、Markdownの記号を隠して、整形して見せる。
// 隠すのは見た目だけで、下にある文字(保存される内容)は一字も変わらない。
// カーソルのある行(選択の両端の行)だけは、記号を出す。記号を直したり、消したりできるように。
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { Compartment, Facet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { togglePrefixLength } from "./block-model.js";

/** ライブプレビューを使うか。false なら、記号を常に出す(Markdownの原文のまま)。 */
export const livePreviewFlag = Facet.define({ combine: (v) => (v.length ? v[v.length - 1] : true) });
export const liveCompartment = new Compartment();

// 文字色のspan(editor.js と同じ書き方)
const SPAN_RE = /<span style="color:\s*([a-zA-Z]+|#[0-9a-fA-F]{3,8})\s*;?">(.*?)<\/span>/g;
const CLOSE_LEN = "</span>".length;

const hideDeco = Decoration.replace({});
const quoteLine = Decoration.line({ class: "cm-quote-line" });
const doneMark = Decoration.mark({ class: "cm-task-done" });

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-hr";
    return s;
  }
}

/** チェックボックス。クリックで、`[ ]` と `[x]` を入れ替える(その1文字だけを書き換える)。 */
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos; // `[` の位置
  }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "完了を外す" : "完了にする");
    box.addEventListener("mousedown", (e) => e.preventDefault()); // カーソルを動かさない
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const cur = view.state.sliceDoc(this.pos, this.pos + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return; // 文字が、もう変わっていたら、何もしない
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: /[xX]/.test(cur[1]) ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

function build(view) {
  const { state } = view;
  if (!state.facet(livePreviewFlag)) return { deco: Decoration.none, atomic: Decoration.none };

  // カーソル(選択の両端)がある行は、記号を出す
  const active = new Set();
  for (const r of state.selection.ranges) {
    active.add(state.doc.lineAt(r.from).number);
    active.add(state.doc.lineAt(r.to).number);
  }
  const lineOf = (pos) => state.doc.lineAt(pos).number;
  const all = [];
  const hidden = []; // 隠す・差し替える範囲(カーソルが飛び越えるようにする)

  // 1行の中に収まる範囲だけを、カーソルのない行で隠す(行をまたぐ置き換えは、ここでは扱えない)
  const usable = (from, to) => to > from && lineOf(from) === lineOf(to) && !active.has(lineOf(from));
  const hide = (from, to) => {
    if (!usable(from, to)) return;
    const r = hideDeco.range(from, to);
    all.push(r);
    hidden.push(r);
  };
  const replaceWith = (from, to, widget) => {
    if (!usable(from, to)) return;
    const r = Decoration.replace({ widget }).range(from, to);
    all.push(r);
    hidden.push(r);
  };

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(n) {
        switch (n.name) {
          case "HeaderMark": {
            const parent = n.node.parent;
            if (parent && parent.name.startsWith("ATXHeading")) {
              // `# ` の、あとに続く空白も、一緒に隠す
              const line = state.doc.lineAt(n.from);
              let end = n.to;
              while (end < line.to && /[ \t]/.test(state.sliceDoc(end, end + 1))) end++;
              hide(n.from, end);
            } else if (parent && parent.name.startsWith("SetextHeading")) {
              hide(n.from, n.to);
            }
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
          case "CodeMark": // インラインコードの ` と、コードブロックの ```
          case "CodeInfo": // コードブロックの言語名
            hide(n.from, n.to);
            break;
          case "QuoteMark": {
            const end = state.sliceDoc(n.to, n.to + 1) === " " ? n.to + 1 : n.to;
            hide(n.from, end);
            break;
          }
          case "Blockquote": {
            let pos = n.from;
            while (pos <= n.to) {
              const line = state.doc.lineAt(pos);
              all.push(quoteLine.range(line.from));
              pos = line.to + 1;
            }
            break;
          }
          case "ListMark": {
            if (togglePrefixLength(state.doc.lineAt(n.from).text)) break;
            const item = n.node.parent;
            const list = item && item.parent;
            // 箇条書きの - * + を、「•」にする(チェックボックスの行は、下のTaskMarkerで扱う)。番号は、そのまま
            if (list && list.name === "BulletList" && !item.getChild("Task")) replaceWith(n.from, n.to, new BulletWidget());
            break;
          }
          case "TaskMarker": {
            const task = n.node.parent;
            const item = task && task.parent;
            const mark = item && item.getChild("ListMark");
            const checked = /x/i.test(state.sliceDoc(n.from, n.to));
            // `- [ ]` をまとめて、チェックボックスに差し替える
            const start = mark && lineOf(mark.from) === lineOf(n.from) ? mark.from : n.from;
            replaceWith(start, n.to, new CheckboxWidget(checked, n.from));
            if (checked) {
              const line = state.doc.lineAt(n.to);
              if (line.to > n.to) all.push(doneMark.range(n.to, line.to));
            }
            break;
          }
          case "HorizontalRule":
            replaceWith(n.from, n.to, new RuleWidget());
            break;
          case "Link": {
            // [ラベル](URL "タイトル") → ラベルだけを、リンクの見た目で出す
            const marks = [];
            let hasUrl = false;
            for (let c = n.node.firstChild; c; c = c.nextSibling) {
              if (c.name === "LinkMark") marks.push(c);
              else if (c.name === "URL") hasUrl = true;
            }
            if (hasUrl && marks.length >= 4) {
              hide(marks[0].from, marks[0].to);
              hide(marks[1].from, n.to);
              if (marks[1].from > marks[0].to) {
                // リンク先は、マウスを乗せると出る(URLの部分は、隠れているため)
                const url = n.node.getChild("URL");
                const title = `${state.sliceDoc(url.from, url.to)}
Ctrl+クリックで開く / 右クリックで編集`;
                all.push(Decoration.mark({ class: "cm-link-label", attributes: { title } }).range(marks[0].to, marks[1].from));
              }
            }
            break;
          }
          default:
        }
      },
    });

    // 文字色の <span style="color:…">…</span>: カーソルのない行では、タグを隠して、色のついた文字だけを出す
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (!active.has(line.number)) {
        for (const m of line.text.matchAll(SPAN_RE)) {
          const s = line.from + m.index;
          const e = s + m[0].length;
          hide(s, s + m[0].indexOf(">") + 1);
          hide(e - CLOSE_LEN, e);
        }
      }
      pos = line.to + 1;
    }
  }
  return { deco: Decoration.set(all, true), atomic: Decoration.set(hidden, true) };
}

export const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      const r = build(view);
      this.decorations = r.deco;
      this.atomic = r.atomic;
    }
    update(u) {
      if (
        u.docChanged || u.viewportChanged || u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some((tr) => tr.reconfigured)
      ) {
        const r = build(u.view);
        this.decorations = r.deco;
        this.atomic = r.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // 隠した記号の中には、カーソルを置かない(矢印キーで、飛び越える)
    provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomic ?? Decoration.none),
  },
);
