import { countColumn } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { indentOf, isListLine } from "./block-model.js";

function buildGuides(view) {
  const { state } = view;
  const { doc } = state;
  const active = doc.lineAt(state.selection.main.head);
  const indent = indentOf(active.text);
  if (indent === 0) return Decoration.none;

  for (let node = syntaxTree(state).resolveInner(active.from + indent, 1); node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return Decoration.none;
  }

  // The nearest shallower nonblank row is the parent if it is a list item.
  let parent;
  for (let number = active.number - 1; number > 0; number--) {
    const line = doc.line(number);
    if (!line.text.trim() || indentOf(line.text) >= indent) continue;
    if (!isListLine(line.text)) return Decoration.none;
    parent = line;
    break;
  }
  if (!parent) return Decoration.none;

  const column = countColumn(parent.text.slice(0, indentOf(parent.text)), state.tabSize);
  const activeColumn = countColumn(active.text.slice(0, indent), state.tabSize);
  const guide = Decoration.line({
    attributes: { class: "cm-branch-guide", style: "--branch-column:" + column },
  });
  const end = Decoration.line({
    attributes: {
      class: "cm-branch-guide cm-branch-end",
      style: "--branch-column:" + column + ";--branch-width:" + (activeColumn - column),
    },
  });
  const ranges = [Decoration.line({ class: "cm-branch-parent" }).range(parent.from)];
  for (const { from, to } of view.visibleRanges) {
    const first = Math.max(parent.number + 1, doc.lineAt(from).number);
    const last = Math.min(active.number, doc.lineAt(to).number);
    for (let number = first; number <= last; number++) {
      ranges.push((number === active.number ? end : guide).range(doc.line(number).from));
    }
  }
  return Decoration.set(ranges, true);
}

export const branchGuide = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildGuides(view); }

  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildGuides(update.view);
    }
  }
}, {
  decorations: plugin => plugin.decorations,
});
