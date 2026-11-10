import { bindTagEditor } from "./tag-editor.js";
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
let archived = false;

const setStatus = (t) => { $("status").textContent = t; };

let noteTextSize=14;
const textSizeKey=()=>note ? 'sticky.textSize.'+note.path : null;
function applyTextSize(size,remember=false){
  noteTextSize=Math.max(8,Math.min(96,size));
  $("editor").style.setProperty("--note-text-size",noteTextSize+'px');
  ed.view?.requestMeasure?.();
  if(remember && textSizeKey()){
    try{localStorage.setItem(textSizeKey(),String(noteTextSize));}catch{}
    setStatus('文字サイズ: '+noteTextSize+'px（Ctrl+0で標準）');
  }
}
function loadTextSize(){
  let saved=null;try{saved=localStorage.getItem(textSizeKey());}catch{}
  const size=Number(saved);applyTextSize(Number.isFinite(size)&&size>=8 ? size : 14);
}
$("editor").addEventListener("wheel",event=>{
  if(!event.ctrlKey || !event.deltaY || !note)return;
  event.preventDefault();event.stopPropagation();
  applyTextSize(noteTextSize+(event.deltaY<0 ? 1 : -1),true);
},{passive:false,capture:true});
document.addEventListener("keydown",event=>{
  if(event.ctrlKey && event.key==="0" && note){event.preventDefault();applyTextSize(14,true);}
});

let currentAttachment = null;
const noteDisplay = { tags: true, attachment: true };

function renderNoteDisplay() {
  $("tags").hidden = !noteDisplay.tags;
  const tags = note?.tags.join(" · ");
  $("tags").textContent = tags ? "タグ: " + tags : "タグ";
  $("tags").title = tags ? "タグを編集: " + tags : "付箋のタグを編集";
  const destination = $("attachment-label");
  const title = currentAttachment?.target.title;
  destination.hidden = !noteDisplay.attachment || !title;
  destination.textContent = title ? "貼付先: " + title : "";
  destination.title = title || "";
}

for (const field of Object.keys(noteDisplay)) {
  $("show-" + field).addEventListener("change", event => {
    noteDisplay[field] = event.target.checked;
    if (note) {
      try { localStorage.setItem("sticky.display." + note.path, JSON.stringify(noteDisplay)); } catch {}
    }
    renderNoteDisplay();
  });
}

function loadNoteDisplay() {
  try {
    const saved = JSON.parse(localStorage.getItem("sticky.display." + note.path));
    for (const field of Object.keys(noteDisplay)) {
      if (typeof saved?.[field] === "boolean") noteDisplay[field] = saved[field];
    }
  } catch {}
  for (const field of Object.keys(noteDisplay)) $("show-" + field).checked = noteDisplay[field];
  renderNoteDisplay();
}

