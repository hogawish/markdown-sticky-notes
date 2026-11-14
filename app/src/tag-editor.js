export function bindTagEditor(getSuggestions = () => []) {
  const $ = id => document.getElementById(id);
  const tagsDialog = $("tags-dialog");
  let saveTags;
  let tagDraft = [];
  let savingTags = false;
  let suggestions = [];
  let suggestionRequest = 0;

  function renderTags() {
    const list = $("tag-list");
    list.replaceChildren();
    $("tag-suggestions").replaceChildren(...suggestions.filter(tag => !tagDraft.includes(tag)).map(tag => {
      const option = document.createElement("option");
      option.value = tag;
      return option;
    }));
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

  function open(tags, onSave, {title = "タグ"} = {}) {
    if (tagsDialog.open) return;
    $("tags-title").textContent = title;
    tagDraft = [...tags];
    suggestions = [];
    saveTags = onSave;
    $("tag-input").value = "";
    $("tag-error").hidden = true;
    renderTags();
    tagsDialog.showModal();
    $("tag-input").focus();
    void loadSuggestions(++suggestionRequest);
  }
  async function loadSuggestions(request) {
    try {
      const tags = await getSuggestions();
      if (!tagsDialog.open || request !== suggestionRequest) return;
      suggestions = tags;
      renderTags();
    } catch {
      // Keep free text entry available when the tag list cannot be loaded.
    }
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
