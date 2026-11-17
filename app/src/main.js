import { bindTagEditor, confirmTagDiscard, dismissDialogOnOutsideClick, tagChip, tagKey } from "./tag-editor.js";
import { chipColor, chipColorKey, paintChip, readChipColors, saveChipColors, updateChipColor } from "./chip-colors.js";
import { paintPaper, renderStyleManager } from "./appearance.js";
import { createReadOnlyPreview } from "./editor.js";
import { noteImages } from "./note-images.js";
// 一覧窓。登録フォルダの付箋を一覧にして、クリックで開く。
import { selectNotes, choices, statusChoices, statusGroup, statusLabel, UNASSIGNED } from "./list-model.js";
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const tagEditor = bindTagEditor(() => choices(cachedNotes, "tags"), () => renderNotes());

let last = "";
let cachedNotes = [];
let cachedFolders = [];
const selected = new Set();
const expandedPreviews = new Set();
const previewEditors = new Set();
let bulkRunning = false;
let pendingTrash = [];
let pendingClearLinks = [];
let archiveConfirmation = null;
let archiveTimer;

function cancelArchiveConfirmation() {
  if (!archiveConfirmation) return;
  clearTimeout(archiveTimer);
  archiveConfirmation = null;
  updateArchiveButtons();
}

function updateArchiveButtons() {
  for (const button of $("notes").querySelectorAll(".archive-action[data-path]")) {
    const armed = archiveConfirmation === button.dataset.path;
    button.classList.toggle("armed", armed);
    button.textContent = armed ? "もう一度押すとアーカイブ" : "アーカイブ";
  }
  const bulk = $("bulk-archive");
  const armed = archiveConfirmation === bulkArchiveKey(selectedNotes(false));
  bulk.classList.toggle("armed", armed);
  bulk.textContent = armed ? "もう一度押すと一括アーカイブ" : "一括アーカイブ";
}

function confirmArchive(key) {
  if (archiveConfirmation === key) {
    cancelArchiveConfirmation();
    return true;
  }
  clearTimeout(archiveTimer);
  archiveConfirmation = key;
  archiveTimer = setTimeout(cancelArchiveConfirmation, 3000);
  updateArchiveButtons();
  return false;
}
const defaults = () => ({ query: "", folder: "", tag: "", status: "", archive: "active", sort: "updated", direction: "desc" });
let filters = defaults();
try { Object.assign(filters, JSON.parse(localStorage.getItem("list-filters") || "{}")); } catch (_) { /* 初回と保存不可でも使える */ }
for (const key of Object.keys(defaults())) if (typeof filters[key] !== "string") filters[key] = defaults()[key];
if (!["updated", "created", "title", "folder"].includes(filters.sort)) filters.sort = "updated";
if (!["asc", "desc"].includes(filters.direction)) filters.direction = "desc";
if (filters.archive !== "archived") filters.archive = "active";

function remember() {
  try { localStorage.setItem("list-filters", JSON.stringify(filters)); } catch (_) { /* 表示条件の保存は任意 */ }
}

function options(id, items, selected) {
  if (selected && !items.some(([value]) => value === selected)) items.push([selected, "選択中（現在の一覧に該当なし）"]);
  $(id).replaceChildren(...items.map(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
  }));
  $(id).value = selected;
}

function renderFilters() {
  options("filter-folder", [["", "すべてのフォルダ"], ...cachedFolders.map(f => [f.display, f.label])], filters.folder);
  options("filter-tag", [["", "すべてのタグ"], [UNASSIGNED, "タグなし（未整理）"], ...choices(cachedNotes, "tags").map(tag => ["v:" + tag, tag])], filters.tag);
  options("filter-status", [["", "すべてのStatus"], ...statusChoices(cachedNotes).map(status => [
    status ? "v:" + status : UNASSIGNED, statusLabel(status),
  ])], filters.status);
}

