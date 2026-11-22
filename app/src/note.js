import { bindTagEditor } from "./tag-editor.js";
import { bindModifierDrag } from "./modifier-drag.js";
import { bindPlacementShortcuts } from "./placement-shortcuts.js";
import { bindNoteParent } from "./note-parent.js";
import { choices } from "./list-model.js";
import { createEditor, TEXT_COLORS } from "./editor.js";
import { noteImages } from "./note-images.js";
import { COLORS, paintPaper, paperHex, paperBorder, frameColor, readAppearancePresets, writeAppearancePresets, renderStyleManager } from "./appearance.js";

const { invoke } = window.__TAURI__.core;

const TEXT_HEX = { red: "#c62828", orange: "#e65100", green: "#2e7d32", blue: "#1565c0", purple: "#6a1b9a", gray: "#757575" };

const SAVE_MS = 600;   // 入力が止まってから保存するまで
const POLL_MS = 1000;  // ディスク上の変更を確認する間隔

const $ = (id) => document.getElementById(id);
let note = null;       // { path, mtime }
const noteParent=bindNoteParent({getNote:()=>note,setStatus,refreshAttachment,openMenu:()=>showLinkMenu()});
let dirty = false;     // 画面に、まだ保存していない入力がある
let conflict = false;  // 保存しようとしたら、ディスク上の内容が変わっていた
let timer = null;
let editRevision = 0;
let saving = null;
let polling = false;
let closing = false;
let archived = false;

function setStatus(message) {
  const status = $("status");
  status.textContent = message;
  status.title = message;
}
$("copy-note-link").addEventListener('click',async()=>{
  $('display-menu').hidePopover();
  try{const link=await invoke('note_link',{path:null});await navigator.clipboard.writeText(link);setStatus('付箋へのリンクをコピーしました');}
  catch(e){setStatus(String(e));}
});

let noteTextSize=14;
const textSizeKey=()=>note ? 'sticky.textSize.'+note.path : null;
function applyTextSize(size,remember=false){
  noteTextSize=Math.max(8,Math.min(96,size));
  $("editor").style.setProperty("--note-text-size",noteTextSize+'px');
  ed.view?.requestMeasure?.();
  if(remember && textSizeKey()){
    try{localStorage.setItem(textSizeKey(),String(noteTextSize));}catch{}
  }
}
function loadTextSize(){
  let saved=null;try{saved=localStorage.getItem(textSizeKey());}catch{}
  const size=Number(saved);applyTextSize(Number.isFinite(size)&&size>=8 ? size : 14);
}
window.addEventListener("wheel",event=>{
  if(!event.ctrlKey || !event.deltaY || !note || !$("palette").hidden
    || event.target.closest?.("dialog, [popover], input, select, textarea"))return;
  event.preventDefault();event.stopPropagation();
  applyTextSize(noteTextSize+(event.deltaY<0 ? 1 : -1),true);
},{passive:false,capture:true});
document.addEventListener("keydown",event=>{
  if(event.ctrlKey && event.key==="0" && note){event.preventDefault();applyTextSize(14,true);}
});

let currentAttachment = null;
let currentTabLink = null;
let placementBasis='app';try{if(localStorage.getItem('sticky.placementBasis')==='monitor')placementBasis='monitor';}catch{}
const placementFeedback=reference=>invoke('show_placement_feedback',{basis:placementBasis,reference});
bindPlacementShortcuts({document,
  canStart:()=>!!note&&!document.querySelector('dialog[open], [popover]:popover-open, input:focus, select:focus, textarea:focus, #palette:not([hidden]), #fmt:not([hidden]), #tpalette:not([hidden])')&&attachmentAction===null,
  move:async(direction,reference,basis)=>{await invoke('place_note_family',{direction,reference,basis});await placementFeedback(reference);},
  nudge:async(dx,dy)=>{await invoke('nudge_note_family',{dx,dy});await placementFeedback('attached');},
  togglePin:()=>invoke('toggle_family_pin'),
  retreat:()=>invoke('retreat_note_family'),
  getBasis:()=>placementBasis,
  toggleBasis:async()=>{placementBasis=placementBasis==='app'?'monitor':'app';try{localStorage.setItem('sticky.placementBasis',placementBasis);}catch{}setStatus(placementBasis==='app'?'移動基準: アプリ':'移動基準: モニター');await placementFeedback('attached');},
  onError:error=>setStatus(String(error))});
const noteDisplay = { tags: true, attachment: true, tab: true, status: true };
function setToolbarPosition(value, remember=false) {
  const position=['top','bottom','left','right'].includes(value)?value:'top';
  document.body.dataset.toolbarPosition=position;
  $("toolbar-position").value=position;
  if(remember&&note){try{localStorage.setItem('sticky.toolbar.'+note.path,position);}catch{}}
}
function loadToolbarPosition(){
  let position='top';try{position=localStorage.getItem('sticky.toolbar.'+note.path);}catch{}
  setToolbarPosition(position);
}
$("toolbar-position").addEventListener('change',event=>setToolbarPosition(event.target.value,true));

