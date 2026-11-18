import { dismissDialogOnOutsideClick } from "./tag-editor.js";

export function bindTrashManager(refresh) {
  const {invoke} = window.__TAURI__.core;
  const $ = id => document.getElementById(id);
  const dialog = $("trash-manager");
  const confirm = $("trash-delete-confirm");
  let entries = [], busy = false;
  const selected = new Set();
  const close = () => { if (!busy) dialog.close(); };
  dismissDialogOnOutsideClick(dialog, close);
  dismissDialogOnOutsideClick(confirm, () => confirm.close());
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("close-trash").onclick = close;
  const visible = () => entries.filter(entry => !$("trash-search").value ||
    `${entry.title} ${entry.folder}`.toLocaleLowerCase().includes($("trash-search").value.toLocaleLowerCase()));
  function render() {
    const items = visible();
    $("trash-entries").replaceChildren(...items.map(entry => {
      const row = document.createElement("label");
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = selected.has(entry.path); check.disabled = busy;
      check.onchange = () => { check.checked ? selected.add(entry.path) : selected.delete(entry.path); render(); };
      const title = document.createElement("span");
      title.textContent = entry.title || "無題";
      const location = document.createElement("small");
      location.textContent = `${entry.folder}${entry.archived ? " · アーカイブ" : ""}`;
      title.append(location); row.append(check,title); return row;
    }));
    $("trash-count").textContent = `${selected.size}件選択 / ${items.length}件`;
    $("trash-empty").hidden = items.length !== 0;
    for (const id of ["restore-trash", "delete-trash"]) $(id).disabled = busy || !selected.size;
    $("select-trash").disabled = busy || !items.length;
    $("reload-trash").disabled = busy;
    $("trash-search").disabled = busy;
    $("close-trash").disabled = busy;
  }
  async function load() {
    entries = await invoke("list_trash");
    for (const key of selected) if (!entries.some(e => e.path === key)) selected.delete(key);
    render();
  }
  $("open-trash").onclick = async () => {
    selected.clear(); $("trash-search").value = ""; $("trash-result").textContent = "";
    dialog.showModal();
    try { await load(); } catch(e) { $("trash-result").textContent = String(e); }
  };
  $("reload-trash").onclick = async () => { try { await load(); } catch(e) { $("trash-result").textContent = String(e); } };
  $("trash-search").oninput = render;
  $("select-trash").onclick = () => {
    const items = visible(), all = items.every(e => selected.has(e.path));
    for (const e of items) all ? selected.delete(e.path) : selected.add(e.path);
    render();
  };
  async function run(remove) {
    if (busy) return;
    const targets = entries.filter(e => selected.has(e.path));
    if (!targets.length) return;
    busy = true; render();
    let count = 0; const errors = [];
    try {
      for (const entry of targets) {
        try {
          await invoke("change_trash", {folder:entry.folder,path:entry.path,revision:entry.revision,delete:remove});
          selected.delete(entry.path); count++;
        } catch(e) { errors.push(`${entry.title}: ${e}`); }
      }
      await load(); await refresh();
      $("trash-result").textContent = `${count}件${remove ? "を完全削除しました。" : "を元のフォルダに戻しました。"}${errors.length ? `\n${errors.join("\n")}` : ""}`;
    } catch(e) { $("trash-result").textContent = String(e); }
    finally { busy = false; render(); }
  }
  $("restore-trash").onclick = () => run(false);
  $("delete-trash").onclick = () => {
    $("trash-delete-summary").textContent = `${selected.size}件の付箋を完全に削除します。元に戻せません。`;
    confirm.showModal();
  };
  $("confirm-delete-trash").onclick = () => { confirm.close(); run(true); };
}
