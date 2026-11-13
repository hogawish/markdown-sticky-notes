// ブロック(行)の種類の判定と変換。文字だけを扱い、画面には依存しない(単体試験できる)。
// 行頭の記号(# - 1. > など)を付け替えるだけで、本文と字下げは保つ。

// 行頭: (字下げ)(見出し | 引用 | リストの記号 と チェックボックス)
const PREFIX_RE = /^(\s*)(#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;
const TOGGLE_RE = /^([ \t]*)-[ \t]+\[>\](?:[ \t]+|$)/;
export const togglePrefixLength = text => TOGGLE_RE.exec(text)?.[0].length ?? 0;
const FENCE_RE = /^\s*```/;

/** 行の文字から、ブロックの種類を返す。見出し4〜6は null(メニューに無い)。 */
export function blockTypeOf(text) {
  if (FENCE_RE.test(text)) return "code";
  if (togglePrefixLength(text)) return "toggle";
  const p = PREFIX_RE.exec(text)[2] || "";
  if (p.startsWith("#")) {
    const n = p.trim().length;
    return n <= 3 ? `h${n}` : null;
  }
  if (p.startsWith(">")) return "quote";
  if (/\[[ xX]\]/.test(p)) return "todo";
  if (/^\d/.test(p)) return "number";
  if (/^[-*+]/.test(p)) return "bullet";
  return "text";
}

/**
 * 行 `text` を、種類 `type` に変えた文字を返す(変わらない・変えられないときは null)。
 * `prevText` は、直前の行(番号つきリストの、次の番号を決めるため)。
 */
export function convertLine(text, prevText, type) {
  if (FENCE_RE.test(text)) return null; // コードの囲みの行は、変えない
  const m = TOGGLE_RE.exec(text) || PREFIX_RE.exec(text);
  const old = m[2] || "";
  const body = text.slice(m[0].length);
  let indent = m[1];
  let out;
  if (type === "code") {
    out = "```\n" + body + "\n```";
  } else {
    let prefix = { text: "", h1: "# ", h2: "## ", h3: "### ", bullet: "- ", toggle: "- [>] ", todo: "- [ ] ", quote: "> " }[type];
    if (type === "number") {
      // 直前の行が、同じ字下げの番号つきなら、その次の番号にする
      let n = 1;
      const pm = /^(\s*)(\d+)[.)]\s/.exec(prevText || "");
      if (pm && pm[1] === indent) n = Number(pm[2]) + 1;
      prefix = `${n}. `;
    }
    if (type === "todo" && /\[[xX]\]/.test(old)) prefix = "- [x] "; // チェック済みは、保つ
    if (prefix === undefined) return null;
    if (/^h\d$/.test(type)) indent = ""; // 字下げした見出しは、見出しにならないことがある
    out = indent + prefix + body;
  }
  return out === text ? null : out;
}

// ---- ブロックの移動(行の並べ替えと、字下げの付け替え) ----------------------------------

const LIST_RE = /^(\s*)((?:[-*+]|\d+[.)])\s+)/;
const NUM_RE = /^(\s*)(\d+)([.)])(\s+)/;
export const indentOf = (text) => /^\s*/.exec(text)[0].length;
const isBlank = (text) => !text.trim();
export const isListLine = (text) => LIST_RE.test(text);

/** リストの行の、子の字下げ(記号の幅ぶん)。リストでなければ null。 */
export function childIndentOf(text) {
  const m = LIST_RE.exec(text);
  return m ? m[1].length + m[2].length : null;
}

/** 行 i が、コードの囲み(```)の中なら、その範囲 [start, end]。そうでなければ null。 */
export function fenceRange(lines, i) {
  let open = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!FENCE_RE.test(lines[k])) continue;
    if (open < 0) { open = k; continue; }
    if (i >= open && i <= k) return [open, k];
    if (k > i) return null;
    open = -1;
  }
  return open >= 0 && i >= open ? [open, lines.length - 1] : null;
}

/**
 * 行 i から始まるブロックの範囲 [start, end](end を含む)。
 * - コードの囲みは、囲み全体。
 * - リストの行は、その子(より深く字下げした、続きの行)を含む。
 * - それ以外は、その1行。
 */
export function blockRange(lines, i) {
  const fence = fenceRange(lines, i);
  if (fence) return fence;
  if (isBlank(lines[i]) || !isListLine(lines[i])) return [i, i];
  const base = indentOf(lines[i]);
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) {
      // 空行のあとに、まだ子が続くなら、空行もブロックに含める
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length && indentOf(lines[k]) > base) { j = k - 1; continue; }
      break;
    }
    if (indentOf(lines[j]) > base) end = j;
    else break;
  }
  return [i, end];
}