let attachmentAction = null;
let detachConfirmation = null;
let detachConfirmTimer = null;
const attachmentIdentity=()=>currentAttachment ? JSON.stringify([currentAttachment.target.hwnd,currentAttachment.target.pid,currentAttachment.target.born]) : null;
function clearDetachConfirmation(){
  detachConfirmation=null;clearTimeout(detachConfirmTimer);detachConfirmTimer=null;
}
function renderAttachmentButton(){
  const btn=$("attach");
  if(detachConfirmation && detachConfirmation!==attachmentIdentity())clearDetachConfirmation();
  const picking=attachmentAction==="pick";
  btn.disabled=attachmentAction!==null;
  btn.classList.toggle("on",!!currentAttachment);
  btn.classList.toggle("picking",picking);
  btn.textContent=picking ? "◎" : detachConfirmation ? "外す？" : "🔗";
  btn.classList.toggle("armed",!!detachConfirmation);
  btn.ariaPressed=String(!!currentAttachment);
  btn.title=picking ? "貼付先を選択中（Escで中止）" : detachConfirmation ? "もう一度押すとデスクトップに戻します（Escで中止）" : currentAttachment
    ? '貼付中: '+currentAttachment.target.title+'（2回クリックでデスクトップに戻す／Shift+クリックで付け替え）'
    : "クリックしたウィンドウに付ける（Escで中止）";
}
document.addEventListener("pointerdown",event=>{
  if(event.button===0 && currentAttachment && attachmentAction!=="pick"){
    void invoke("raise_attachment_group").catch(error=>setStatus("貼付先を前面にできません: "+error));
  }
},{capture:true});
let attachmentTargets = [];
let attachmentTabs = [];
async function refreshTabs() {
  const target = attachmentTargets[Number($("attachment-target").value)];
  attachmentTabs = target ? await invoke("attachment_tabs",{target}) : [];
  const whole = document.createElement("option"); whole.value=""; whole.textContent="タブを選択";
  $("attachment-scope").replaceChildren(whole,...attachmentTabs.map((tab,i)=>{
    const option=document.createElement("option"); option.value=String(i); option.textContent=`リンク先: ${tab.label || tab.id}`; return option;
  }));
  $("attachment-tab-help").hidden=!!attachmentTabs.length;
  $("tab-link-save").disabled=!attachmentTabs.length;
}
$("attachment-target").addEventListener("change",()=>refreshTabs().catch(error=>setStatus("タブを取得できません: "+error)));
async function refreshAttachment() {
  try {
    const [targets, binding, link] = await Promise.all([invoke("attachment_targets"),invoke("get_attachment"),invoke("get_tab_link")]);
    currentAttachment=binding;renderAttachmentButton();renderNoteDisplay();
    attachmentTargets = targets;
    $("attachment-target").replaceChildren(...targets.map((target,i) => {
      const option = document.createElement("option"); option.value=String(i); option.textContent=target.title; return option;
    }));
    const selected=targets.findIndex(t=>t.hwnd===binding?.target.hwnd);
    if(selected>=0) $("attachment-target").value=String(selected);
    if ($("attachment-dialog").open) await refreshTabs();
    const tabIndex=attachmentTabs.findIndex(t=>t.key===link?.tab?.key&&t.id===link?.tab?.id);
    if(tabIndex>=0) $("attachment-scope").value=String(tabIndex);
    $("tab-link-current").textContent=link ? 'タブへのリンク: '+link.tab.label : 'タブへのリンク: なし';
    $("tab-link-remove").disabled=!link;
    $("return-tab").hidden=!link;
    $("return-tab").title=link ? 'タブに戻る: '+link.tab.label : 'タブに戻る';

    $("pin").disabled = false;
  } catch(error) { setStatus("貼付先を取得できません: " + error); }
}
async function pickAndAttach(){
  if($("attach").disabled)return;
  if($("attachment-dialog").open)$("attachment-dialog").close();
  clearDetachConfirmation();attachmentAction="pick";renderAttachmentButton();
  setStatus("付けたいウィンドウをクリックしてください（Escで中止）");
  try{
    const target=await invoke("pick_attachment_target");
    await invoke("attach_window",{target});
    await refreshAttachment();setStatus('貼り付けました: '+target.title);
  }catch(error){setStatus(error==='cancelled' ? (currentAttachment ? "付け替えを中止（元の貼付を維持）" : "選択を中止しました") : String(error));}
  finally{attachmentAction=null;renderAttachmentButton();}
}
document.addEventListener("keydown",event=>{
  if(event.key==="Escape" && detachConfirmation){clearDetachConfirmation();renderAttachmentButton();setStatus("取り外しを中止しました");}
  if(event.key==="Escape" && attachmentAction==="pick"){void invoke("cancel_attachment_pick").catch(error=>setStatus(String(error)));}
});
async function returnToDesktop(){
  if(attachmentAction!==null)return;
  attachmentAction="detach";renderAttachmentButton();
  try{
    await invoke("detach_window");currentAttachment=null;
    if($("attachment-dialog").open)$("attachment-dialog").close();
    await refreshAttachment();setStatus("デスクトップに戻しました");
  }catch(error){setStatus("外せません: "+error);}
  finally{attachmentAction=null;renderAttachmentButton();}
}
async function requestDesktopReturn(){
  if(attachmentAction!==null || !currentAttachment)return;
  const identity=attachmentIdentity();
  if(detachConfirmation!==identity){
    clearDetachConfirmation();detachConfirmation=identity;renderAttachmentButton();
    setStatus("もう一度押すとデスクトップに戻します");
    detachConfirmTimer=setTimeout(()=>{clearDetachConfirmation();renderAttachmentButton();setStatus("取り外しを中止しました");},3000);
    return;
  }
  clearDetachConfirmation();await returnToDesktop();
}
$("attach").addEventListener("click",async event=>{
  if(attachmentAction!==null)return;
  attachmentAction="check";renderAttachmentButton();
  try{currentAttachment=await invoke("get_attachment");}
  catch(error){setStatus("貼付状態を確認できません: "+error);return;}
  finally{attachmentAction=null;renderAttachmentButton();}
  if(currentAttachment && !event.shiftKey)await requestDesktopReturn();
  else await pickAndAttach();
});
$("tab-settings").addEventListener("click", async () => {
  $("display-menu").hidePopover();
  $("attachment-dialog").showModal();
  await refreshAttachment();
});
$("attachment-dialog").addEventListener("click", event => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom) {
    event.currentTarget.close();
  }
});
$("attachment-refresh").addEventListener("click",refreshAttachment);
$("tab-link-save").addEventListener("click",async()=>{
  const target=attachmentTargets[Number($("attachment-target").value)];
  const selected=$("attachment-scope").value;
  const tab=selected==="" ? attachmentTabs[0] : attachmentTabs[Number(selected)];
  if(!target||!tab)return;
  try{await invoke("set_tab_link",{link:{target,tab}});await refreshAttachment();$("attachment-dialog").close();setStatus("タブをリンクしました。↗で戻れます");}
  catch(error){setStatus("リンクできません: "+error);}
});
$("tab-link-remove").addEventListener("click",async()=>{
  try{await invoke("set_tab_link",{link:null});await refreshAttachment();setStatus("タブのリンクを外しました");}catch(error){setStatus(String(error));}
});
$("return-tab").addEventListener("click",async()=>{
  $("return-tab").disabled=true;
  try{await invoke("activate_tab_link");setStatus("リンクしたタブに戻りました");}catch(error){setStatus("タブに戻れません: "+error);}
  finally{$("return-tab").disabled=false;}
});
window.__TAURI__.window.getCurrentWindow().listen("attachment-ended",() => {
  refreshAttachment(); setStatus("貼付先が閉じたためデスクトップに戻しました。本文は残っています。");
});

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