function renderNotes() {
  for (const editor of previewEditors) editor.destroy();
  previewEditors.clear();
  const statusColors = readChipColors("status");
  const tagColors = readChipColors("tag");
  const notes = selectNotes(cachedNotes, filters);
  const visible = new Set(notes.map(note => note.path));
  for (const path of selected) {
    if (!visible.has(path)) selected.delete(path);
  }
  $("count").textContent = `${notes.length} / ${cachedNotes.length} 件`;
  $("direction").textContent = ["updated", "created"].includes(filters.sort)
    ? filters.direction === "desc" ? "新しい順 ↓" : "古い順 ↑"
    : filters.direction === "asc" ? "昇順 ↑" : "降順 ↓";
  $("notes").replaceChildren(...notes.map((n) => {
    const li = document.createElement("li");
    if (n.open) li.className = "open";
    li.title = n.folder_path + "\\" + n.name;
    const select = document.createElement("input");
    select.type = "checkbox";
    select.className = "select-note";
    select.checked = selected.has(n.path);
    select.disabled = bulkRunning;
    select.setAttribute("aria-label", n.open ? `${n.title}（開いている付箋）を選択` : `${n.title}を選択`);
    select.addEventListener("click", event => event.stopPropagation());
    select.addEventListener("change", () => {
      if (select.checked) selected.add(n.path);
      else selected.delete(n.path);
      updateSelection(notes);
    });
    const content = document.createElement("div"); content.className = "note-summary";
    paintPaper(content, n.color);
    const title = document.createElement("span"); title.className = "ti"; title.textContent = n.title;
    const heading = document.createElement("div");
    heading.className = "note-heading";
    const previewToggle = document.createElement("button");
    previewToggle.type = "button";
    previewToggle.className = "preview-toggle";
    previewToggle.textContent = "本文";
    previewToggle.setAttribute("aria-label", `${n.title}の本文プレビュー`);
    heading.append(title, previewToggle);
    const meta = document.createElement("span"); meta.className = "meta";
    if (n.archived) meta.append("アーカイブ ");
    for (const tag of n.tags || []) meta.append(tagChip(tag, tagColors.get(tagKey(tag))), " ");
    if (n.metadata_error) { meta.append("属性を読めません"); meta.title = n.metadata_error; }
    const tags = document.createElement("button");
    tags.className = "edit-tags";
    tags.textContent = "タグ";
    tags.setAttribute("aria-label", `${n.title}のタグを編集`);
    tags.addEventListener("click", event => {
      event.stopPropagation();
      tagEditor.open(n.tags || [], async updated => {
        await saveListTags(n, updated);
        await refresh();
      });
    });
    const details = document.createElement("div");
    details.className = "note-details";
    const status = document.createElement("button");
    status.className = "edit-status status-chip";
    status.dataset.statusGroup = statusGroup(n.status);
    paintChip(status, statusColors.get(n.status));
    status.textContent = statusLabel(n.status);
    status.setAttribute("aria-label", `${n.title}のStatusを編集（${status.textContent}）`);
    status.addEventListener("click", event => {
      event.stopPropagation();
      openStatusEditor(n);
    });
    details.append(status, meta, tags);
    content.append(heading, details);
    const destinations = [
      n.window_target != null ? `ウィンドウ: ${n.window_target || "無題"}` : "",
      n.tab_target != null ? `タブ: ${n.tab_target || "無題"}` : "",
    ].filter(Boolean);
    if (destinations.length) {
      const link = document.createElement("span");
      link.className = "link-destination";
      const target = n.tab_target || n.window_target || "無題";
      const app = n.link_app;
      const parts = n.tab_target != null ? [target, app] : [app, target];
      link.textContent = "🔗 " + [...new Set(parts.filter(Boolean))].join(" · ");
      link.title = destinations.join("\n");
      content.append(link);
    }
    const folder = document.createElement("span"); folder.className = "fo"; folder.textContent = n.folder_label;
    const updated = document.createElement("span"); updated.className = "up"; updated.textContent = fmt(n.updated);
    const archive = document.createElement("button"); archive.className = "archive-action";
    if (!n.archived) archive.dataset.path = n.path;
    archive.textContent = n.archived ? "戻す" : "アーカイブ";
    archive.setAttribute("aria-label", `${n.title}を${n.archived ? "アーカイブから戻す" : "アーカイブ"}`);
    archive.addEventListener("click", async event => {
      event.stopPropagation();
      if (!n.archived && !confirmArchive(n.path)) return;
      archive.disabled = true;
      try {
        await invoke("archive_from_list", {path:n.path, archived:!n.archived, baseMtime:n.revision});
        showError(""); await refresh();
      } catch(error) { showError(String(error)); }
      finally { archive.disabled = false; }
    });
    const move = document.createElement("select"); move.className = "move-action";
    move.setAttribute("aria-label", `${n.title}の移動先`);
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "移動先…"; move.append(placeholder);
    for (const destination of cachedFolders.filter(f => f.display !== n.folder_path)) {
      const option = document.createElement("option"); option.value = destination.path; option.textContent = destination.label;
      option.title = destination.display; move.append(option);
    }
    move.disabled = move.options.length < 2;
    move.addEventListener("click", event => event.stopPropagation());
    move.addEventListener("change", async event => {
      event.stopPropagation(); if(!move.value) return; move.disabled = true;
      try { await invoke("move_from_list", {path:n.path, folder:move.value, baseMtime:n.revision}); showError(""); await refresh(); }
      catch(error) { showError(String(error)); }
      finally { move.value = ""; move.disabled = move.options.length < 2; }
    });
    li.append(select, content, folder, updated, move, archive);
    let preview;
    let previewEditor;
    function updatePreview() {
      const expanded = expandedPreviews.has(n.path);
      previewToggle.setAttribute("aria-expanded", String(expanded));
      if (expanded) {
        preview = document.createElement("div");
        preview.className = "note-body-preview";
        preview.addEventListener("click", event => event.stopPropagation());
        li.append(preview);
        const label = `${n.title}の本文`;
        if (n.body?.trim()) {
          const images = noteImages({
            readImage: relative => invoke("read_image_from_list", {path: n.path, relative}),
          });
          previewEditor = createReadOnlyPreview(preview, n.body, label, images);
          previewEditors.add(previewEditor);
        } else {
          preview.setAttribute("aria-label", label);
          preview.textContent = n.revision ? "本文はありません" : "本文を読み込めません";
        }
      } else {
        if (previewEditor) {
          previewEditor.destroy();
          previewEditors.delete(previewEditor);
          previewEditor = undefined;
        }
        preview?.remove();
        preview = undefined;
      }
    }
    previewToggle.addEventListener("click", event => {
      event.stopPropagation();
      if (expandedPreviews.has(n.path)) expandedPreviews.delete(n.path);
      else expandedPreviews.add(n.path);
      updatePreview();
    });
    updatePreview();
    li.addEventListener("click", async () => {
      try { await invoke("open_note_window", { path: n.path }); refresh(); }
      catch (e) { showError(String(e)); }
    });
    return li;
  }));
  updateSelection(notes);
  $("empty").hidden = notes.length > 0;
  const archivedView = filters.archive === "archived";
  const hasNotesInView = cachedNotes.some(note => note.archived === archivedView);
  $("empty").textContent = hasNotesInView ? "絞り込みに一致する付箋がありません。"
    : archivedView ? "アーカイブ済みの付箋はありません。" : "通常の付箋がありません。";
}

