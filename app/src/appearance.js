export const COLORS = [
  ["yellow", "#fff3a3"], ["pink", "#ffd1dc"], ["blue", "#cfe8ff"], ["green", "#d4f5c4"],
  ["purple", "#e3d4ff"], ["orange", "#ffd9a8"], ["white", "#ffffff"], ["gray", "#e6e6e6"],
];
const builtIn = new Map(COLORS);
const hexPattern = /^#[0-9a-f]{6}$/i;

export function paperHex(color) {
  return builtIn.get(color) || (hexPattern.test(color) ? color : builtIn.get("yellow"));
}

export function paperBorder(border) {
  return ["none", "stripe"].includes(border) ? border : "thin";
}

export function frameColor(color) {
  return typeof color === "string" && hexPattern.test(color) ? color : "auto";
}

export function paintPaper(element, color, border = "thin", borderColor = "auto") {
  const hex = paperHex(color);
  element.dataset.color = builtIn.has(color) ? color : hexPattern.test(color) ? "custom" : "yellow";
  element.dataset.border = paperBorder(border);
  element.style.setProperty("--paper", hex);
  element.style.setProperty("--frame-color", frameColor(borderColor) === "auto" ? "" : borderColor);
  const [r, g, b] = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  element.dataset.darkPaper = String(0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179);
}

const presetKey = "sticky.appearance-presets";

export function readAppearancePresets() {
  try {
    const entries = JSON.parse(localStorage.getItem(presetKey) || "[]");
    if (Array.isArray(entries)) return entries.filter(entry =>
      typeof entry?.name === "string" && typeof entry.color === "string");
  } catch {}
  return [];
}

export function writeAppearancePresets(presets) {
  localStorage.setItem(presetKey, JSON.stringify(presets));
}

export function renderStyleManager(container, onChange = () => {}) {
  container.replaceChildren();
  const original = readAppearancePresets();
  if (!original.length) {
    container.textContent = "保存したスタイルはありません。";
    return;
  }
  const field = (type, value, label) => {
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.setAttribute("aria-label", label);
    return input;
  };
  const form = document.createElement("form");
  const rows = original.map(preset => {
    const row = document.createElement("div");
    row.className = "style-row";
    const remove = field("checkbox", "", `${preset.name}を削除対象にする`);
    const name = field("text", preset.name, "スタイル名");
    name.maxLength = 40;
    const color = field("color", paperHex(preset.color), "付箋の色");
    const border = document.createElement("select");
    border.setAttribute("aria-label", "枠");
    for (const [value, label] of [["thin", "細枠"], ["none", "枠なし"], ["stripe", "左帯"]]) {
      border.add(new Option(label, value));
    }
    border.value = paperBorder(preset.border);
    const frame = field("color", frameColor(preset.borderColor) === "auto" ? "#555555" : preset.borderColor, "枠色");
    const auto = field("checkbox", "", "枠色は自動");
    auto.checked = frameColor(preset.borderColor) === "auto";
    const label = document.createElement("label");
    label.append(auto, "自動");
    const update = () => { frame.disabled = auto.checked; };
    auto.addEventListener("change", update);
    update();
    row.append(remove, name, color, border, frame, label);
    form.append(row);
    return { remove, name, color, border, frame, auto };
  });
  const actions = document.createElement("div");
  actions.className = "appearance-controls";
  const save = document.createElement("button");
  save.textContent = "変更を保存";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "選んだものを削除";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  actions.append(save, remove, status);
  form.append(actions);
  container.append(form);

  const persist = presets => {
    if (JSON.stringify(readAppearancePresets()) !== JSON.stringify(original)) {
      status.textContent = "他の窓で変更されました。開き直してください。";
      return;
    }
    try {
      writeAppearancePresets(presets);
      renderStyleManager(container, onChange);
      onChange();
    } catch {
      status.textContent = "スタイルを保存できませんでした。";
    }
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    const presets = rows.map(row => ({
      name: row.name.value.trim(),
      color: row.color.value,
      border: row.border.value,
      borderColor: row.auto.checked ? "auto" : row.frame.value,
    }));
    const names = new Set(presets.map(preset => preset.name));
    if (names.has("") || names.size !== presets.length) {
      status.textContent = "空欄や重複のない名前を付けてください。";
      return;
    }
    persist(presets);
  });
  let pendingRemoval = "";
  let removalTimer;
  const resetRemoval = () => {
    clearTimeout(removalTimer);
    pendingRemoval = "";
    remove.textContent = "選んだものを削除";
    remove.disabled = !rows.some(row => row.remove.checked);
  };
  rows.forEach(row => row.remove.addEventListener("change", resetRemoval));
  resetRemoval();
  remove.addEventListener("click", () => {
    const selected = JSON.stringify(rows.map(row => row.remove.checked));
    if (selected !== pendingRemoval) {
      pendingRemoval = selected;
      remove.textContent = "もう一度押すと削除";
      removalTimer = setTimeout(resetRemoval, 3000);
      return;
    }
    resetRemoval();
    persist(original.filter((_, index) => !rows[index].remove.checked));
  });
}
