import { isDarkColor } from "./appearance.js";

export const chipColorKey = kind => `sticky.${kind}-colors`;

export function readChipColors(kind) {
  try {
    const entries = JSON.parse(localStorage.getItem(chipColorKey(kind)) || "[]");
    if (Array.isArray(entries)) {
      return new Map(entries.filter(entry => Array.isArray(entry)
        && typeof entry[0] === "string" && /^#[0-9a-f]{6}$/i.test(entry[1])));
    }
  } catch {}
  return new Map();
}

export function saveChipColors(kind, changes) {
  if (!changes.size) return;
  const colors = readChipColors(kind);
  for (const [value, color] of changes) {
    if (color) colors.set(value, color);
    else colors.delete(value);
  }
  localStorage.setItem(chipColorKey(kind), JSON.stringify([...colors]));
}

export function chipColor(value, colors, changes) {
  return changes?.has(value) ? changes.get(value) : colors.get(value);
}

export function updateChipColor(changes, colors, value, color) {
  if (color === (colors.get(value) ?? null)) changes.delete(value);
  else changes.set(value, color);
}

export function paintChip(element, color) {
  if (color) {
    element.style.setProperty("--chip-custom-bg", color);
    element.style.setProperty("--chip-custom-fg", isDarkColor(color) ? "#ffffff" : "#000000");
  } else {
    element.style.removeProperty("--chip-custom-bg");
    element.style.removeProperty("--chip-custom-fg");
  }
}