function updateSelection(notes) {
  const all = $("select-visible");
  all.checked = notes.length > 0 && selected.size === notes.length;
  all.indeterminate = selected.size > 0 && !all.checked;
  all.disabled = bulkRunning || !notes.length;
  $("selection-count").textContent = selected.size ? `${selected.size}件選択` : "";
  $("bulk-open").disabled = bulkRunning || !selected.size;
  $("bulk-close").disabled = bulkRunning || !notes.some(note => note.open && selected.has(note.path));
  $("bulk-export").disabled = bulkRunning || !selected.size;
  $("bulk-add-tags").disabled = bulkRunning || !selected.size;
  $("open-tag-manager").disabled = bulkRunning;
  $("bulk-archive").hidden = filters.archive === "archived";
  $("bulk-archive").disabled = bulkRunning || !notes.some(note => selected.has(note.path) && !note.archived);
  updateArchiveButtons();
  $("bulk-restore").hidden = filters.archive !== "archived";
  $("bulk-restore").disabled = bulkRunning || !selected.size;
  $("bulk-trash").hidden = filters.archive !== "archived";
  $("bulk-trash").disabled = bulkRunning || !selected.size;
  const canClearLinks = notes.some(note => selected.has(note.path) && (note.window_target != null || note.tab_target != null));
  $("bulk-clear-links").hidden = !canClearLinks;
  $("bulk-clear-links").disabled = bulkRunning || !canClearLinks;
}

function selectedNotes(archived) {
  return selectNotes(cachedNotes, filters).filter(note => selected.has(note.path) && note.archived === archived);
}

async function organizeSelected(targets, action) {
  await runNoteBatch(targets, async note => {
    const args = {path: note.path, baseMtime: note.revision};
    if (action === "open") await invoke("open_note_window", {path: note.path});
    else if (action === "trash") await invoke("trash_from_list", args);
    else await invoke("archive_from_list", {...args, archived: action === "archive", closedOnly: true});
    selected.delete(note.path);
  });
}