// Keep the existing transient stack preview while a note's controls are open.
// Never write this temporary order or a pin change to the note/config.
let menuRaised=false;
function syncMenuRaise(){
  if(!note)return;
  const open=!!document.querySelector('dialog[open], [popover]:popover-open, .cm-block-menu, #title-input:not([hidden]), #palette:not([hidden]), #fmt:not([hidden]), #tpalette:not([hidden])');
  if(open===menuRaised)return;
  menuRaised=open;
  void invoke('set_note_menu_open',{open}).catch(error=>setStatus('メニューを前面にできません: '+error));
}
const menuObserver=new MutationObserver(syncMenuRaise);
menuObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','open']});
document.addEventListener('toggle',syncMenuRaise,true);

function destinationLabel(app, title, windowTitle = false) {
  if (!app || app === title) return title || app;
  if (windowTitle && (title?.endsWith(" - " + app) || title?.endsWith(" — " + app))) {
    title = title.slice(0, -app.length - 3);
  }
  return title ? (windowTitle ? app + " · " + title : title + " · " + app) : app;
}

function renderNoteDisplay() {
  $("tags").hidden = !noteDisplay.tags;
  const tags = note?.tags.join(" · ");
  $("tags").textContent = tags ? "タグ: " + tags : "タグ";
  $("tags").title = tags ? "タグを編集: " + tags : "付箋のタグを編集";
  const destination = $("attachment-label");
  const title = currentAttachment && destinationLabel(currentAttachment.app, currentAttachment.target.title, true);
  destination.hidden = !noteDisplay.attachment || !title;
  destination.textContent = title ? "貼付先: " + title : "";
  destination.title = title || "";
  const tab = $("return-tab");
  const tabLabel = currentTabLink && destinationLabel(currentTabLink.app, currentTabLink.tab.label);
  tab.hidden = !noteDisplay.tab || !currentTabLink;
  tab.textContent = tabLabel ? tabLabel + " ↗" : "";
  tab.title = tabLabel || "";
  const parentLink=$("note-parent-link");parentLink.hidden=!noteDisplay.attachment||parentLink.dataset.hasParent!=='true';
  $("note-links").hidden = destination.hidden && tab.hidden && parentLink.hidden;
  $("status").hidden = !noteDisplay.status;
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
const attachmentIdentity=()=>currentAttachment ? JSON.stringify([currentAttachment.target.hwnd,currentAttachment.target.pid,currentAttachment.target.born]) : $('attach').dataset.parentPath || null;
function clearDetachConfirmation(){
  detachConfirmation=null;clearTimeout(detachConfirmTimer);detachConfirmTimer=null;
}
function renderAttachmentButton(){
  const btn=$("attach");
  if(detachConfirmation && detachConfirmation!==attachmentIdentity())clearDetachConfirmation();
  const picking=attachmentAction==="pick";
  btn.disabled=attachmentAction!==null;
  btn.classList.toggle("on",!!currentAttachment || btn.dataset.parentAttached==='true');
  btn.classList.toggle("picking",picking);
  btn.textContent=picking ? "◎" : detachConfirmation ? "外す？" : "🔗";
  btn.classList.toggle("armed",!!detachConfirmation);
  btn.ariaPressed=String(!!currentAttachment || btn.dataset.parentAttached==='true');
  const targetTitle=currentAttachment?.target.title||btn.dataset.parentTitle;
  btn.title=picking ? "貼付先を選択中（Escで中止）" : detachConfirmation ? "もう一度押すとデスクトップに戻します（Escで中止）" : targetTitle
    ? '貼付中: '+targetTitle+'（2回クリックで解除／長押しでタブリンク）'
    : "ウィンドウや付箋をリンク（長押しでタブリンク）";
}
document.addEventListener("pointerdown",event=>{
  if(event.button===0 && !$("return-tab").contains(event.target) &&
      attachmentAction!=="pick" && attachmentAction!=="pick-tab"){
    void invoke("raise_attachment_group",{held:true,control:!!event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey}).catch(error=>setStatus("貼付先を前面にできません: "+error));
  }
},{capture:true});
for(const type of ["pointerup","pointercancel"]){
  document.addEventListener(type,()=>{void invoke("end_note_hold").catch(()=>{});},{capture:true});
}
window.__TAURI__.window.getCurrentWindow().listen('sticky-control-held',({payload})=>{
  document.body.classList.toggle('control-held',payload);
});
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
    const [targets, binding, link, parent] = await Promise.all([invoke("attachment_targets"),invoke("get_attachment"),invoke("get_tab_link"),invoke("get_note_parent")]);
    noteParent.set(parent);
    currentAttachment=binding;currentTabLink=link;renderAttachmentButton();renderNoteDisplay();
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

    $("pin").disabled = false;
  } catch(error) { setStatus("貼付先を取得できません: " + error); }
}
async function pickAndAttach(){
  if($("attach").disabled)return;
  if($("attachment-dialog").open)$("attachment-dialog").close();
  clearDetachConfirmation();attachmentAction="pick";renderAttachmentButton();
  setStatus("付けたいウィンドウか付箋をクリックしてください（Escで中止）");
  try{
    const target=await invoke("pick_attachment_target");
    await invoke("attach_window",{target});
    await refreshAttachment();setStatus('貼り付けました: '+($('attach').dataset.parentTitle||target.title));
  }catch(error){setStatus(error==='cancelled' ? (currentAttachment ? "付け替えを中止（元の貼付を維持）" : "選択を中止しました") : String(error));}
  finally{attachmentAction=null;renderAttachmentButton();}
}
document.addEventListener("keydown",event=>{
  if(event.key==="Escape" && detachConfirmation){clearDetachConfirmation();renderAttachmentButton();setStatus("取り外しを中止しました");}
  if(event.key==="Escape" && ["pick", "pick-tab"].includes(attachmentAction)){void invoke("cancel_attachment_pick").catch(error=>setStatus(String(error)));}
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
  if(attachmentAction!==null || !attachmentIdentity())return;
  const identity=attachmentIdentity();
  if(detachConfirmation!==identity){
    clearDetachConfirmation();detachConfirmation=identity;renderAttachmentButton();
    setStatus("もう一度押すとデスクトップに戻します");
    detachConfirmTimer=setTimeout(()=>{clearDetachConfirmation();renderAttachmentButton();setStatus("取り外しを中止しました");},3000);
    return;
  }
  clearDetachConfirmation();await returnToDesktop();
}
const attachButton = $("attach");
const linkMenu = $("link-menu");
let linkHoldTimer;
let linkHoldPointer = null;
let linkHoldOpened = false;

function showLinkMenu() {
  if (attachmentAction !== null) return;
  clearDetachConfirmation();
  renderAttachmentButton();
  $("display-menu").hidePopover();
  linkMenu.showPopover();
  $("pick-tab").focus();
}

attachButton.addEventListener("pointerdown", event => {
  if (event.button !== 0 || !event.isPrimary) return;
  linkHoldOpened = false;
  linkHoldPointer = event.pointerId;
  linkHoldTimer = setTimeout(() => {
    linkHoldOpened = true;
    showLinkMenu();
  }, 500);
});
function cancelLinkHold(event) {
  if (event.pointerId !== linkHoldPointer) return;
  clearTimeout(linkHoldTimer);
  linkHoldPointer = null;
}
attachButton.addEventListener("pointerleave", cancelLinkHold);
document.addEventListener("pointerup", cancelLinkHold, true);
document.addEventListener("pointercancel", cancelLinkHold, true);
document.addEventListener("pointerdown", event => {
  if (!linkMenu.contains(event.target) && !attachButton.contains(event.target)) linkMenu.hidePopover();
}, true);
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !linkMenu.matches(":popover-open")) return;
  linkMenu.hidePopover();
  attachButton.focus();
});
attachButton.addEventListener("contextmenu", event => {
  event.preventDefault();
  showLinkMenu();
});
attachButton.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    showLinkMenu();
  }
});
linkMenu.addEventListener("toggle", event => {
  attachButton.setAttribute("aria-expanded", String(event.newState === "open"));
});
attachButton.addEventListener("click",async event=>{
  if (linkHoldOpened && event.detail > 0) {
    linkHoldOpened = false;
    return;
  }
  if(attachmentAction!==null)return;
  attachmentAction="check";renderAttachmentButton();
  try{currentAttachment=await invoke("get_attachment");}
  catch(error){setStatus("貼付状態を確認できません: "+error);return;}
  finally{attachmentAction=null;renderAttachmentButton();}
  if(attachmentIdentity() && !event.shiftKey)await requestDesktopReturn();
  else await pickAndAttach();
});
// ▾ のメニューから、付箋の一覧の窓を開く(タスクトレイを触らずに済むように)
$("open-list").addEventListener("click", async () => {
  $("display-menu").hidePopover();
  try { await invoke("open_list"); setStatus(""); }
  catch (e) { setStatus("一覧を開けません: " + e); }
});
const duplicateButton = $("duplicate-note");
duplicateButton.addEventListener("click", async () => {
  if (!note || closing || duplicateButton.disabled) return;
  $("display-menu").hidePopover();
  duplicateButton.disabled = true;
  try {
    if (!(await save())) {
      setStatus("複製する前に、本文の保存状態を確認してください。");
      return;
    }
    await invoke("duplicate_note", {baseMtime: note.mtime});
    setStatus("付箋を複製しました");
  } catch (error) {
    setStatus(error === "conflict" ? "付箋が別の場所で変更されました。内容を確認してください。" : String(error));
  } finally {
    duplicateButton.disabled = false;
  }
});
// ▾ のメニューから、ショートカットの一覧を、独立した窓で開く
$("open-shortcuts").addEventListener("click", async () => {
  $("display-menu").hidePopover();
  try { await invoke("open_shortcuts"); setStatus(""); }
  catch (e) { setStatus("ショートカット一覧を開けません: " + e); }
});
$("tab-settings").addEventListener("click", async () => {
  linkMenu.hidePopover();
  $("attachment-dialog").showModal();
  await refreshAttachment();
});
$("pick-tab").addEventListener("click", async () => {
  if (attachmentAction !== null) return;
  linkMenu.hidePopover();
  clearDetachConfirmation();
  attachmentAction = "pick-tab";
  renderAttachmentButton();
  setStatus("リンクしたいタブをクリック（Escで中止）");
  try {
    await invoke("pick_tab_link");
    await refreshAttachment();
    setStatus("タブをリンクしました");
  } catch (error) {
    setStatus(error === "cancelled" ? "タブの選択を中止しました" : "リンクできません: " + error);
  } finally {
    attachmentAction = null;
    renderAttachmentButton();
  }
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
  try{await invoke("set_tab_link",{link:{target,tab}});await refreshAttachment();$("attachment-dialog").close();setStatus("タブをリンクしました");}
  catch(error){setStatus("リンクできません: "+error);}
});
$("tab-link-remove").addEventListener("click",async()=>{
  try{await invoke("set_tab_link",{link:null});await refreshAttachment();setStatus("タブのリンクを外しました");}catch(error){setStatus(String(error));}
});
$("return-tab").addEventListener("click",async()=>{
  $("return-tab").disabled=true;
  try{await invoke("activate_tab_link");await refreshAttachment();setStatus("リンクしたタブに戻りました");}catch(error){setStatus("タブに戻れません: "+error);}
  finally{$("return-tab").disabled=false;}
});
window.__TAURI__.window.getCurrentWindow().listen("attachment-ended",() => {
  refreshAttachment(); setStatus("貼付先が閉じたためデスクトップに戻しました。本文は残っています。");
});
window.__TAURI__.window.getCurrentWindow().listen("sticky-links-cleared", () => {
  clearDetachConfirmation();
  refreshAttachment();
  setStatus("一覧からリンクを解除しました");
});

