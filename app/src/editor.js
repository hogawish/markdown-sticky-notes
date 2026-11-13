// 付箋の入力欄。Markdownの文字を、そのまま編集する(打った文字のまま保存される)。
// 太字・見出し・リストなどは、整形して表示する。カーソルのない行では記号を隠し、カーソルのある行だけ記号を出す
// (ライブプレビュー。live-preview.js)。隠すのは見た目だけで、保存される内容は変わらない。
import { EditorState, Transaction, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder, Decoration, ViewPlugin, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { autocompletion } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { livePreview, liveCompartment, livePreviewFlag } from "./live-preview.js";
import { blockHandle, moveBlockBy, indentBlockBy } from "./blocks.js";

const MONO = "Consolas, 'Cascadia Mono', 'MS Gothic', monospace";

// ---- 表示 -----------------------------------------------------------------

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.4em", fontWeight: "bold" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "bold" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "bold" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: MONO, fontSize: "0.92em", background: "rgba(0,0,0,.07)" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.quote, fontStyle: "italic", opacity: ".8" },
  { tag: t.processingInstruction, opacity: ".4" }, // `**` `#` `-` などの記号
]);

const URL_RE = /https?:\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]/g;
// 文字色: Markdownに混ぜられるHTMLのspan。色は名前か#16進だけを受け付ける
const SPAN_RE = /<span style="color:\s*([a-zA-Z]+|#[0-9a-fA-F]{3,8})\s*;?">(.*?)<\/span>/g;
const CLOSE_LEN = "</span>".length;

const dim = Decoration.mark({ class: "cm-dimtag" });
const urlMark = Decoration.mark({ class: "cm-url" });
const codeLine = Decoration.line({ class: "cm-codeblock" });

function buildDecorations(view) {
  const out = [];
  const { state } = view;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(n) {
        if (n.name === "FencedCode" || n.name === "CodeBlock") {
          let pos = n.from;
          while (pos <= n.to) {
            const line = state.doc.lineAt(pos);
            out.push(codeLine.range(line.from));
            pos = line.to + 1;
          }
          return false;
        }
      },
    });
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      for (const m of line.text.matchAll(SPAN_RE)) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        const innerFrom = s + m[0].indexOf(">") + 1;
        const innerTo = e - CLOSE_LEN;
        out.push(dim.range(s, innerFrom));
        if (innerTo > innerFrom) out.push(Decoration.mark({ attributes: { style: `color:${m[1]}` } }).range(innerFrom, innerTo));
        out.push(dim.range(innerTo, e));
      }
      for (const m of line.text.matchAll(URL_RE)) {
        out.push(urlMark.range(line.from + m.index, line.from + m.index + m[0].length));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

const decorationPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "1.5" },
  ".cm-content": { padding: "4px 8px 4px 24px", caretColor: "#222" }, // 左は、ブロックのつまみ(⋮⋮)の分
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "#222" },
  ".cm-placeholder": { opacity: ".45" },
});

// ---- URL を開く(Ctrl+クリック) --------------------------------------------

function urlAt(view, pos) {
  // [ラベル](URL) は、URLの部分が隠れていても、ラベルの上で開けるようにする
  for (let n = syntaxTree(view.state).resolveInner(pos, 0); n; n = n.parent) {
    if (n.name !== "Link") continue;
    const u = n.getChild("URL");
    const s = u ? view.state.sliceDoc(u.from, u.to) : "";
    if (/^https?:\/\//.test(s)) return s;
    break;
  }
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(URL_RE)) {
    const a = line.from + m.index;
    if (pos >= a && pos <= a + m[0].length) return m[0];
  }
  return null;
}

function openUrl(url) {
  const o = window.__TAURI__ && window.__TAURI__.opener;
  if (o && o.openUrl) o.openUrl(url).catch(() => {});
  else window.open(url, "_blank");
}

const urlClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const url = pos == null ? null : urlAt(view, pos);
    if (!url) return false;
    e.preventDefault();
    openUrl(url);
    return true;
  },
});

