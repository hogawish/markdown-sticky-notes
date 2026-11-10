export function bindTagEditor() {
  const $ = id => document.getElementById(id);
  const tagsDialog = $("tags-dialog");
  let saveTags;
  let tagDraft = [];
  let savingTags = false;

  function renderTags() {
    const list = $("tag-list");
    list.replaceChildren();
    for (const tag of tagDraft) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = tag;
      const remove = document.createElement("button");
      remove.textContent = "削除";
      remove.setAttribute("aria-label", `タグ「${tag}」を削除`);
      remove.addEventListener("click", () => {
        tagDraft = tagDraft.filter(value => value !== tag);
        renderTags();
        $("tag-input").focus();
      });
      row.append(name, remove);
      list.append(row);
    }
  }

  function addTag() {
    const input = $("tag-input");
    const tag = input.value.trim();
    if (tag && !tagDraft.includes(tag)) tagDraft.push(tag);
    input.value = "";
    renderTags();
  }

  function open(tags, onSave) {
    if (tagsDialog.open) return;
    tagDraft = [...tags];
    saveTags = onSave;
    $("tag-input").value = "";
    $("tag-error").hidden = true;
    renderTags();
    tagsDialog.showModal();
    $("tag-input").focus();
  }
  $("tag-add").addEventListener("submit", event => {
    event.preventDefault();
    addTag();
  });
  $("tags-cancel").addEventListener("click", () => tagsDialog.close());
  tagsDialog.addEventListener("cancel", event => {
    if (savingTags) event.preventDefault();
  });
  $("tags-save").addEventListener("click", async () => {
    if (savingTags) return;
    addTag();
    savingTags = true;
    const controls = [...tagsDialog.querySelectorAll("button, input")];
    controls.forEach(control => control.disabled = true);
    $("tag-error").hidden = true;
    try {
      await saveTags(tagDraft);
      tagsDialog.close();
    } catch (error) {
      $("tag-error").textContent = error === "conflict"
        ? "別の場所で変更されました。閉じてから、最新のタグを開き直してください。"
        : String(error);
      $("tag-error").hidden = false;
    } finally {
      savingTags = false;
      controls.forEach(control => control.disabled = false);
    }
  });

  return { open };
}
