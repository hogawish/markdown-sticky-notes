// トグル(折りたたみ)。子を持つリストの行と、見出しを、▸ / ▾ で開閉する。
// 折りたたみは見た目だけで、文字(保存される内容)は変わらない。開閉の状態は、このPCに覚える(note.js)。
// 対象は、見出しとリストだけにする(部品の標準の判定は、ただの段落まで対象にするので、使わない)。
import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { gutter, GutterMarker } from "@codemirror/view";
import { indentOf, isListLine } from "./block-model.js";

const HEADING_RE = /^(#{1,6})\s/;
const FENCE_RE = /^\s*```/;
const blank = (text) => !text.trim();

function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

/**
 * 行 lineNo(1始まり)から折りたためる範囲 {from, to}。対象でなければ null。
 * - リストの行: 子(より深く字下げした、続きの行)の終わりまで。
 * - 見出し: 次の、同じか上の階層の見出しの手前まで(末尾の空行は、含めない)。
 */
export function foldRangeAt(state, lineNo) {
  const { doc } = state;
  const line = doc.line(lineNo);
  if (blank(line.text) || inCode(state, line.from)) return null;
  let end = lineNo;
  const h = HEADING_RE.exec(line.text);
  if (h) {
    let fence = false;
    let last = doc.lines;
    for (let j = lineNo + 1; j <= doc.lines; j++) {
      const text = doc.line(j).text;
      if (FENCE_RE.test(text)) { fence = !fence; continue; }
      if (fence) continue;
      const m = HEADING_RE.exec(text);
      if (m && m[1].length <= h[1].length) { last = j - 1; break; }
    }
    while (last > lineNo && blank(doc.line(last).text)) last--;
    end = last;
  } else if (isListLine(line.text)) {
    const base = indentOf(line.text);
    for (let j = lineNo + 1; j <= doc.lines; j++) {
      const text = doc.line(j).text;
      if (blank(text)) {
        // 空行のあとに、まだ子が続くなら、含める
        let k = j + 1;
        while (k <= doc.lines && blank(doc.line(k).text)) k++;
        if (k <= doc.lines && indentOf(doc.line(k).text) > base) { j = k - 1; continue; }
        break;
      }
      if (indentOf(text) > base) end = j;
      else break;
    }
  } else {
    return null;
  }
  return end > lineNo ? { from: line.to, to: doc.line(end).to } : null;
}

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
    m.title = this.open ? "折りたたむ" : "開く";
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
    return foldRangeAt(view.state, n) ? new FoldMarker(true) : null;
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
];

/** 折りたたんでいる行(見出し・リストの行)の文字を、上から順に返す。 */
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