// ---- @ コマンド -------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function atItems() {
  const now = new Date();
  const day = (k) => { const d = new Date(now); d.setDate(d.getDate() + k); return ymd(d); };
  const dt = `${ymd(now)} ${hm(now)}`;
  return [
    { label: "@today", detail: day(0), apply: day(0) },
    { label: "@tomorrow", detail: day(1), apply: day(1) },
    { label: "@yesterday", detail: day(-1), apply: day(-1) },
    { label: "@now", detail: hm(now), apply: hm(now) },
    { label: "@datetime", detail: dt, apply: dt },
    { label: "@todo", detail: "チェックボックス", apply: "- [ ] " },
  ];
}

function atSource(ctx) {
  const m = ctx.matchBefore(/@\w*/);
  if (!m) return null;
  // 行頭か、空白のあとの @ だけを対象にする(メールアドレスなどを邪魔しない)
  if (m.from > 0 && !/\s/.test(ctx.state.sliceDoc(m.from - 1, m.from))) return null;
  return { from: m.from, options: atItems(), validFor: /^@\w*$/ };
}

// ---- / コマンド(Notion風。書式を、行頭や空白のあとの / から呼ぶ) -------------------

/** 候補を選んだとき、打った「/xxx」を消してから、書式を適用する。 */
const slash = (label, detail, fn) => ({
  label, detail,
  apply: (view, _completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
    fn(view);
  },
});

function slashItems() {
  return [
    slash("/h1", "見出し1", (v) => setHeading(v, 1)),
    slash("/h2", "見出し2", (v) => setHeading(v, 2)),
    slash("/h3", "見出し3", (v) => setHeading(v, 3)),
    slash("/bullet", "箇条書き", (v) => toggleList(v, "bullet")),
    slash("/number", "番号つきリスト", (v) => toggleList(v, "number")),
    slash("/todo", "チェックボックス", setTodo),
    slash("/quote", "引用", toggleQuote),
    slash("/code", "コードブロック", (v) => codeCommand(v, true)),
    slash("/divider", "区切り線", dividerCommand),
    ...["red", "orange", "green", "blue", "purple", "gray"].map((c) => slash(`/${c}`, `文字色(${c})`, (v) => insertColorSpan(v, c))),
  ];
}

function slashSource(ctx) {
  const m = ctx.matchBefore(/\/\w*/);
  if (!m) return null;
  // 行頭か、空白のあとの / だけを対象にする(URLの https:// や a/b を邪魔しない)
  if (m.from > 0 && !/\s/.test(ctx.state.sliceDoc(m.from - 1, m.from))) return null;
  return { from: m.from, options: slashItems(), validFor: /^\/\w*$/ };
}

// ---- 書式のコマンド -----------------------------------------------------------

/** 中身が空のリスト行(「- 」「1. 」「- [ ] 」だけ)でEnter → 記号を消して、リストを終える。
 *  部品の標準は「空行を1つ足して、もう1回Enterで終わる」で、途中に空行が残るため、置き換える。 */
function exitEmptyListItem(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  if (!/^\s*([-*+]|\d+[.)])(\s+\[[ xX]\])?\s*$/.test(line.text)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from } });
  return true;
}

function toggleWrap(view, mark) {
  const st = view.state;
  const sel = st.selection.main;
  const L = mark.length;
  const slice = (a, b) => st.sliceDoc(Math.max(0, a), Math.min(st.doc.length, b));
  if (sel.empty) {
    view.dispatch({ changes: { from: sel.from, insert: mark + mark }, selection: { anchor: sel.from + L } });
    return;
  }
  const text = st.sliceDoc(sel.from, sel.to);
  // 斜体の `*` は、太字の `**` の一部を、斜体の記号と取り違えない
  const partOfBold = mark === "*" && (slice(sel.from - 2, sel.from - 1) === "*" || slice(sel.to + 1, sel.to + 2) === "*");
  if (slice(sel.from - L, sel.from) === mark && slice(sel.to, sel.to + L) === mark && !partOfBold) {
    view.dispatch({
      changes: [{ from: sel.from - L, to: sel.from }, { from: sel.to, to: sel.to + L }],
      selection: { anchor: sel.from - L, head: sel.to - L },
    });
    return;
  }
  if (text.length > 2 * L && text.startsWith(mark) && text.endsWith(mark) && !(mark === "*" && text.startsWith("**"))) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text.slice(L, -L) },
      selection: { anchor: sel.from, head: sel.to - 2 * L },
    });
    return;
  }
  view.dispatch({
    changes: [{ from: sel.from, insert: mark }, { from: sel.to, insert: mark }],
    selection: { anchor: sel.from + L, head: sel.to + L },
  });
}