async function runNoteBatch(targets, update) {
  if (bulkRunning || !targets.length) return;
  bulkRunning = true;
  renderNotes();
  try {
    const failures = [];
    for (const note of targets) {
      try {
        await update(note);
      } catch (error) {
        failures.push(`${note.title}：${error}`);
      }
    }
    await refresh();
    showError(failures.length ? `${targets.length - failures.length}件完了、${failures.length}件処理できませんでした。\n${failures.join("\n")}` : "");
  } finally {
    bulkRunning = false;
    renderNotes();
  }
}

$("select-visible").addEventListener("change", event => {
  selected.clear();
  if (event.target.checked) {
    for (const note of selectNotes(cachedNotes, filters)) selected.add(note.path);
  }
  renderNotes();
});
function bulkArchiveKey(notes) {
  return JSON.stringify(notes.filter(note => selected.has(note.path) && !note.archived).map(note => note.path).sort());
}

function saveListTags(note, tags) {
  return invoke("set_tags_from_list", {path: note.path, tags, baseMtime: note.revision});
}

const statusDialog = $("status-dialog");
const statusInput = $("status-input");
let statusNote;
let statusDraft;
let statusColors;
const statusColorChanges = new Map();
const statusColor = $("status-color");
const resetStatusColor = $("reset-status-color");

function renderStatusChoices() {
  const query = statusInput.value.trim();
  const values = statusChoices(cachedNotes, query);
  const row = (value, label, isNew = false) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    if (isNew) {
      button.textContent = label;
    } else {
      const chip = document.createElement("span");
      chip.className = "tag-chip status-chip";
      chip.dataset.statusGroup = statusGroup(value);
      paintChip(chip, chipColor(value, statusColors, statusColorChanges));
      chip.textContent = label;
      button.append(chip);
      button.setAttribute("aria-pressed", String(value === statusDraft));
    }
    button.addEventListener("click", () => {
      statusDraft = value;
      statusInput.value = "";
      renderStatusChoices();
      statusInput.focus();
    });
    item.append(button);
    return item;
  };
  const rows = values.map(value => row(value, statusLabel(value)));
  if (query && matchingStatus(query, values) === undefined) rows.push(row(query, `作成 ${query}`, true));
  const current = $("status-current");
  current.textContent = statusLabel(statusDraft);
  current.dataset.statusGroup = statusGroup(statusDraft);
  const custom = chipColor(statusDraft, statusColors, statusColorChanges);
  paintChip(current, custom);
  const defaultColor = getComputedStyle(current).getPropertyValue("--status-bg").trim();
  statusColor.value = custom || defaultColor;
  resetStatusColor.hidden = !custom;
  $("status-options").replaceChildren(...rows);
  $("status-options").scrollTop = 0;
}

function matchingStatus(query, values) {
  const key = value => value.normalize("NFKC").toLowerCase();
  return values.find(value => key(value) === key(query) || key(statusLabel(value)) === key(query));
}

function openStatusEditor(note) {
  statusNote = note;
  statusDraft = note.status;
  statusColors = readChipColors("status");
  statusColorChanges.clear();
  statusInput.value = "";
  $("status-error").hidden = true;
  statusDialog.showModal();
  renderStatusChoices();
  statusInput.focus();
}

function dismissStatus() {
  if ($("save-status").disabled) return;
  const close = () => statusDialog.close();
  if (statusDraft === statusNote.status && !statusColorChanges.size) close();
  else confirmTagDiscard(close);
}

