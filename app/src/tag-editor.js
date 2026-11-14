export function dismissDialogOnOutsideClick(dialog, dismiss) {
  function outside(event) {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX >= bounds.right
      || event.clientY < bounds.top || event.clientY >= bounds.bottom;
  }
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", event => { pressedOutside = outside(event); });
  dialog.addEventListener("click", event => {
    if (pressedOutside && outside(event)) dismiss();
    pressedOutside = false;
  });
}

export function confirmTagDiscard(dismiss) {
  const confirmation = document.getElementById("discard-tags-dialog");
  if (confirmation.open) return;
  confirmation.returnValue = "";
  confirmation.addEventListener("close", () => {
    if (confirmation.returnValue === "discard") dismiss();
  }, {once: true});
  confirmation.showModal();
}

function tagChip(tag, tone = 0) {
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.dataset.tone = String(tone);
  chip.textContent = tag;
  return chip;
}

export function bindTagEditor(getSuggestions = () => []) {
  const $ = id => document.getElementById(id);
  const tagsDialog = $("tags-dialog");
  const input = $("tag-input");
  let saveTags;
  let tagDraft = [];
  let originalTags = [];
  let savingTags = false;
  let suggestions = [];
  let suggestionRequest = 0;

  function renderTags() {
    const list = $("tag-list");
    list.replaceChildren();
    renderSuggestions();
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

  function renderSuggestions() {
    const typed = input.value.trim();
    const query = typed.normalize("NFKC").toLowerCase();
    const canCreate = typed && !suggestions.includes(typed) && !tagDraft.includes(typed);
    const matches = suggestions.filter(tag => !tagDraft.includes(tag)
      && tag.normalize("NFKC").toLowerCase().includes(query));
    $("tag-suggestions").hidden = !matches.length && !canCreate;
    const rows = matches.map(tag => suggestionRow(tag));
    if (canCreate) rows.push(suggestionRow(typed, true));
    $("tag-suggestion-list").replaceChildren(...rows);
  }

  function suggestionRow(tag, create = false) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = savingTags;
    if (create) {
      button.className = "create-tag";
      button.textContent = "作成 ";
    }
    const tone = create ? 0 : 1 + [...tag].reduce((sum, character) => sum + character.codePointAt(0), 0) % 4;
    button.append(tagChip(tag, tone));
    button.addEventListener("click", () => {
      addTag(tag);
      input.focus();
    });
    row.append(button);
    return row;
  }

  function addTag(tag = input.value.trim()) {
    if (tag && !tagDraft.includes(tag)) tagDraft.push(tag);
    input.value = "";
    renderTags();
  }

  function open(tags, onSave, {title = "タグ"} = {}) {
    if (tagsDialog.open) return;
    $("tags-title").textContent = title;
    originalTags = [...tags];
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
      renderSuggestions();
    } catch {
      // Keep free text entry available when the tag list cannot be loaded.
    }
  }
  input.addEventListener("input", renderSuggestions);
  $("tag-add").addEventListener("submit", event => {
    event.preventDefault();
    addTag();
  });
  function dismiss() {
    if (savingTags) return;
    const pending = input.value.trim();
    const changed = tagDraft.length !== originalTags.length || originalTags.some(tag => !tagDraft.includes(tag));
    const close = () => tagsDialog.close();
    if (changed || (pending && !tagDraft.includes(pending))) confirmTagDiscard(close);
    else close();
  }

  dismissDialogOnOutsideClick(tagsDialog, dismiss);
  $("tags-cancel").addEventListener("click", dismiss);
  tagsDialog.addEventListener("cancel", event => {
    event.preventDefault();
    dismiss();
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