/** 1行を置き換える。カーソルは行末からの位置を保つ(記号が増えても、文字の後ろにいる)。 */
function replaceLine(view, line, insert) {
  const sel = view.state.selection.main;
  const spec = { changes: { from: line.from, to: line.to, insert } };
  if (sel.empty && sel.head >= line.from && sel.head <= line.to) {
    spec.selection = { anchor: line.from + insert.length - (line.to - sel.head) };
  }
  view.dispatch(spec);
}

function cycleHeading(view) {
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const m = /^(#{1,6})\s+/.exec(line.text);
  const level = m ? m[1].length : 0;
  const next = level >= 3 ? 0 : level + 1;  // なし → # → ## → ### → なし
  const body = m ? line.text.slice(m[0].length) : line.text;
  replaceLine(view, line, (next ? "#".repeat(next) + " " : "") + body);
}

function toggleList(view, kind) {
  const st = view.state;
  const sel = st.selection.main;
  const a = st.doc.lineAt(sel.from).number;
  const b = st.doc.lineAt(sel.to).number;
  const same = kind === "bullet" ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
  const any = /^(\s*)([-*+]|\d+[.)])\s+/;
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(st.doc.line(i));
  const target = lines.filter((l) => l.text.trim());
  const remove = target.length > 0 && target.every((l) => same.test(l.text));
  const changes = [];
  let n = 1;
  for (const l of lines) {
    if (!l.text.trim() && lines.length > 1) continue;
    const m = any.exec(l.text);
    const indent = m ? m[1] : /^\s*/.exec(l.text)[0];
    const body = l.text.slice(m ? m[0].length : indent.length);
    const mark = remove ? "" : kind === "bullet" ? "- " : `${n++}. `;
    changes.push({ from: l.from, to: l.to, insert: indent + mark + body });
  }
  if (lines.length === 1 && sel.empty && changes.length === 1) replaceLine(view, lines[0], changes[0].insert);
  else view.dispatch({ changes });
}

/** コード。force=true なら、1行だけ選んでいてもコードブロックにする(Ctrl+Alt+C)。 */
function codeCommand(view, force = false) {
  const st = view.state;
  const sel = st.selection.main;
  const a = st.doc.lineAt(sel.from);
  const b = st.doc.lineAt(sel.to);
  if (!force && !sel.empty && a.number === b.number) { toggleWrap(view, "`"); return; }  // 1行だけ選んだ → インライン
  if (sel.empty) {
    view.dispatch({ changes: { from: sel.from, insert: "```\n\n```" }, selection: { anchor: sel.from + 4 } });
    return;
  }
  const before = a.number > 1 ? st.doc.line(a.number - 1) : null;
  const after = b.number < st.doc.lines ? st.doc.line(b.number + 1) : null;
  if (before && after && /^```/.test(before.text) && /^```\s*$/.test(after.text)) {  // すでにブロックの中 → 外す
    view.dispatch({ changes: [{ from: before.from, to: before.to + 1 }, { from: after.from - 1, to: after.to }] });
    return;
  }
  view.dispatch({ changes: [{ from: a.from, insert: "```\n" }, { from: b.to, insert: "\n```" }] });
}