dismissDialogOnOutsideClick(statusDialog, dismissStatus);
statusInput.addEventListener("input", renderStatusChoices);
statusInput.addEventListener("compositionend", renderStatusChoices);
statusColor.addEventListener("input", () => {
  updateChipColor(statusColorChanges, statusColors, statusDraft, statusColor.value);
  renderStatusChoices();
});
resetStatusColor.addEventListener("click", () => {
  updateChipColor(statusColorChanges, statusColors, statusDraft, null);
  renderStatusChoices();
  statusColor.focus();
});
$("cancel-status").addEventListener("click", dismissStatus);
statusDialog.addEventListener("cancel", event => {
  event.preventDefault();
  dismissStatus();
});
$("status-form").addEventListener("submit", async event => {
  event.preventDefault();
  if ($("save-status").disabled) return;
  const query = statusInput.value.trim();
  const status = query ? matchingStatus(query, statusChoices(cachedNotes, query)) ?? query : statusDraft;
  if (status === statusNote.status && !statusColorChanges.size) { statusDialog.close(); return; }
  $("save-status").disabled = true;
  statusInput.disabled = true;
  statusColor.disabled = true;
  resetStatusColor.disabled = true;
  $("status-error").hidden = true;
  try {
    if (status !== statusNote.status) {
      const revision = await invoke("set_status_from_list", {path: statusNote.path, baseMtime: statusNote.revision, status});
      statusNote = {...statusNote, status, revision};
      statusDraft = status;
      statusInput.value = "";
    }
    saveChipColors("status", statusColorChanges);
    await refresh();
    renderNotes();
    statusDialog.close();
  } catch (error) {
    $("status-error").textContent = error === "conflict" ? "付箋が別の場所で変更されました。開き直してください。" : String(error);
    $("status-error").hidden = false;
  } finally {
    $("save-status").disabled = false;
    statusInput.disabled = false;
    statusColor.disabled = false;
    resetStatusColor.disabled = false;
  }
});
window.addEventListener("storage", event => {
  if (event.key === chipColorKey("tag") || event.key === chipColorKey("status")) renderNotes();
});

$("bulk-add-tags").addEventListener("click", () => {
  const targets = selectedNotes(filters.archive === "archived");
  tagEditor.open([], tags => runNoteBatch(targets.filter(note => tags.some(tag => !note.tags?.includes(tag))),
    note => saveListTags(note, [...new Set([...(note.tags || []), ...tags])])),
    {title: "選択した付箋にタグを追加"});
});

const tagManager = $("tag-manager-dialog");
const tagChange = $("tag-change-dialog");
const managedTag = $("manage-tag");
const replacementTag = $("replacement-tag");
let pendingTagChange;

function dismissTagManager() {
  const close = () => tagManager.close();
  if (replacementTag.value.trim()) confirmTagDiscard(close);
  else close();
}

dismissDialogOnOutsideClick(tagManager, dismissTagManager);
dismissDialogOnOutsideClick(tagChange, () => tagChange.close("cancel"));
tagManager.addEventListener("cancel", event => {
  event.preventDefault();
  dismissTagManager();
});

function notesWithTag(tag) {
  return cachedNotes.filter(note => note.tags?.includes(tag));
}

function updateTagManager() {
  const count = notesWithTag(managedTag.value).length;
  $("manage-tag-count").textContent = count ? (count + "件の付箋で使用中（アーカイブを含む）") : "使用中のタグがありません。";
  $("delete-tag").disabled = !count;
  $("replace-tag").disabled = !count || !replacementTag.value.trim() || replacementTag.value.trim() === managedTag.value;
}

$("open-tag-manager").addEventListener("click", async () => {
  await refresh();
  const tags = choices(cachedNotes, "tags");
  options("manage-tag", tags.map(tag => [tag, tag]), tags[0]);
  options("existing-tags", tags.map(tag => [tag, tag]), "");
  replacementTag.value = "";
  updateTagManager();
  if (!tagManager.open) tagManager.showModal();
});
$("close-tag-manager").addEventListener("click", dismissTagManager);
managedTag.addEventListener("change", updateTagManager);
replacementTag.addEventListener("input", updateTagManager);
$("tag-manager-form").addEventListener("submit", event => {
  const action = event.submitter?.value;
  if (action !== "delete" && action !== "replace") return;
  event.preventDefault();
  const tag = managedTag.value;
  const replacement = action === "delete" ? "" : replacementTag.value.trim();
  const targets = notesWithTag(tag);
  if (!targets.length || (action === "replace" && (!replacement || replacement === tag))) return;
  pendingTagChange = {tag, replacement, targets};
  $("tag-change-summary").textContent = replacement
    ? targets.length + "件の付箋の「" + tag + "」を「" + replacement + "」に置き換えますか？"
    : "「" + tag + "」は" + targets.length + "件の付箋に付いています。これらの付箋からタグを削除しますか？";
  $("apply-tag-change").textContent = replacement ? "置換する" : "タグを削除する";
  tagChange.returnValue = "";
  tagChange.showModal();
});
tagChange.addEventListener("close", () => {
  const change = pendingTagChange;
  pendingTagChange = undefined;
  if (tagChange.returnValue !== "apply" || !change || bulkRunning) return;
  tagManager.close();
  const {tag, replacement, targets} = change;
  void runNoteBatch(targets, note => saveListTags(note, [...new Set(
    note.tags.flatMap(value => value !== tag ? [value] : replacement ? [replacement] : [])
  )]));
});