$("editor").inert = true;
const ed = createEditor($("editor"), {
  onLinkError: setStatus,
  imageAttachments: noteImages({
    invoke,
    setStatus,
    canPaste: () => Boolean(note) && !closing,
    async pasteImage(insert) {
      closing = true;
      try {
        await insert();
        await save();
      } catch (error) {
        setStatus("画像を貼り付けられません: " + error);
      } finally {
        closing = false;
      }
    },
  }),
  placeholderText: "ここに書く(/ で書式、@ で日付、URLは Ctrl+クリックで開く)",
  onChange() {
    editRevision++;
    dirty = true;
    renderTitle();
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_MS);
  },
  // トグル(折りたたみ)の開閉は、付箋のファイルには書かず、このPCに覚える
  onFolds(texts) {
    if (!note) return;
    const s = JSON.stringify(texts);
    if (s === lastFolds) return;
    lastFolds = s;
    try {
      if (texts.length) localStorage.setItem(foldKey(), s);
      else localStorage.removeItem(foldKey());
    } catch (_) { /* 覚えられなくても、使える */ }
  },
});
window.__stickyEditor = ed;  // 試験用
let lastFolds = "[]";
const foldKey = () => "sticky.fold." + note.path;
function loadFolds() {
  try {
    const v = JSON.parse(localStorage.getItem(foldKey()));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (_) { return []; }
}

function renderTitle() {
  const first = ed.getText().split("\n").find(line => line.trim())?.trim();
  const automatic = first ? [...first.replace(/^#+/, "").trim()].slice(0, 60).join("") : "(空)";
  const title = note?.title ?? automatic;
  $("title").textContent = title;
  $("title").title = title;
  $("edit-title").title = title;
}

function applyAppearance(color, border, borderColor) {
  note.color = color;
  note.border = paperBorder(border);
  note.borderColor = frameColor(borderColor);
  previewAppearance();
  for (const b of document.querySelectorAll("#paper-swatches .sw")) {
    b.classList.toggle("cur", paperHex(b.dataset.name) === paperHex(color));
  }
  for (const b of document.querySelectorAll("#paper-borders [data-border]")) {
    b.setAttribute("aria-pressed", String(b.dataset.border === note.border));
  }
}

function show(body, mtime, color, isArchived = false, tags = [], title = null, border = null, borderColor = null) {
  note.title = title;
  note.tags = tags;
  renderNoteDisplay();
  note.mtime = mtime;
  const folds = ed.getFolds();  // 本文を差し替えると、折りたたみが解けるので、同じ行を、もう一度折りたたむ
  ed.setText(body);
  ed.setFolds(folds);
  dirty = false;
  setConflict(false);
  applyAppearance(color, border, borderColor);
  renderTitle();
  updateArchive(isArchived);
}

let archiveTimer = null;
const archiveBtn = $("archive");

function cancelArchive() {
  clearTimeout(archiveTimer);
  archiveTimer = null;
  archiveBtn.classList.remove("armed");
  archiveBtn.textContent = archived ? "通常に戻す" : "アーカイブ";
}

function updateArchive(value) {
  archived = value;
  cancelArchive();
  $("archive").textContent = archived ? "通常に戻す" : "アーカイブ";
  $("archive").title = archived ? "通常に戻す（長押しでゴミ箱）" : "アーカイブ（長押しでゴミ箱）";
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

const archiveMenu = $("archive-menu");
function bindArchiveButton(button, onHold, onClick) {
  let holdTimer;
  let pointer;
  let held = false;
  const cancel = () => {
    clearTimeout(holdTimer);
    pointer = undefined;
  };
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || closing) return;
    held = false;
    pointer = event.pointerId;
    holdTimer = setTimeout(() => {
      held = true;
      onHold();
    }, 500);
  });
  const end = event => {
    if (event.pointerId === pointer) cancel();
  };
  button.addEventListener("pointerleave", end);
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
  window.addEventListener("blur", cancel);
  button.addEventListener("click", event => {
    if (held && event.detail) { held = false; return; }
    if (!closing) return onClick();
  });
  return cancel;
}

bindArchiveButton(archiveBtn, () => {
  cancelArchive();
  archiveMenu.showPopover();
  const bounds = archiveBtn.getBoundingClientRect();
  const menu = archiveMenu.getBoundingClientRect();
  archiveMenu.style.left = Math.max(4, Math.min(bounds.left, innerWidth - menu.width - 4)) + "px";
  archiveMenu.style.top = Math.max(4, bounds.top - menu.height - 4) + "px";
  archiveMenu.style.bottom = "auto";
}, () => {
  if (!archived && archiveTimer === null) {
    archiveBtn.classList.add("armed");
    archiveBtn.textContent = "もう一度押すとアーカイブ";
    archiveTimer = setTimeout(cancelArchive, 3000);
    return;
  }
  cancelArchive();
  return archiveSafely(!archived);
});
document.addEventListener("pointerdown", event => {
  if (!archiveMenu.contains(event.target) && !archiveBtn.contains(event.target)) archiveMenu.hidePopover();
}, true);
window.addEventListener("blur", cancelArchive);
window.addEventListener("blur", () => archiveMenu.hidePopover());
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { cancelArchive(); archiveMenu.hidePopover(); }
});
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
  if (!note || dirty || saving || polling || closing || $("tags-dialog").open || !$("title-input").hidden) return;
  polling = true;
  const revision = editRevision;
  const base = note.mtime;
  try {
    const m = await invoke("note_mtime", { path: note.path });
    if (m !== note.mtime) {
      const n = await invoke("read_note", { path: note.path });
      if (!dirty && !saving && !closing && !$("tags-dialog").open && $("title-input").hidden && editRevision === revision && note.mtime === base) {
        show(n.body, n.mtime, n.color, n.archived, n.tags, n.title, n.border, n.border_color);
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
  if (editRevision === revision && !saving) show(n.body, n.mtime, n.color, n.archived, n.tags, n.title, n.border, n.border_color);
});

const titleInput = $("title-input");

function openTitleEditor() {
  if (!note || closing || !titleInput.hidden) return;
  titleInput.value = note.title ?? ($("title").textContent === "(空)" ? "" : $("title").textContent);
  $("title-error").hidden = true;
  $("title").hidden = true;
  titleInput.hidden = false;
  titleInput.focus();
  titleInput.select();
}

function closeTitleEditor(restoreFocus) {
  titleInput.hidden = true;
  $("title").hidden = false;
  $("title-error").hidden = true;
  if (restoreFocus) $("edit-title").focus();
}

$("edit-title").addEventListener("click", openTitleEditor);
const selectForDrag = extend => invoke("select_note_for_drag", {extend}).catch(error => setStatus(String(error)));
function isDragSurface(target) {
  if (target.hasAttribute("data-note-drag")) return true;
  return document.body.classList.contains("drag-selected") &&
    !target.closest("button, input, select, textarea, label, dialog, [popover], #palette, #fmt, #tpalette");
}
bindModifierDrag({
  document,window,
  canStart:event=>!!note && !closing &&
    !event.target.closest('dialog, [popover], input, textarea, select, #palette, #fmt, #tpalette'),
  start:()=>invoke('drag_note'),
  onError:error=>setStatus(String(error)),
});

document.addEventListener("pointerdown", event => {
  if (event.button !== 0 || event.target.closest("#arrange-menu")) return;
  if (!event.shiftKey) {
    if (!isDragSurface(event.target)) void selectForDrag(false);
    return;
  }
  if (event.target.closest("button, input, select, textarea, label, dialog, [popover], #palette, #fmt, #tpalette")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void selectForDrag(true);
}, {capture: true});
window.__TAURI__.window.getCurrentWindow().listen("sticky-drag-selected", ({payload}) => {
  document.body.classList.toggle("drag-selected", payload);
  if (!payload) $("arrange-menu").hidePopover();
});
const arrangeMenu = $("arrange-menu");
const arrangeOptions = $("arrange-options");
const arrangeDirections = $("arrange-directions");
const archiveSelected = $("archive-selected");
const trashSelected = $("trash-selected");
let groupArchiveTimer;

function resetGroupArchive() {
  clearTimeout(groupArchiveTimer);
  groupArchiveTimer = undefined;
  archiveSelected.textContent = "一括アーカイブ";
}

async function organizeSelection(trash) {
  arrangeMenu.hidePopover();
  try { await invoke("organize_drag_selection", {trash}); }
  catch (error) { setStatus(String(error)); }
}

const cancelGroupHold = bindArchiveButton(archiveSelected, () => {
  resetGroupArchive();
  trashSelected.hidden = false;
  arrangeMenu.style.top = Math.max(4, Math.min(arrangeMenu.offsetTop, innerHeight - arrangeMenu.offsetHeight - 4)) + "px";
}, () => {
  if (groupArchiveTimer !== undefined) {
    resetGroupArchive();
    return organizeSelection(false);
  }
  trashSelected.hidden = true;
  archiveSelected.textContent = "もう一度押すと一括アーカイブ";
  groupArchiveTimer = setTimeout(resetGroupArchive, 3000);
});
trashSelected.addEventListener("click", () => organizeSelection(true));
let arrangeDirection = "down-right";
let arrangeLayout = "stack";
let arrangeFront = "last";
const layoutVectors = {
  "up-left": [-1, -1], up: [0, -1], "up-right": [1, -1],
  left: [-1, 0], right: [1, 0],
  "down-left": [-1, 1], down: [0, 1], "down-right": [1, 1],
};
function renderArrangement() {
  const stack = arrangeLayout === "stack";
  for (const button of $("arrange-layout").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.layout === arrangeLayout));
  }
  for (const button of $("arrange-front").querySelectorAll("button")) {
    button.disabled = !stack;
    button.setAttribute("aria-pressed", String(button.dataset.front === arrangeFront));
  }
  const firstInFront = stack && arrangeFront === "first";
  const [x, y] = layoutVectors[arrangeDirection];
  const stepX = stack ? 12 : 28;
  const stepY = stack ? 8 : 20;
  for (const [index, card] of [...$("arrange-preview").children].entries()) {
    card.style.left = `calc(50% + ${(index - 1) * x * stepX - 12}px)`;
    card.style.top = `calc(50% + ${(index - 1) * y * stepY - 8}px)`;
    card.style.zIndex = firstInFront ? 3 - index : index + 1;
  }
  for (const button of arrangeDirections.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.direction === arrangeDirection));
  }
}
document.addEventListener("contextmenu", event => {
  const titleArea = event.target.closest("#bar") &&
    !event.target.closest("button:not(#edit-title), input, textarea, select, [contenteditable='true']");
  if (!titleArea && !isDragSurface(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  arrangeOptions.hidden = true;
  const selected = document.body.classList.contains("drag-selected");
  $("merge-selected").hidden = !selected;
  $("arrange-open").hidden = !selected;
  resetGroupArchive();
  archiveSelected.hidden = !selected;
  trashSelected.hidden = true;
  arrangeMenu.showPopover();
  arrangeMenu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - arrangeMenu.offsetWidth - 4)) + "px";
  arrangeMenu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - arrangeMenu.offsetHeight - 4)) + "px";
}, {capture: true});
$("layer-order-open").addEventListener("click", async()=>{
  arrangeMenu.hidePopover();
  try { await invoke("open_layer_order"); } catch(e) {setStatus(String(e));}
});
$("arrange-open").addEventListener("click", () => {
  arrangeOptions.hidden = false;
  $("arrange-open").hidden = true;
  arrangeMenu.style.left = "4px";
  arrangeMenu.style.top = "4px";
  renderArrangement();
});
$("merge-selected").addEventListener("click", async()=>{try{await invoke('open_selected_merge');arrangeMenu.hidePopover();}catch(e){setStatus(String(e));}});
arrangeMenu.addEventListener("toggle", event => {
  if (event.newState === "closed") {
    $("arrange-open").hidden = false;
    cancelGroupHold();
    resetGroupArchive();
    trashSelected.hidden = true;
  }
});
arrangeDirections.addEventListener("click", event => {
  const direction = event.target.closest("[data-direction]")?.dataset.direction;
  if (!direction) return;
  arrangeDirection = direction;
  renderArrangement();
});
$("arrange-layout").addEventListener("click", event => {
  const layout = event.target.closest("[data-layout]")?.dataset.layout;
  if (!layout) return;
  arrangeLayout = layout;
  renderArrangement();
});
$("arrange-front").addEventListener("click", event => {
  const front = event.target.closest("[data-front]")?.dataset.front;
  if (!front) return;
  arrangeFront = front;
  renderArrangement();
});
$("arrange-apply").addEventListener("click", async () => {
  try {
    await invoke("arrange_notes", {layout: arrangeLayout, direction: arrangeDirection, firstInFront: arrangeLayout === "stack" && arrangeFront === "first"});
    arrangeMenu.hidePopover();
  } catch (error) { setStatus(String(error)); }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.classList.contains("drag-selected")) void selectForDrag(false);
});
document.addEventListener("mousedown", event => {
  if (event.button !== 0 || event.shiftKey || !isDragSurface(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  invoke("drag_note").catch(error => setStatus(String(error)));
}, {capture: true});

titleInput.addEventListener("blur", () => {
  if (!closing && !titleInput.hidden) closeTitleEditor(false);
});
titleInput.addEventListener("keydown", event => {
  if (event.key !== "Escape" || event.isComposing || closing) return;
  event.preventDefault();
  closeTitleEditor(true);
});
$("title-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!note || closing || titleInput.hidden) return;
  const title = titleInput.value.trim();
  closing = true;
  titleInput.readOnly = true;
  $("title-error").hidden = true;
  try {
    if (!(await save())) throw new Error("本文の保存状態を確認してからやり直してください。");
    note.mtime = await invoke("set_note_title", { title, baseMtime: note.mtime });
    note.title = title || null;
    renderTitle();
    closeTitleEditor(true);
    setStatus("タイトルを保存しました");
  } catch (error) {
    $("title-error").textContent = error === "conflict"
      ? "別の場所で変更されました。編集を閉じてから、もう一度開いてください。"
      : String(error);
    $("title-error").hidden = false;
  } finally {
    titleInput.readOnly = false;
    closing = false;
  }
});

const tagEditor = bindTagEditor(async () => choices(await invoke("list_notes"), "tags"));
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

// --- 付箋の見た目
const palette = $("palette");
const customAppearance = $("custom-appearance");
const presetName = $("appearance-name");
const quickPaperColor = $("quick-paper-color");
const quickFrame = $("quick-frame-color");
const frameForm = $("frame-color-form");
const resetFrameColor = $("reset-frame-color");
const editFrameColor = $("edit-frame-color");
const manageAppearance = $("manage-appearance");
let framePreview = null;
let paperPreview = null;

function previewAppearance() {
  if (!note) return;
  paintPaper(document.body, paperPreview ?? note.color, note.border, framePreview ?? note.borderColor);
}

async function saveAppearance(color, border, borderColor = note?.borderColor || "auto") {
  if (!note || closing) return false;
  clearTimeout(timer);
  closing = true;
  try {
    if (!(await save())) return false;
    note.mtime = await invoke("set_color", { path: note.path, color, border, borderColor, baseMtime: note.mtime });
    applyAppearance(color, border, borderColor);
    quickPaperColor.value = paperHex(note.color);
    setStatus("見た目を保存しました");
    return true;
  } catch (error) {
    if (error === "conflict") setConflict(true);
    setStatus("見た目を保存できません: " + error);
    return false;
  } finally {
    closing = false;
  }
}

function renderAppearancePresets() {
  const presets = readAppearancePresets();
  manageAppearance.hidden = !presets.length;
  $("appearance-presets").replaceChildren(...presets.map(preset => {
    const button = document.createElement("button");
    button.type = "button";
    paintPaper(button, preset.color, preset.border, preset.borderColor);
    button.textContent = preset.name;
    button.addEventListener("click", async () => {
      if (await saveAppearance(paperHex(preset.color), paperBorder(preset.border), frameColor(preset.borderColor))) {
        framePreview = null;
        resetFramePicker();
      }
    });
    return button;
  }));
}

manageAppearance.addEventListener("toggle", () => {
  if (manageAppearance.open) renderStyleManager($("appearance-style-list"), renderAppearancePresets);
});
$("appearance-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!note || closing) return;
  const name = presetName.value.trim();
  if (!name) {
    presetName.focus();
    return;
  }
  try {
    const presets = readAppearancePresets();
    if (presets.some(preset => preset.name === name)) {
      setStatus("同じ名前があります。別の名前を入力してください");
      presetName.focus();
      return;
    }
    presets.push({name, color: paperHex(note.color), border: note.border, borderColor: framePreview ?? note.borderColor});
    writeAppearancePresets(presets);
    renderAppearancePresets();
    if (manageAppearance.open) renderStyleManager($("appearance-style-list"), renderAppearancePresets);
    customAppearance.open = false;
    presetName.value = "";
    setStatus(`「${name}」を保存しました`);
  } catch (error) {
    setStatus("スタイルを保存できませんでした: " + error);
  }
});