/** 見出しを n(1〜3) にする。すでに n なら外す(Ctrl+Alt+1〜3、/h1〜/h3)。 */
function setHeading(view, n) {
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const m = /^(#{1,6})\s+/.exec(line.text);
  const body = m ? line.text.slice(m[0].length) : line.text;
  const next = m && m[1].length === n ? "" : "#".repeat(n) + " ";
  replaceLine(view, line, next + body);
}

/** 選んだ行すべてを引用(> )にする。すべてすでに引用なら外す。 */
function toggleQuote(view) {
  const st = view.state;
  const sel = st.selection.main;
  const a = st.doc.lineAt(sel.from).number;
  const b = st.doc.lineAt(sel.to).number;
  const lines = [];
  for (let i = a; i <= b; i++) lines.push(st.doc.line(i));
  const target = lines.filter((l) => l.text.trim());
  const remove = target.length > 0 && target.every((l) => /^\s*>\s?/.test(l.text));
  const changes = [];
  for (const l of lines) {
    if (!l.text.trim() && lines.length > 1) continue;
    const text = remove ? l.text.replace(/^(\s*)>\s?/, "$1") : "> " + l.text;
    changes.push({ from: l.from, to: l.to, insert: text });
  }
  if (lines.length === 1 && sel.empty && changes.length === 1) replaceLine(view, lines[0], changes[0].insert);
  else view.dispatch({ changes });
}

/** 行をチェックボックス(- [ ] )にする。見出し・リストの記号は置き換える。 */
function setTodo(view) {
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  const m = /^(\s*)((#{1,6}|[-*+]|\d+[.)]|>)\s+(\[[ xX]\]\s+)?)/.exec(line.text);
  const indent = m ? m[1] : /^\s*/.exec(line.text)[0];
  const body = line.text.slice(m ? m[0].length : indent.length);
  replaceLine(view, line, `${indent}- [ ] ${body}`);
}

/** リンク(Ctrl+K)。文字を選んでいれば [文字]() に、URLを選んでいれば [](URL) にする。 */
function linkCommand(view) {
  const st = view.state;
  const sel = st.selection.main;
  if (sel.empty) {
    view.dispatch({ changes: { from: sel.from, insert: "[]()" }, selection: { anchor: sel.from + 1 } });
    return;
  }
  const text = st.sliceDoc(sel.from, sel.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[](${text})` }, selection: { anchor: sel.from + 1 } });
  } else {
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${text}]()` }, selection: { anchor: sel.from + text.length + 3 } });
  }
}

/** 区切り線。`---` だと先頭でメタ情報の始まりと区別がつかなくなるため、`***` を使う。 */
function dividerCommand(view) {
  const st = view.state;
  const line = st.doc.lineAt(st.selection.main.head);
  if (!line.text.trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "***\n" }, selection: { anchor: line.from + 4 } });
  } else {
    view.dispatch({ changes: { from: line.to, insert: "\n***\n" }, selection: { anchor: line.to + 5 } });
  }
}

/** 色つきの文字の入れ物(<span …></span>)を入れて、カーソルを中に置く(/red など)。 */
function insertColorSpan(view, name) {
  const pos = view.state.selection.main.head;
  const open = `<span style="color:${name}">`;
  view.dispatch({ changes: { from: pos, insert: `${open}</span>` }, selection: { anchor: pos + open.length } });
}

/** 文字色。name=null で解除。選択範囲をspanで包む。すでにspanの中なら、色を替える・外す。 */
function textColor(view, name) {
  const st = view.state;
  const sel = st.selection.main;
  const line = st.doc.lineAt(sel.from);
  for (const m of line.text.matchAll(SPAN_RE)) {
    const s = line.from + m.index;
    const e = s + m[0].length;
    if (sel.from >= s && sel.to <= e) {
      const insert = name === null ? m[2] : `<span style="color:${name}">${m[2]}</span>`;
      view.dispatch({ changes: { from: s, to: e, insert } });
      return;
    }
  }
  if (name === null || sel.empty) return;
  const changes = [];
  const a = st.doc.lineAt(sel.from).number;
  const b = st.doc.lineAt(sel.to).number;
  for (let i = a; i <= b; i++) {
    const l = st.doc.line(i);
    const from = Math.max(sel.from, l.from);
    const to = Math.min(sel.to, l.to);
    if (to <= from) continue;
    changes.push({ from, to, insert: `<span style="color:${name}">${st.sliceDoc(from, to)}</span>` });
  }
  if (changes.length) view.dispatch({ changes });
}