$("bulk-open").addEventListener("click", () => organizeSelected(selectedNotes(filters.archive === "archived"), "open"));
$("bulk-close").addEventListener("click", () => runNoteBatch(
  selectedNotes(filters.archive === "archived").filter(note => note.open),
  note => invoke("close_from_list", {path: note.path})));
$("bulk-export").addEventListener("click", async () => {
  const paths = selectedNotes(filters.archive === "archived").map(note => note.path);
  if (bulkRunning || !paths.length) return;
  bulkRunning = true;
  renderNotes();
  showError("");
  $("export-result").textContent = "";
  try {
    const count = await invoke("export_notes", {paths});
    if (count) $("export-result").textContent = `${count}件の付箋を書き出しました`;
  } catch (error) {
    showError(`ZIPを書き出せませんでした。 ${error}`);
  } finally {
    bulkRunning = false;
    renderNotes();
  }
});
$("bulk-archive").addEventListener("click", () => {
  const targets = selectedNotes(false);
  if (targets.length && confirmArchive(bulkArchiveKey(targets))) organizeSelected(targets, "archive");
});
window.addEventListener("blur", cancelArchiveConfirmation);
document.addEventListener("keydown", event => {
  if (event.key === "Escape") cancelArchiveConfirmation();
});
$("bulk-restore").addEventListener("click", () => organizeSelected(selectedNotes(true), "restore"));
$("bulk-trash").addEventListener("click", () => {
  if (bulkRunning || filters.archive !== "archived") return;
  pendingTrash = selectedNotes(true);
  if (!pendingTrash.length) return;
  const dialog = $("bulk-trash-dialog");
  dialog.returnValue = "cancel";
  $("bulk-trash-summary").textContent = `選択した${pendingTrash.length}件をゴミ箱へ移します。`;
  dialog.showModal();
});
$("bulk-trash-dialog").addEventListener("close", event => {
  const targets = pendingTrash;
  pendingTrash = [];
  if (event.currentTarget.returnValue === "trash") organizeSelected(targets, "trash");
});

$("bulk-clear-links").addEventListener("click", () => {
  if (bulkRunning) return;
  pendingClearLinks = selectedNotes(filters.archive === "archived")
    .filter(note => note.window_target != null || note.tab_target != null);
  if (!pendingClearLinks.length) return;
  const dialog = $("bulk-clear-links-dialog");
  dialog.returnValue = "cancel";
  $("bulk-clear-links-summary").textContent =
    `選択中の${pendingClearLinks.length}件から、ウィンドウの貼付けとタブリンクを解除します。`;
  dialog.showModal();
});

$("bulk-clear-links-dialog").addEventListener("close", async event => {
  const targets = pendingClearLinks;
  pendingClearLinks = [];
  if (event.currentTarget.returnValue !== "clear" || bulkRunning || !targets.length) return;
  bulkRunning = true;
  renderNotes();
  try {
    await invoke("clear_links_from_list", {paths: targets.map(note => note.path)});
    showError("");
    await refresh();
  } catch (error) {
    showError(String(error));
  } finally {
    bulkRunning = false;
    renderNotes();
  }
});