for (const [name, hex] of COLORS) {
  const b = document.createElement("button");
  b.className = "sw"; b.dataset.name = name; b.title = name; b.style.setProperty("--c", hex);
  b.addEventListener("click", () => saveAppearance(name, note?.border));
  $("paper-swatches").insertBefore(b, $("custom-paper-color"));
}
quickPaperColor.addEventListener("input", () => {
  paperPreview = quickPaperColor.value;
  previewAppearance();
});
quickPaperColor.addEventListener("blur", () => {
  if (paperPreview === null) return;
  paperPreview = null;
  previewAppearance();
});
quickPaperColor.addEventListener("change", async () => {
  const color = quickPaperColor.value;
  paperPreview = null;
  if (!(await saveAppearance(color, note?.border))) {
    quickPaperColor.value = paperHex(note?.color);
    previewAppearance();
  }
});

function resetFramePicker() {
  const color = framePreview ?? frameColor(note?.borderColor);
  quickFrame.value = color === "auto" ? "#555555" : color;
  resetFrameColor.disabled = framePreview === null;
  previewAppearance();
}

editFrameColor.addEventListener("click", () => {
  frameForm.hidden = !frameForm.hidden;
  editFrameColor.setAttribute("aria-expanded", String(!frameForm.hidden));
  resetFramePicker();
});
quickFrame.addEventListener("input", () => {
  framePreview = quickFrame.value === frameColor(note?.borderColor) ? null : quickFrame.value;
  resetFrameColor.disabled = framePreview === null;
  previewAppearance();
});
resetFrameColor.addEventListener("click", () => {
  framePreview = null;
  resetFramePicker();
});
$("auto-frame-color").addEventListener("click", () => {
  framePreview = note?.borderColor === "auto" ? null : "auto";
  resetFramePicker();
});
for (const button of document.querySelectorAll("#paper-borders [data-border]")) {
  button.addEventListener("click", () => saveAppearance(note?.color || "yellow", button.dataset.border));
}
async function finishAppearance(restoreFocus = true) {
  if (framePreview !== null) {
    if (!(await saveAppearance(note.color, note.border, framePreview))) return false;
    framePreview = null;
  }
  palette.hidden = true;
  paperPreview = null;
  resetFramePicker();
  if (restoreFocus) ed.focus();
  return true;
}

