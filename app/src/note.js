import { createEditor, TEXT_COLORS } from "./editor.js";

const { invoke } = window.__TAURI__.core;

const COLORS = [  // 名前は付箋の color: に書く値。見た目は styles.css の data-color と対応
  ["yellow", "#fff3a3"], ["pink", "#ffd1dc"], ["blue", "#cfe8ff"], ["green", "#d4f5c4"],
  ["purple", "#e3d4ff"], ["orange", "#ffd9a8"], ["white", "#ffffff"], ["gray", "#e6e6e6"],
];
const TEXT_HEX = { red: "#c62828", orange: "#e65100", green: "#2e7d32", blue: "#1565c0", purple: "#6a1b9a", gray: "#757575" };

const SAVE_MS = 600;   // 入力が止まってから保存するまで
const POLL_MS = 1000;  // ディスク上の変更を確認する間隔

const $ = (id) => document.getElementById(id);
let note = null;       // { path, mtime }
let dirty = false;     // 画面に、まだ保存していない入力がある
let conflict = false;  // 保存しようとしたら、ディスク上の内容が変わっていた
let timer = null;
let editRevision = 0;
let saving = null;
let polling = false;
let closing = false;

const setStatus = (t) => { $("status").textContent = t; };

const ed = createEditor($("editor"), {
  placeholderText: "ここに書く(/ で書式、@ で日付、URLは Ctrl+クリックで開く)",
  onChange() {
    editRevision++;
    dirty = true;
    renderTitle();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_MS);
  },
});
window.__stickyEditor = ed;  // 試験用

function renderTitle() {
  const first = ed.getText().split("\n").find((l) => l.trim()) || "(空)";
  $("title").textContent = first.replace(/^#+\s*/, "").slice(0, 30);
}

function applyColor(name) {
  const known = COLORS.some(([n]) => n === name) ? name : "yellow";  // 無い・知らない色は黄色
  document.body.dataset.color = known;
  for (const b of document.querySelectorAll("#palette .sw")) b.classList.toggle("cur", b.dataset.name === known);
}

function show(body, mtime, color) {
  note.mtime = mtime;
  ed.setText(body);
  dirty = false;
  setConflict(false);
  applyColor(color);
  renderTitle();
}

function setConflict(on) {
  conflict = on;
  $("conflict").hidden = !on;
}

async function save() {
  if (saving) return saving;
  if (!note || conflict) return false;
  if (!dirty) return true;
  saving = (async () => {
    try {
      // Keep subsequent edits dirty and save them before a close can proceed.
      while (dirty && !conflict) {
        const revision = editRevision;
        const body = ed.getText();
        note.mtime = await invoke("save_note", { path: note.path, body, baseMtime: note.mtime });
        dirty = editRevision !== revision;
      }
      setStatus("保存しました");
      return !dirty && !conflict;
    } catch (e) {
      if (e === "conflict") { setConflict(true); setStatus("他の変更があります。入力はこの窓に残っています。"); }
      else setStatus("保存できません。入力はこの窓に残っています: " + e);
      return false;
    }
  })();
  try { return await saving; }
  finally { saving = null; }
}

// 他の人・Agentがファイルを書き換えたら取り込む。入力中のときは取り込まない(人間の入力を優先)。
// ファイルが無くなったら、窓を閉じる。
setInterval(async () => {
  if (!note || dirty || saving || polling || closing) return;
  polling = true;
  const revision = editRevision;
  const base = note.mtime;
  try {
    const m = await invoke("note_mtime", { path: note.path });
    if (m !== note.mtime) {
      const n = await invoke("read_note", { path: note.path });
      if (!dirty && !saving && !closing && editRevision === revision && note.mtime === base) {
        show(n.body, n.mtime, n.color);
      }
    }
  } catch (e) {
    if (e === "gone" && !dirty && !saving && editRevision === revision) await invoke("close_note");
    // それ以外(書き込み途中など)は、次の周期で再試行
  } finally { polling = false; }
}, POLL_MS);

$("keep-mine").addEventListener("click", async () => {
  note.mtime = await invoke("note_mtime", { path: note.path });  // 相手の変更を承知のうえで上書きする
  setConflict(false);
  save();
});
$("take-theirs").addEventListener("click", async () => {
  const revision = editRevision;
  const n = await invoke("read_note", { path: note.path });
  if (editRevision === revision && !saving) show(n.body, n.mtime, n.color);
});

// --- 付箋の色: 🎨で色見本を出し、選ぶと付箋の color: を書き換える
const palette = $("palette");
for (const [name, hex] of COLORS) {
  const b = document.createElement("button");
  b.className = "sw"; b.dataset.name = name; b.title = name; b.style.setProperty("--c", hex);
  b.addEventListener("click", async () => {
    palette.hidden = true;
    if (!note) return;
    clearTimeout(timer);
    if (!(await save())) return;
    try {
      note.mtime = await invoke("set_color", { path: note.path, color: name, baseMtime: note.mtime });
      applyColor(name);
    } catch (e) {
      if (e === "conflict") setConflict(true);
      else setStatus("色を変えられません: " + e);
    }
  });
  palette.append(b);
}
$("color").addEventListener("click", () => { palette.hidden = !palette.hidden; $("tpalette").hidden = true; });

// --- 書式のツールバー(Aaで出し入れ。状態は覚えておく)
const fmt = $("fmt");
const tpalette = $("tpalette");
function setFmt(on) {
  fmt.hidden = !on;
  if (!on) tpalette.hidden = true;
  $("fmtbtn").classList.toggle("on", on);
  try { localStorage.setItem("fmt", on ? "1" : "0"); } catch (_) { /* 無くても動く */ }
}
$("fmtbtn").addEventListener("click", () => setFmt(fmt.hidden));
try { setFmt(localStorage.getItem("fmt") === "1"); } catch (_) { setFmt(false); }

// ボタンを押しても、入力欄の選択範囲を外さない(mousedownを止める)
for (const b of fmt.querySelectorAll("button")) {
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const c = b.dataset.cmd;
    if (c === "color") { tpalette.hidden = !tpalette.hidden; $("palette").hidden = true; return; }
    ed.cmd(c);
    ed.focus();
  });
}
for (const name of TEXT_COLORS) {
  const b = document.createElement("button");
  b.className = "sw"; b.dataset.name = name; b.title = name; b.style.setProperty("--c", TEXT_HEX[name]);
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => { ed.textColor(name); tpalette.hidden = true; ed.focus(); });
  tpalette.append(b);
}
{
  const b = document.createElement("button");
  b.className = "clear"; b.textContent = "解除"; b.title = "文字の色を元に戻す(色のついた文字の中にカーソルを置く)";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => { ed.textColor(null); tpalette.hidden = true; ed.focus(); });
  tpalette.append(b);
}