// ---- 組み立て ---------------------------------------------------------------

export const TEXT_COLORS = ["red", "orange", "green", "blue", "purple", "gray"];

export function createEditor(parent, { onChange, placeholderText }) {
  let silent = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        Prec.highest(keymap.of([{ key: "Enter", run: exitEmptyListItem }])),
        keymap.of([
          { key: "Mod-b", run: (v) => { toggleWrap(v, "**"); return true; } },
          { key: "Mod-i", run: (v) => { toggleWrap(v, "*"); return true; } },
          // 一般的な書式のショートカット(Google ドキュメント・Notion に近い形)
          { key: "Mod-Shift-x", run: (v) => { toggleWrap(v, "~~"); return true; } },
          { key: "Mod-e", run: (v) => { toggleWrap(v, "`"); return true; } },
          { key: "Mod-k", run: (v) => { linkCommand(v); return true; } },
          { key: "Mod-Alt-1", run: (v) => { setHeading(v, 1); return true; } },
          { key: "Mod-Alt-2", run: (v) => { setHeading(v, 2); return true; } },
          { key: "Mod-Alt-3", run: (v) => { setHeading(v, 3); return true; } },
          { key: "Mod-Shift-7", run: (v) => { toggleList(v, "number"); return true; } },
          { key: "Mod-Shift-8", run: (v) => { toggleList(v, "bullet"); return true; } },
          { key: "Mod-Shift-9", run: (v) => { toggleQuote(v); return true; } },
          { key: "Mod-Alt-c", run: (v) => { codeCommand(v, true); return true; } },
          // ブロックの移動: 子ごと、兄弟の前後へ(Alt+↑↓)、1段深く・浅く(Tab / Shift+Tab。リストの行だけ)
          { key: "Alt-ArrowUp", run: (v) => moveBlockBy(v, -1) },
          { key: "Alt-ArrowDown", run: (v) => moveBlockBy(v, 1) },
          { key: "Tab", run: (v) => indentBlockBy(v, 1) },
          { key: "Shift-Tab", run: (v) => indentBlockBy(v, -1) },
          ...defaultKeymap, ...historyKeymap, indentWithTab,
        ]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "false" }),
        placeholder(placeholderText || ""),
        decorationPlugin,
        liveCompartment.of(livePreviewFlag.of(true)),
        livePreview,
        blockHandle,
        urlClick,
        autocompletion({ override: [atSource, slashSource], icons: false }),
        theme,
        EditorView.updateListener.of((u) => { if (u.docChanged && !silent) onChange(); }),
      ],
    }),
  });

  const commands = {
    bold: () => toggleWrap(view, "**"),
    italic: () => toggleWrap(view, "*"),
    heading: () => cycleHeading(view),
    bullet: () => toggleList(view, "bullet"),
    number: () => toggleList(view, "number"),
    code: () => codeCommand(view),
  };

  return {
    view,
    getText: () => view.state.doc.toString(),
    /** 外から取り込んだ本文に差し替える(入力としては扱わない。元に戻す履歴にも積まない) */
    setText(text) {
      if (text === view.state.doc.toString()) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      silent = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: head },
          annotations: Transaction.addToHistory.of(false),
        });
      } finally { silent = false; }
    },
    focus: () => view.focus(),
    /** ライブプレビューの入り切り。false なら、Markdownの記号を常に出す */
    setLive: (on) => view.dispatch({ effects: liveCompartment.reconfigure(livePreviewFlag.of(!!on)) }),
    cmd: (name) => commands[name] && commands[name](),
    textColor: (name) => textColor(view, name),
  };
}