function showError(msg) {
  const el = $("error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function refresh() {
  let registrations, notes;
  try {
    [registrations, notes] = await Promise.all([invoke("get_folders"), invoke("list_notes")]);
  } catch (e) { showError(String(e)); return; }
  const {active: folders, removed} = registrations;
  const sig = JSON.stringify([registrations, notes]);
  if (sig === last) return;
  last = sig;
  cachedNotes = notes;
  const existingPaths = new Set(notes.map(note => note.path));
  for (const path of expandedPreviews) if (!existingPaths.has(path)) expandedPreviews.delete(path);
  cachedFolders = folders;

  // 新規付箋を作るフォルダの選択(選んだものは残す)
  const sel = $("target");
  let keep = sel.value;
  try { keep ||= localStorage.getItem("target") || ""; } catch (_) { /* 設定保存がなくても使える */ }
  sel.replaceChildren(...folders.map((f) => {
    const o = document.createElement("option");
    o.value = f.path; o.textContent = f.label; o.title = f.display;
    return o;
  }));
  if (folders.some((f) => f.path === keep)) sel.value = keep;

  // 登録フォルダ
  $("folder-chips").replaceChildren(...folders.map((f) => {
    const c = document.createElement("span");
    c.className = "chip" + (f.ok ? "" : " bad");
    c.title = f.display + (f.ok ? "" : "(開けません)");
    const t = document.createElement("span");
    t.textContent = f.label;
    const open = document.createElement("button");
    open.className = "open-folder";
    open.textContent = "📂"; open.title = "エクスプローラーで開く";
    open.setAttribute("aria-label", `${f.label}をエクスプローラーで開く`);
    open.disabled = !f.ok;
    open.addEventListener("click", async () => {
      try { await invoke("open_folder", { path: f.path }); showError(""); }
      catch (e) { showError(String(e)); }
    });
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "このフォルダの登録を解除";
    x.setAttribute("aria-label", `${f.label}の登録を解除`);
    let confirmTimer;
    function resetRemove() {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
      x.classList.remove("armed");
      x.textContent = "×";
      x.setAttribute("aria-label", `${f.label}の登録を解除`);
    }
    x.addEventListener("blur", resetRemove);
    x.addEventListener("keydown", event => {
      if (event.key === "Escape") resetRemove();
    });
    x.addEventListener("click", async () => {
      if (confirmTimer === undefined) {
        x.classList.add("armed");
        x.textContent = "もう一度押すと登録解除";
        x.setAttribute("aria-label", `もう一度押して${f.label}の登録を解除`);
        confirmTimer = setTimeout(resetRemove, 3000);
        return;
      }
      resetRemove();
      x.disabled = true;
      try {
        await invoke("remove_folder", { path: f.path });
        showError("");
        await refresh();
      }
      catch (e) { showError(String(e)); }
      finally { x.disabled = false; }
    });
    c.append(t, open, x);
    return c;
  }));

  $("folder-history-empty").hidden = removed.length > 0;
  $("removed-folders").replaceChildren(...removed.map(folder => {
    const item = document.createElement("li");
    const location = document.createElement("div");
    location.className = "folder-history-location";
    const name = document.createElement("strong");
    name.textContent = folder.label;
    const path = document.createElement("span");
    path.textContent = folder.display;
    path.title = folder.display;
    location.append(name, path);
    const restore = document.createElement("button");
    restore.textContent = "再登録";
    restore.setAttribute("aria-label", `${folder.label}を再登録`);
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      showHistoryError("");
      try {
        await invoke("restore_folder", { path: folder.path });
        showError("");
        await refresh();
      } catch (error) {
        showHistoryError(String(error));
      } finally {
        restore.disabled = false;
      }
    });
    item.append(location, restore);
    return item;
  }));

  renderFilters();
  renderNotes();
}

function showHistoryError(message) {
  $("folder-history-error").textContent = message;
  $("folder-history-error").hidden = !message;
}

const settingsDialog = $("settings-dialog");
const importFolder = $("import-folder");
const importZip = $("import-zip");
const importResult = $("import-result");
let importing = false;
let savedStyleFields = "";

function styleFields() {
  return JSON.stringify([...$("list-style-manager").querySelectorAll("input, select")].map(field =>
    field.type === "checkbox" ? field.checked : field.value));
}

function dismissSettings() {
  const close = () => settingsDialog.close();
  if (styleFields() === savedStyleFields) close();
  else confirmTagDiscard(close);
}

function updateImportButton() {
  importZip.disabled = importing || !importFolder.value;
  importFolder.disabled = importing || !importFolder.options.length;
}

dismissDialogOnOutsideClick(settingsDialog, dismissSettings);
settingsDialog.addEventListener("cancel", event => {
  event.preventDefault();
  dismissSettings();
});
settingsDialog.querySelector(".settings-header form").addEventListener("submit", event => {
  event.preventDefault();
  dismissSettings();
});
for (const id of ["bulk-trash-dialog", "bulk-clear-links-dialog", "discard-tags-dialog"]) {
  const dialog = $(id);
  dismissDialogOnOutsideClick(dialog, () => dialog.close("cancel"));
}

$("open-settings").addEventListener("click", () => {
  showHistoryError("");
  renderStyleManager($("list-style-manager"), () => { savedStyleFields = styleFields(); });
  savedStyleFields = styleFields();
  const folders = cachedFolders.filter(folder => folder.ok);
  const target = [importFolder.value, $("target").value].find(path => folders.some(folder => folder.path === path));
  options("import-folder", folders.map(folder => [folder.path, folder.label]), target ?? folders[0]?.path ?? "");
  importResult.textContent = folders.length ? "" : "一覧で取り込み先のフォルダを追加してください。";
  importResult.hidden = Boolean(folders.length);
  updateImportButton();
  settingsDialog.showModal();
});

