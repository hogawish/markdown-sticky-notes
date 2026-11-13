// ブロック(行)の種類の判定と変換。文字だけを扱い、画面には依存しない(単体試験できる)。
// 行頭の記号(# - 1. > など)を付け替えるだけで、本文と字下げは保つ。

// 行頭: (字下げ)(見出し | 引用 | リストの記号 と チェックボックス)
const PREFIX_RE = /^(\s*)(#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;
const FENCE_RE = /^\s*```/;

/** 行の文字から、ブロックの種類を返す。見出し4〜6は null(メニューに無い)。 */
export function blockTypeOf(text) {
  if (FENCE_RE.test(text)) return "code";
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
  const m = PREFIX_RE.exec(text);
  const old = m[2] || "";
  const body = text.slice(m[0].length);
  let indent = m[1];
  let out;
  if (type === "code") {
    out = "```\n" + body + "\n```";
  } else {
    let prefix = { text: "", h1: "# ", h2: "## ", h3: "### ", bullet: "- ", todo: "- [ ] ", quote: "> " }[type];
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