$("finish-appearance").addEventListener("click", () => finishAppearance());
$("editor").addEventListener("pointerdown", () => {
  if (!palette.hidden) void finishAppearance(false);
});
$("color").addEventListener("click", () => {
  if (!palette.hidden) return finishAppearance();
  palette.hidden = false;
  $("tpalette").hidden = true;
  renderAppearancePresets();
  customAppearance.open = false;
  manageAppearance.open = false;
  frameForm.hidden = true;
  editFrameColor.setAttribute("aria-expanded", "false");
  quickPaperColor.value = paperHex(note?.color);
  presetName.value = "";
});

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

// --- Markdownの記号を常に表示する(ライブプレビューを切る)。このPCの、全部の付箋に効く
const MARKUP_KEY = "sticky.show-markup";
function applyMarkup(raw) {
  $("show-markup").checked = raw;
  ed.setLive(!raw);
}
$("show-markup").addEventListener("change", (e) => {
  const raw = e.currentTarget.checked;
  applyMarkup(raw);
  try { localStorage.setItem(MARKUP_KEY, raw ? "1" : "0"); } catch (_) { /* 保存できなくても使える */ }
});
try { applyMarkup(localStorage.getItem(MARKUP_KEY) === "1"); } catch (_) { applyMarkup(false); }
// ほかの付箋の窓で切り替えたら、この窓も合わせる
window.addEventListener("storage", (e) => { if (e.key === MARKUP_KEY) applyMarkup(e.newValue === "1"); });

