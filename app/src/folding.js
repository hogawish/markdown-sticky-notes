// トグルとして指定された行だけ、字下げした子を開閉できる。
import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
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

class FoldMarker extends GutterMarker {
  constructor(open) { super(); this.open = open; }
  eq(other) { return other.open === this.open; }
  toDOM() {
    const m = document.createElement("span");
    m.className = "cm-fold-marker";
    m.textContent = this.open ? "▾" : "▸";
    m.title = this.open === null ? "子を追加すると開閉できます" : this.open ? "折りたたむ" : "開く";
    if (this.open === null) m.classList.add("cm-fold-empty");
    return m;
  }
}

/** この更新で、開閉が変わったか。 */
export const foldChanged = (update) =>
  update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));

const foldColumn = gutter({
  class: "cm-foldGutter",
  lineMarker(view, block) {
    const n = view.state.doc.lineAt(block.from).number;
    if (foldedAt(view.state, n)) return new FoldMarker(false);
    if (foldRangeAt(view.state, n)) return new FoldMarker(true);
    const line = view.state.doc.line(n);
    return togglePrefixLength(line.text) && !inCode(view.state, line.from) ? new FoldMarker(null) : null;
  },
  lineMarkerChange: (u) => u.docChanged || u.viewportChanged || foldChanged(u),
  initialSpacer: () => new FoldMarker(true),
  domEventHandlers: {
    mousedown(view, block, event) {
      const n = view.state.doc.lineAt(block.from).number;
      const folded = foldedAt(view.state, n);
      const range = folded || foldRangeAt(view.state, n);
      if (!range) return false;
      event.preventDefault(); // カーソルを動かさない
      view.dispatch({ effects: (folded ? unfoldEffect : foldEffect).of(range) });
      return true;
    },
  },
});

export const foldExtensions = [
  codeFolding({
    // 折りたたんだ所に、隠れている行数を出す。クリックで開く
    preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
    placeholderDOM(_view, onclick, count) {
      const chip = document.createElement("span");
      chip.className = "cm-fold-chip";
      chip.textContent = `… ${count}行`;
      chip.title = "クリックで開く";
      chip.setAttribute("aria-label", `折りたたんだ${count}行を開く`);
      chip.onclick = onclick;
      return chip;
    },
  }),
  foldColumn,
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
