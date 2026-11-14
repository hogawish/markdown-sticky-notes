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

export function paintPaper(element, color, border = "thin") {
  const hex = paperHex(color);
  element.dataset.color = builtIn.has(color) ? color : hexPattern.test(color) ? "custom" : "yellow";
  element.dataset.border = paperBorder(border);
  element.style.setProperty("--paper", hex);
  const [r, g, b] = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  element.dataset.darkPaper = String(0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179);
}