// ボタンを押しても、入力欄の選択範囲を外さない(mousedownを止める)
for (const b of fmt.querySelectorAll("button")) {
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", async () => {
    const c = b.dataset.cmd;
    if (c === "color") {
      if (!palette.hidden && !(await finishAppearance(false))) return;
      tpalette.hidden = !tpalette.hidden;
      return;
    }
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

async function toggleNotePin() {
  const btn = $("pin");
  const on = !btn.classList.contains("on");
  await invoke("set_pin", { on });
  btn.classList.toggle("on", on);
}
$("pin").addEventListener("click", () => toggleNotePin().catch(error => setStatus(String(error))));
// 外から(コマンドライン)前面固定を変えられたとき、📌の表示を合わせる
window.__TAURI__.window.getCurrentWindow().listen("sticky-pin-changed", event => {
  $("pin").classList.toggle("on", !!event.payload);
});
async function closeSafely() {
  if (!palette.hidden && framePreview !== null && !(await finishAppearance(false))) return;
  const dialog = $("close-dialog");
  if (closing || dialog.open) return;
  closing = true;
  clearTimeout(timer);
  try {
    if (!dirty || await save()) await invoke("close_note");
    else dialog.showModal();
  } catch (e) {
    setStatus("付箋を閉じられません: " + e);
  } finally { closing = false; }
}
$("close-dialog").addEventListener("close", async () => {
  try { await invoke("cancel_quit"); }
  catch (e) { setStatus("終了を取り消せません: " + e); }
});
$("discard-close").addEventListener("click", async () => {
  if (closing) return;
  closing = true;
  try { await invoke("close_note"); }
  catch (e) { $("close-dialog").close(); setStatus("付箋を閉じられません: " + e); }
  finally { closing = false; }
});
$("close").addEventListener("click", closeSafely);
// Native window close (including Alt+F4 and app quit) uses the same save path.
window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (event) => {
  event.preventDefault();
  await closeSafely();
}).catch(e => setStatus("終了操作の準備に失敗しました: " + e));

