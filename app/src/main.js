// 一覧窓。登録フォルダの付箋を一覧にして、クリックで開く。
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;

let last = "";

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
  notes.sort((a, b) => b.updated - a.updated);
  const sig = JSON.stringify([folders, notes]);
  if (sig === last) return;
  last = sig;

  // 新規付箋を作るフォルダの選択(選んだものは残す)
  const sel = $("target");
  const keep = sel.value || localStorage.getItem("target") || "";
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

  // 付箋
  $("notes").replaceChildren(...notes.map((n) => {
    const li = document.createElement("li");
    if (n.open) li.className = "open";
    li.title = n.folder_path + "\\" + n.name;
    const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = n.open ? "●" : "";
    const ti = document.createElement("span"); ti.className = "ti"; ti.textContent = n.title;
    const fo = document.createElement("span"); fo.className = "fo"; fo.textContent = n.folder_label;
    const up = document.createElement("span"); up.className = "up"; up.textContent = fmt(n.updated);
    li.append(dot, ti, fo, up);
    li.addEventListener("click", async () => {
      try { await invoke("open_note_window", { path: n.path }); refresh(); }
      catch (e) { showError(String(e)); }
    });
    return li;
  }));
  $("empty").hidden = notes.length > 0;
}

$("new").addEventListener("click", async () => {
  const folder = $("target").value;
  if (!folder) { showError("先にフォルダを追加してください"); return; }
  localStorage.setItem("target", folder);
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

refresh();
setInterval(refresh, POLL_MS);