$("pin").addEventListener("click", async () => {
  const btn = $("pin");  // await のあとは e.currentTarget が空になるので、先に取っておく
  const on = !btn.classList.contains("on");
  await invoke("set_pin", { on });
  btn.classList.toggle("on", on);
});
async function closeSafely() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  try {
    if (await save()) await invoke("close_note");
  } finally { closing = false; }
}
$("close").addEventListener("click", closeSafely);
// Native window close (including Alt+F4 and app quit) uses the same save path.
window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (event) => {
  event.preventDefault();
  await closeSafely();
}).catch(e => setStatus("終了操作の準備に失敗しました: " + e));

// --- 片付ける: 押し間違い対策に、2回押さないと実行しない(1回目は赤く「もう一度」を出し、3秒で戻る)
let armTimer = null;
const trashBtn = $("trash");
const TRASH_LABEL = trashBtn.textContent;
function disarm() {
  clearTimeout(armTimer);
  trashBtn.classList.remove("armed");
  trashBtn.textContent = TRASH_LABEL;
}
trashBtn.addEventListener("click", async () => {
  if (!trashBtn.classList.contains("armed")) {
    trashBtn.classList.add("armed");
    trashBtn.textContent = "もう一度押すと片付けます";
    armTimer = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  clearTimeout(timer);
  if (await save()) await invoke("trash_note");
});

(async () => {
  try {
    const n = await invoke("note_init");
    note = { path: n.path, mtime: n.mtime };
    ed.setText(n.body);
    $("pin").classList.toggle("on", n.pin);
    applyColor(n.color);
    renderTitle();
    if (document.hasFocus()) ed.focus();  // 起動時の自動復元など、窓が前面でないときは、フォーカスに触らない
  } catch (e) {
    setStatus("開けません: " + e);
  }
})();