// --- この付箋のファイルの場所を、エクスプローラーで開く
$("reveal").addEventListener("click", async () => {
  try { await invoke("reveal_note"); setStatus(""); }
  catch (e) { setStatus("場所を開けません: " + e); }
});

// --- 長押しメニューからゴミ箱へ
async function trashSafely() {
  if (closing) return;
  archiveMenu.hidePopover();
  clearTimeout(timer);
  closing = true;
  $("editor").inert = true;
  try {
    if (await save()) await invoke("trash_note", {baseMtime: note.mtime});
  } catch (error) {
    setStatus("ゴミ箱へ移動できません: " + error);
  } finally {
    $("editor").inert = false;
    closing = false;
  }
}
$("trash").addEventListener("click", trashSafely);
window.__TAURI__.window.getCurrentWindow().listen("sticky-organize-selection", ({payload: trash}) => {
  if (trash) return trashSafely();
  if (!archived) return archiveSafely(true);
}).catch(error => setStatus("一括整理の準備に失敗しました: " + error));

(async () => {
  try {
    const n = await invoke("note_init");
    note = { path: n.path, mtime: n.mtime, tags: n.tags || [], title: n.title ?? null };
    void noteParent.refresh();
    loadTextSize();
    loadNoteDisplay();
    loadToolbarPosition();
    ed.setText(n.body);
    $("editor").inert = false;
    const savedFolds = loadFolds();
    lastFolds = JSON.stringify(savedFolds);
    ed.setFolds(savedFolds);
    $("pin").classList.toggle("on", n.pin);
    applyAppearance(n.color, n.border, n.border_color);
    updateArchive(n.archived || false);
    await refreshAttachment();
    renderTitle();
    if (document.hasFocus()) ed.focus();  // 起動時の自動復元など、窓が前面でないときは、フォーカスに触らない
  } catch (e) {
    setStatus("開けません: " + e);
  }
})();
