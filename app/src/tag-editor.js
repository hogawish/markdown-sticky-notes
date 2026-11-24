import { chipColor, paintChip, readChipColors, saveChipColors, updateChipColor } from "./chip-colors.js";

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

export function confirmTagDiscard(dismiss, confirmation = document.getElementById("discard-tags-dialog")) {
  if (confirmation.open) return;
  confirmation.returnValue = "";
  confirmation.addEventListener("close", () => {
    if (confirmation.returnValue === "discard") dismiss();
  }, {once: true});
  confirmation.showModal();
}

export function tagKey(tag) {
  return tag.normalize("NFKC").toLowerCase();
}

export function tagChip(tag, color) {
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.dataset.tone = String(1 + [...tag].reduce((sum, character) => sum + character.codePointAt(0), 0) % 4);
  chip.textContent = tag;
  if (color) paintChip(chip, color);
  return chip;
}

export function bindTagEditor(getSuggestions = () => [], onColorsSaved = () => {}, $ = id => document.getElementById(id)) {
  const tagsDialog = $("tags-dialog");
  const input = $("tag-input");
  const suggestionList = $("tag-suggestion-list");
  let saveTags;
  let tagDraft = [];
  let originalTags = [];
  let savingTags = false;
  let suggestions = [];
  let suggestionRequest = 0;
  let firstChoice = "";
  let colors = new Map();
  const colorChanges = new Map();
  let colorTag = "";
  const colorInput = $("tag-color");
  const resetColor = $("reset-tag-color");

  function chipFor(tag) {
    return tagChip(tag, chipColor(tagKey(tag), colors, colorChanges));
  }

  function renderTagColor() {
    $("tag-color-editor").hidden = !colorTag;
    if (!colorTag) return;
    const chip = chipFor(colorTag);
    $("tag-color-preview").replaceChildren(chip);
    const custom = chipColor(tagKey(colorTag), colors, colorChanges);
    colorInput.value = custom || getComputedStyle(chip).getPropertyValue("--tag-bg").trim();
    resetColor.hidden = !custom;
  }

  function editTagColor(tag) {
    colorTag = tag;
    renderTagColor();
  }

  colorInput.addEventListener("input", () => {
    updateChipColor(colorChanges, colors, tagKey(colorTag), colorInput.value);
    renderTags();
    renderTagColor();
  });
  resetColor.addEventListener("click", () => {
    updateChipColor(colorChanges, colors, tagKey(colorTag), null);
    renderTags();
    renderTagColor();
    colorInput.focus();
  });

  function renderTags() {
    const list = $("tag-list");
    list.replaceChildren();
    for (const tag of tagDraft) {
      const row = document.createElement("li");
      const name = document.createElement("button");
      name.type = "button";
      name.className = "edit-tag-color";
      name.setAttribute("aria-label", `タグ「${tag}」の色を編集`);
      name.title = "タグの色を編集";
      name.append(chipFor(tag));
      name.addEventListener("click", () => editTagColor(tag));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `タグ「${tag}」を削除`);
      remove.addEventListener("click", () => {
        tagDraft = tagDraft.filter(value => value !== tag);
        renderTags();
        $("tag-input").focus();
      });
      row.append(name, remove);
      list.append(row);
    }
    renderSuggestions();
  }

  function renderSuggestions() {
    const typed = input.value.trim();
    const query = tagKey(typed);
    const selected = new Set(tagDraft.map(tagKey));
    const exactMatch = suggestions.find(tag => tagKey(tag) === query);
    const canCreate = typed && !exactMatch && !selected.has(query);
    const matches = suggestions.filter(tag => !selected.has(tagKey(tag)) && tagKey(tag).includes(query));
    firstChoice = matches.includes(exactMatch) ? exactMatch : (matches[0] || (canCreate ? typed : ""));
    $("tag-suggestions").hidden = !matches.length && !canCreate;
    const rows = matches.map(tag => suggestionRow(tag));
    if (canCreate) rows.push(suggestionRow(typed, true));
    suggestionList.replaceChildren(...rows);
    suggestionList.scrollTop = 0;
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
    button.append(chipFor(tag));
    button.addEventListener("click", () => {
      addTag(tag);
      input.focus();
    });
    if (!create) button.addEventListener("contextmenu", event => {
      event.preventDefault();
      editTagColor(tag);
    });
    row.append(button);
    return row;
  }

  function addTag(tag) {
    if (tag && !tagDraft.some(value => tagKey(value) === tagKey(tag))) tagDraft.push(tag);
    input.value = "";
    renderTags();
  }

  function open(tags, onSave, {title = "タグ"} = {}) {
    if (tagsDialog.open) return;
    $("tags-title").textContent = title;
    originalTags = [...tags];
    tagDraft = [...tags];
    colors = readChipColors("tag");
    colorChanges.clear();
    colorTag = "";
    renderTagColor();
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
  input.addEventListener("compositionend", renderSuggestions);
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (input.value.trim() && firstChoice) addTag(firstChoice);
  });
  $("tag-add").addEventListener("submit", event => {
    event.preventDefault();
    if (input.value.trim() && firstChoice) addTag(firstChoice);
  });
  function dismiss() {
    if (savingTags) return;
    const changed = tagsChanged() || colorChanges.size;
    const close = () => tagsDialog.close();
    if (changed) confirmTagDiscard(close, $("discard-tags-dialog"));
    else close();
  }

  function tagsChanged() {
    return tagDraft.length !== originalTags.length || originalTags.some(tag => !tagDraft.includes(tag));
  }

  dismissDialogOnOutsideClick(tagsDialog, dismiss);
  $("tags-cancel").addEventListener("click", dismiss);
  tagsDialog.addEventListener("cancel", event => {
    event.preventDefault();
    dismiss();
  });
  $("tags-save").addEventListener("click", async () => {
    if (savingTags) return;
    savingTags = true;
    const controls = [...tagsDialog.querySelectorAll("button, input")];
    controls.forEach(control => control.disabled = true);
    $("tag-error").hidden = true;
    try {
      if (tagsChanged()) {
        await saveTags(tagDraft);
        originalTags = [...tagDraft];
      }
      saveChipColors("tag", colorChanges);
      if (colorChanges.size) onColorsSaved();
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