importZip.addEventListener("click", async () => {
  if (importing || !importFolder.value) return;
  importing = true;
  updateImportButton();
  importResult.hidden = false;
  importResult.textContent = "ZIPファイルを選んでください。";
  try {
    const count = await invoke("import_notes", {folder: importFolder.value});
    if (count) {
      await refresh();
      importResult.textContent = `${count}件の付箋を取り込みました。`;
    } else {
      importResult.hidden = true;
    }
  } catch (error) {
    importResult.textContent = `取り込めませんでした。 ${error}`;
  } finally {
    importing = false;
    updateImportButton();
  }
});

let unusedImages = [];
const scanUnused = $("scan-unused-images");
const trashUnused = $("trash-unused-images");
const unusedStatus = $("unused-images-status");

scanUnused.addEventListener("click", async () => {
  scanUnused.disabled = true;
  trashUnused.hidden = true;
  unusedImages = [];
  unusedStatus.textContent = "確認中…";
  try {
    unusedImages = await invoke("unused_images");
    unusedStatus.textContent = unusedImages.length
      ? `${unusedImages.length}件の未使用画像が見つかりました。移動先は attachments/.trash です。`
      : "未使用の画像はありません。";
    trashUnused.hidden = unusedImages.length === 0;
  } catch (error) {
    unusedStatus.textContent = String(error);
  } finally {
    scanUnused.disabled = false;
  }
});

trashUnused.addEventListener("click", async () => {
  const images = Object.create(null);
  for (const {folder, name} of unusedImages) (images[folder] ??= []).push(name);
  unusedImages = [];
  trashUnused.hidden = true;
  scanUnused.disabled = true;
  try {
    const moved = await invoke("trash_unused_images", {images});
    unusedStatus.textContent = `${moved}件を attachments/.trash に移動しました。`;
  } catch (error) {
    unusedStatus.textContent = String(error);
  } finally {
    scanUnused.disabled = false;
  }
});

$("new").addEventListener("click", async () => {
  const folder = $("target").value;
  if (!folder) { showError("先にフォルダを追加してください"); return; }
  try { localStorage.setItem("target", folder); } catch (_) { /* 設定保存がなくても作成できる */ }
  try { await invoke("new_note", { folder }); showError(""); refresh(); }
  catch (e) { showError(String(e)); }
});

$("add-folder").addEventListener("click", async () => {
  try {
    const dir = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
    if (dir) { await invoke("add_folder", { path: dir }); showError(""); refresh(); }
  } catch (e) { showError(String(e)); }
});

$("quit").addEventListener("click", () => invoke("quit_app"));

$("search").value = filters.query;
$("sort").value = filters.sort;
for (const button of $("note-views").querySelectorAll("button")) {
  button.setAttribute("aria-pressed", String(button.dataset.view === filters.archive));
  button.addEventListener("click", () => {
    if (bulkRunning || filters.archive === button.dataset.view) return;
    filters.archive = button.dataset.view;
    selected.clear();
    for (const view of $("note-views").querySelectorAll("button")) {
      view.setAttribute("aria-pressed", String(view === button));
    }
    remember();
    renderNotes();
  });
}
$("search").addEventListener("input", () => { filters.query = $("search").value; remember(); renderNotes(); });
for (const [id, key] of [["filter-folder", "folder"], ["filter-tag", "tag"], ["filter-status", "status"]]) {
  $(id).addEventListener("change", () => { filters[key] = $(id).value; remember(); renderNotes(); });
}
$("sort").addEventListener("change", () => {
  filters.sort = $("sort").value;
  filters.direction = ["updated", "created"].includes(filters.sort) ? "desc" : "asc";
  remember(); renderNotes();
});
$("direction").addEventListener("click", () => { filters.direction = filters.direction === "asc" ? "desc" : "asc"; remember(); renderNotes(); });
$("reset-filters").addEventListener("click", () => {
  filters = {...defaults(), archive: filters.archive}; $("search").value = ""; $("sort").value = filters.sort;
  remember(); renderFilters(); renderNotes();
});

refresh();
setInterval(refresh, POLL_MS);
