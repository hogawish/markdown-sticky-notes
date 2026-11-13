// トグルとして指定された行だけ、字下げした子を開閉できる。
import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { livePreviewFlag } from "./live-preview.js";
import { indentOf, togglePrefixLength } from "./block-model.js";

function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

function toggleChildRange(doc, lineNo) {
  const line = doc.line(lineNo);
  if (!togglePrefixLength(line.text)) return null;
  const base = indentOf(line.text);
  let end = lineNo;
  for (let next = lineNo + 1; next <= doc.lines; next++) {
    const text = doc.line(next).text;
    if (!text.trim()) continue;
    if (indentOf(text) <= base) break;
    end = next;
  }
  return end > lineNo ? { from: line.to, to: doc.line(end).to } : null;
}

export function foldRangeAt(state, lineNo) {
  const range = toggleChildRange(state.doc, lineNo);
  return range && !inCode(state, state.doc.line(lineNo).from) ? range : null;
}

// 型を変えたり子の階層を変えたりしたとき、古い範囲を隠したままにしない。
const unfoldChangedToggles = EditorState.transactionExtender.of(transaction => {
  if (!transaction.docChanged) return null;
  const effects = [];
  const doc = transaction.newDoc;
  foldedRanges(transaction.startState).between(0, transaction.startState.doc.length, (from, to) => {
    const mappedFrom = transaction.changes.mapPos(from, 1);
    const mappedTo = transaction.changes.mapPos(to, -1);
    if (mappedFrom >= mappedTo) return;
    const range = toggleChildRange(doc, doc.lineAt(mappedFrom).number);
    if (range?.from !== mappedFrom || range?.to !== mappedTo) {
      effects.push(unfoldEffect.of({ from: mappedFrom, to: mappedTo }));
    }
  });
  return effects.length ? { effects } : null;
});

/** 行 lineNo が、いま折りたたまれていれば、その範囲。 */
function foldedAt(state, lineNo) {
  const line = state.doc.line(lineNo);
  let found = null;
  foldedRanges(state).between(line.to, line.to, (from, to) => { if (from === line.to) found = { from, to }; });
  return found;
}

class FoldMarker extends WidgetType {
  constructor(open) {
    super();
    this.open = open;
  }

  eq(other) { return other.open === this.open; }

  toDOM(view) {
    const marker = document.createElement(this.open === null ? "span" : "button");
    marker.className = "cm-fold-marker";
    marker.textContent = this.open ? "▾" : "▸";
    if (this.open === null) {
      marker.classList.add("cm-fold-empty");
      marker.title = "子を追加すると開閉できます";
    } else {
      marker.type = "button";
      marker.title = this.open ? "折りたたむ" : "開く";
      marker.setAttribute("aria-label", marker.title);
      marker.setAttribute("aria-expanded", String(this.open));
      marker.addEventListener("mousedown", event => event.preventDefault());
      marker.addEventListener("click", () => {
        const state = view.state;
        const line = state.doc.lineAt(view.posAtDOM(marker));
        const folded = foldedAt(state, line.number);
        const range = folded || foldRangeAt(state, line.number);
        if (range) view.dispatch({ effects: (folded ? unfoldEffect : foldEffect).of(range) });
      });
    }
    return marker;
  }
}

/** この更新で、開閉が変わったか。 */
export const foldChanged = (update) =>
  update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));

const foldMarkers = ViewPlugin.fromClass(class {
  constructor(view) { this.build(view); }

  update(update) {
    if (update.docChanged || update.viewportChanged || foldChanged(update) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.facet(livePreviewFlag) !== update.state.facet(livePreviewFlag)) {
      this.build(update.view);
    }
  }

  build(view) {
    const { state } = view;
    const preview = state.facet(livePreviewFlag);
    const ranges = [];
    const seen = new Set();
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        if (seen.has(line.number)) continue;
        seen.add(line.number);
        const prefix = togglePrefixLength(line.text);
        if (!prefix || inCode(state, line.from)) continue;

        const start = line.from + indentOf(line.text);
        const open = foldedAt(state, line.number) ? false : foldRangeAt(state, line.number) ? true : null;
        const widget = new FoldMarker(open);
        // 字下げを残し、トグル記号の位置に矢印を置く。
        ranges.push(preview
          ? Decoration.replace({ widget }).range(start, line.from + prefix)
          : Decoration.widget({ widget, side: -1 }).range(start));
      }
    }
    this.decorations = Decoration.set(ranges, true);
  }
}, {
  decorations: plugin => plugin.decorations,
  provide: plugin => EditorView.atomicRanges.of(view =>
    view.state.facet(livePreviewFlag) ? view.plugin(plugin)?.decorations ?? Decoration.none : Decoration.none),
});

export const foldExtensions = [
  codeFolding({
    // 折りたたみのバッジには、直下の子だけを数える。
    preparePlaceholder(state, range) {
      const { doc } = state;
      const first = doc.lineAt(range.from).number + 1;
      const last = doc.lineAt(range.to).number;
      let childIndent = Infinity;
      let count = 0;
      for (let number = first; number <= last; number++) {
        const { text } = doc.line(number);
        if (!text.trim()) continue;
        const indent = indentOf(text);
        if (indent <= childIndent) {
          childIndent = indent;
          count++;
        }
      }
      return count;
    },
    placeholderDOM(_view, onclick, count) {
      const chip = document.createElement("span");
      chip.className = "cm-fold-chip";
      chip.textContent = `… ${count}行`;
      chip.title = `直下の子が${count}行（クリックで開く）`;
      chip.setAttribute("aria-label", `直下に${count}行あるトグルを開く`);
      chip.onclick = onclick;
      return chip;
    },
  }),
  foldMarkers,
  unfoldChangedToggles,
];

/** 折りたたんでいるトグル行の文字を、上から順に返す。 */
export function foldedTexts(state) {
  const out = [];
  foldedRanges(state).between(0, state.doc.length, (from) => { out.push(state.doc.lineAt(from).text); });
  return out;
}

/** `texts` の行を、折りたたむ。同じ文字の行が複数あれば、上から順に当てる。すでに折りたたんでいる行は、数に入れる。 */
export function refold(view, texts) {
  if (!texts || !texts.length) return;
  const { state } = view;
  const want = new Map();
  for (const t of texts) want.set(t, (want.get(t) || 0) + 1);
  const effects = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const left = want.get(line.text);
    if (!left) continue;
    if (foldedAt(state, n)) { want.set(line.text, left - 1); continue; }
    const range = foldRangeAt(state, n);
    if (!range) continue;
    effects.push(foldEffect.of(range));
    want.set(line.text, left - 1);
  }
  if (effects.length) view.dispatch({ effects });
}