/**
 * 番号つきリストの、行 idx を含む並び(同じ字下げ)を、上から順に振り直す。
 * moved=true は、動かしてきたブロックの先頭。並びの先頭になったら、兄弟がいなくても、1から始める。
 */
export function renumber(lines, idx, moved = false) {
  if (idx < 0 || idx >= lines.length) return;
  const m = NUM_RE.exec(lines[idx]);
  if (!m) return;
  const ind = m[1].length;
  const sibling = (k) => { const x = NUM_RE.exec(lines[k]); return x && x[1].length === ind; };
  let first = idx;
  for (let k = idx - 1; k >= 0; k--) {
    if (isBlank(lines[k])) break;
    const d = indentOf(lines[k]);
    if (d > ind) continue;      // 上の項目の子
    if (d === ind && sibling(k)) { first = k; continue; }
    break;
  }
  let n = first === idx ? 1 : Number(NUM_RE.exec(lines[first])[2]);
  if (first === idx) {
    // 並びの先頭: 動かしてきた項目か、次の兄弟が番号つきなら、1から。そうでなければ、そのまま
    let has = false;
    for (let k = idx + 1; k < lines.length && !isBlank(lines[k]); k++) {
      const d = indentOf(lines[k]);
      if (d > ind) continue;
      has = d === ind && sibling(k);
      break;
    }
    if (!has && !moved) return;
  }
  for (let k = first; k < lines.length; k++) {
    if (isBlank(lines[k])) break;
    const d = indentOf(lines[k]);
    if (d > ind) continue;
    if (d < ind || !sibling(k)) break;
    const x = NUM_RE.exec(lines[k]);
    lines[k] = `${x[1]}${n++}${x[3]}${x[4]}${lines[k].slice(x[0].length)}`;
  }
}

/**
 * ブロック [from, to] を、元の並びの「dest 行目の前」へ動かし、先頭の字下げを indent にする。
 * 子の字下げは、相対のまま保つ。動かない・自分の中へ落とすときは null。
 * 戻り値: { lines, start, end }(動かしたあとの並びと、ブロックの新しい範囲)。
 */
export function moveBlock(lines, from, to, dest, indent) {
  if (from < 0 || to >= lines.length || from > to) return null;
  if (dest > from && dest <= to) return null;                      // 自分の中へは、落とせない
  const base = indentOf(lines[from]);
  if ((dest === from || dest === to + 1) && indent === base) return null; // 同じ場所
  const block = lines.slice(from, to + 1).map((l) =>
    isBlank(l) ? l : " ".repeat(Math.max(0, indentOf(l) - base + indent)) + l.trimStart());
  const rest = [...lines.slice(0, from), ...lines.slice(to + 1)];
  const at = dest <= from ? dest : dest - (to - from + 1);
  rest.splice(at, 0, ...block);
  const end = at + block.length - 1;
  // 番号つきリストは、動かした先と、抜けた元の並びを、振り直す
  renumber(rest, at, true);
  if (end + 1 < rest.length) renumber(rest, end + 1);
  const src = dest <= from ? to + 1 : from;                         // 元の場所の、次の行
  if (src < rest.length) renumber(rest, src);
  return { lines: rest, start: at, end };
}

/** キー(Alt+↑↓)での移動先。兄弟の前後へ動かす。動かせないときは null(dest を返す)。 */
export function siblingDest(lines, from, to, dir) {
  const base = indentOf(lines[from]);
  if (dir < 0) {
    let k = from - 1;
    while (k >= 0 && !isBlank(lines[k]) && indentOf(lines[k]) > base) k--; // 上の兄弟の、子を飛ばす
    if (k < 0) return null;
    if (!isBlank(lines[k]) && indentOf(lines[k]) < base) return null;       // 親より上へは、出ない
    const f = fenceRange(lines, k);
    return f ? f[0] : k;
  }
  const k = to + 1;
  if (k >= lines.length) return null;
  if (isBlank(lines[k])) return k + 1;
  if (indentOf(lines[k]) < base) return null;
  return blockRange(lines, k)[1] + 1;
}

/** Tab / Shift+Tab での、新しい字下げ。変えられないときは null。 */
export function indentTarget(lines, from, dir) {
  if (!isListLine(lines[from])) return null;
  const base = indentOf(lines[from]);
  if (dir > 0) {
    // 直前の兄弟(リストの行)の、子になる
    let k = from - 1;
    while (k >= 0 && !isBlank(lines[k]) && indentOf(lines[k]) > base) k--;
    if (k < 0 || isBlank(lines[k]) || indentOf(lines[k]) !== base) return null;
    return childIndentOf(lines[k]);
  }
  if (base === 0) return null;
  for (let k = from - 1; k >= 0; k--) {
    if (isBlank(lines[k])) continue;
    if (indentOf(lines[k]) < base) return indentOf(lines[k]); // 親と同じ深さへ戻す
  }
  return 0;
}