function show(body, mtime, color, isArchived = false, tags = []) {
  note.tags = tags;
  renderNoteDisplay();
  note.mtime = mtime;
  ed.setText(body);
  dirty = false;
  setConflict(false);
  applyColor(color);
  renderTitle();
  updateArchive(isArchived);
}

function updateArchive(value) {
  archived = value;
  $("archive").textContent = archived ? "通常に戻す" : "アーカイブ";
  $("archive").title = archived ? "ファイルを移動せず通常の一覧に戻す" : "ファイルを移動せずアーカイブする";
}

async function archiveSafely(value) {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  try {
    if (!(await save())) return;
    note.mtime = await invoke("archive_note", {archived:value, baseMtime:note.mtime});
    updateArchive(value);
    // If typing continued during the metadata write, persist it before closing.
    if (!(await save())) return;
    if (value) await invoke("close_note");
    else setStatus("通常の一覧に戻しました");
  } catch (error) { setStatus("アーカイブを変更できません。入力は残っています: " + error); }
  finally { closing = false; }
}

$("archive").addEventListener("click", () => archiveSafely(!archived));
window.__TAURI__.window.getCurrentWindow().listen("sticky-archive-request", event => archiveSafely(event.payload))
  .catch(error => setStatus("アーカイブ操作の準備に失敗しました: " + error));

async function moveSafely(folder) {
  if (closing) return;
  closing = true; clearTimeout(timer);
  try {
    if (!(await save())) return;
    const moved = await invoke("move_note", {folder, baseMtime:note.mtime});
    note.path = moved.path; note.mtime = moved.mtime;
    if (await save()) await invoke("close_note");
  } catch(error) { setStatus("移動できません。入力は残っています: " + error); }
  finally { closing = false; }
}
window.__TAURI__.window.getCurrentWindow().listen("sticky-move-request", event => moveSafely(event.payload))
  .catch(error => setStatus("移動操作の準備に失敗しました: " + error));

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
  if (!note || dirty || saving || polling || closing || $("tags-dialog").open) return;
  polling = true;
  const revision = editRevision;
  const base = note.mtime;
  try {
    const m = await invoke("note_mtime", { path: note.path });
    if (m !== note.mtime) {
      const n = await invoke("read_note", { path: note.path });
      if (!dirty && !saving && !closing && !$("tags-dialog").open && editRevision === revision && note.mtime === base) {
        show(n.body, n.mtime, n.color, n.archived, n.tags);
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
  if (editRevision === revision && !saving) show(n.body, n.mtime, n.color, n.archived, n.tags);
});

const tagEditor = bindTagEditor();
$("tags").addEventListener("click", () => {
  if (!note) return;
  tagEditor.open(note.tags, async tags => {
    if (!(await save())) throw new Error("本文の状態を確認してから保存してください。");
    if (JSON.stringify(note.tags) !== JSON.stringify(tags)) {
      note.mtime = await invoke("set_tags", { tags, baseMtime: note.mtime });
      note.tags = tags;
      renderNoteDisplay();
    }
    setStatus("タグを保存しました");
  });
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
    note = { path: n.path, mtime: n.mtime, tags: n.tags || [] };
    loadTextSize();
    loadNoteDisplay();
    ed.setText(n.body);
    $("pin").classList.toggle("on", n.pin);
    applyColor(n.color);
    updateArchive(n.archived || false);
    await refreshAttachment();
    renderTitle();
    if (document.hasFocus()) ed.focus();  // 起動時の自動復元など、窓が前面でないときは、フォーカスに触らない
  } catch (e) {
    setStatus("開けません: " + e);
  }
})();
