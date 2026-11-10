import { bindTagEditor } from "./tag-editor.js";
// 一覧窓。登録フォルダの付箋を一覧にして、クリックで開く。
import { selectNotes, choices, UNASSIGNED } from "./list-model.js";
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const tagEditor = bindTagEditor();

let last = "";
let cachedNotes = [];
let cachedFolders = [];
const defaults = () => ({ query: "", folder: "", tag: "", status: "", archive: "active", sort: "updated", direction: "desc" });
let filters = defaults();
try { Object.assign(filters, JSON.parse(localStorage.getItem("list-filters") || "{}")); } catch (_) { /* 初回と保存不可でも使える */ }
for (const key of Object.keys(defaults())) if (typeof filters[key] !== "string") filters[key] = defaults()[key];
if (!["updated", "created", "title", "folder"].includes(filters.sort)) filters.sort = "updated";
if (!["asc", "desc"].includes(filters.direction)) filters.direction = "desc";
if (!["active", "archived", "all"].includes(filters.archive)) filters.archive = "active";

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
  options("filter-status", [["", "すべてのstatus"], [UNASSIGNED, "statusなし（未整理）"], ...choices(cachedNotes, "status").map(status => ["v:" + status, status])], filters.status);
}

function renderNotes() {
  const notes = selectNotes(cachedNotes, filters);
  $("count").textContent = `${notes.length} / ${cachedNotes.length} 件`;
  $("direction").textContent = ["updated", "created"].includes(filters.sort)
    ? filters.direction === "desc" ? "新しい順 ↓" : "古い順 ↑"
    : filters.direction === "asc" ? "昇順 ↑" : "降順 ↓";
  $("notes").replaceChildren(...notes.map((n) => {
    const li = document.createElement("li");
    if (n.open) li.className = "open";
    li.title = n.folder_path + "\\" + n.name;
    const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = n.open ? "●" : "";
    const content = document.createElement("div"); content.className = "note-summary";
    const title = document.createElement("span"); title.className = "ti"; title.textContent = n.title;
    const meta = document.createElement("span"); meta.className = "meta";
    meta.textContent = [n.archived ? "アーカイブ" : "", n.status || "未整理", ...(n.tags || []).map(tag => "#" + tag)].filter(Boolean).join(" · ");
    if (n.metadata_error) { meta.textContent += " · 属性を読めません"; meta.title = n.metadata_error; }
    const tags = document.createElement("button");
    tags.className = "edit-tags";
    tags.textContent = "タグ";
    tags.setAttribute("aria-label", `${n.title}のタグを編集`);
    tags.addEventListener("click", event => {
      event.stopPropagation();
      tagEditor.open(n.tags || [], async updated => {
        await invoke("set_tags_from_list", {path: n.path, tags: updated, baseMtime: n.revision});
        await refresh();
      });
    });
    const details = document.createElement("div");
    details.className = "note-details";
    details.append(meta, tags);
    content.append(title, details);
    const folder = document.createElement("span"); folder.className = "fo"; folder.textContent = n.folder_label;
    const updated = document.createElement("span"); updated.className = "up"; updated.textContent = fmt(n.updated);
    const archive = document.createElement("button"); archive.className = "archive-action";
    archive.textContent = n.archived ? "戻す" : "アーカイブ";
    archive.setAttribute("aria-label", `${n.title}を${n.archived ? "アーカイブから戻す" : "アーカイブ"}`);
    archive.addEventListener("click", async event => {
      event.stopPropagation(); archive.disabled = true;
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
    li.append(dot, content, folder, updated, move, archive);
    li.addEventListener("click", async () => {
      try { await invoke("open_note_window", { path: n.path }); refresh(); }
      catch (e) { showError(String(e)); }
    });
    return li;
  }));
  $("empty").hidden = notes.length > 0;
  $("empty").textContent = cachedNotes.length ? "条件に合う付箋がありません。リセットするとすべて表示します。" : "付箋がありません。「新規付箋」で作れます。";
}

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
  let folders, notes;
  try {
    [folders, notes] = await Promise.all([invoke("get_folders"), invoke("list_notes")]);
  } catch (e) { showError(String(e)); return; }
  const sig = JSON.stringify([folders, notes]);
  if (sig === last) return;
  last = sig;
  cachedNotes = notes;
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
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "このフォルダを外す(中身は消えません)";
    x.addEventListener("click", async () => {
      if (!confirm(`「${f.label}」を一覧から外します。付箋のファイルは消えません。`)) return;
      try { await invoke("remove_folder", { path: f.path }); showError(""); refresh(); }
      catch (e) { showError(String(e)); }
    });
    c.append(t, x);
    return c;
  }));

  renderFilters();
  renderNotes();
}

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
$("filter-archive").value = filters.archive;
$("search").addEventListener("input", () => { filters.query = $("search").value; remember(); renderNotes(); });
for (const [id, key] of [["filter-folder", "folder"], ["filter-tag", "tag"], ["filter-status", "status"], ["filter-archive", "archive"]]) {
  $(id).addEventListener("change", () => { filters[key] = $(id).value; remember(); renderNotes(); });
}
$("sort").addEventListener("change", () => {
  filters.sort = $("sort").value;
  filters.direction = ["updated", "created"].includes(filters.sort) ? "desc" : "asc";
  remember(); renderNotes();
});
$("direction").addEventListener("click", () => { filters.direction = filters.direction === "asc" ? "desc" : "asc"; remember(); renderNotes(); });
$("reset-filters").addEventListener("click", () => {
  filters = defaults(); $("search").value = ""; $("sort").value = filters.sort; $("filter-archive").value = filters.archive;
  remember(); renderFilters(); renderNotes();
});

refresh();
setInterval(refresh, POLL_MS);
