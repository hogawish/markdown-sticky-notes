# Changelog

## Unreleased

- Links: select text and right-click → "リンクを貼る…" to enter a URL (also `Ctrl+K` with a selection), or paste a URL over selected text to turn it into a link. Right-click a link to open it, edit its URL, remove the link or copy the URL. Rendered links show an external-link mark (↗) and their target on hover. Clicking still only places the cursor; `Ctrl+click` opens.
- Add an explicit Toggle block type, available from the block menu or `/toggle`. Only toggle blocks fold indented children. The type is saved in Markdown as `- [>] Title`, and the open/closed state is remembered on this PC.
- Move blocks by dragging the handle (⋮⋮): a list item moves with its children, a code fence moves as one block, and dropping to the right of a list item nests the block under it. A line shows where and at which depth it will land; Esc cancels. Numbered lists are renumbered. `Alt+↑/↓` moves the block among its siblings and `Tab` / `Shift+Tab` nests or un-nests a list item with its children.
- Add a block handle (⋮⋮) that appears to the left of the hovered line. Clicking it opens a menu to change the block type (text, heading 1–3, bullet, numbered, checkbox, toggle, quote, code). Only the line prefix is swapped; the body and indent are kept.
- Show the shortcuts and commands in their own window, opened from a note's ▾ menu ("⌨ ショートカット一覧"). It covers formatting shortcuts, `/` and `@` commands, editing keys and the note/list controls.
- Open the note list from a note's ▾ menu ("📋 付箋の一覧を開く"), so the tray icon is no longer the only way to reach it.
- Add a command line to control notes without stopping the running app. `app.exe open <path>` opens or moves a note (`--monitor N --anchor …` for monitor-relative placement, `--x/--y` and `--width/--height` for absolute placement, `--pin/--no-pin`, `--create`), and `app.exe close <path>` closes it after saving. A second launch hands its arguments to the running app; with no running app the launch itself runs them. `--result FILE.json` writes the outcome. Notes opened this way do not take focus unless `--focus` is given. See "Agentやスクリプトからの操作" in the README.
- Add a live preview to the editor: lines without the cursor hide the Markdown markers and render (headings, bold/italic/strikethrough, inline code, bullets, quotes, links, rules, colored text, fenced code), and only the line with the cursor shows its markers. `- [ ]` becomes a real checkbox that toggles `[ ]`/`[x]` on click. The saved text is never changed by the rendering. "Markdownの記号を常に表示" in the ▾ menu turns it off. Ctrl+click on a link label opens its URL.

## 0.3.0-alpha.14

- Open a registered folder in Explorer from the note list (📂 on each folder chip). Only registered folders can be opened.
- Open the folder of a note's file from the note itself (📂 場所 in the footer), with the file selected in Explorer.

## 0.3.0-alpha.13

- Edit tags directly from notes and from each row in the note list. Save tags in YAML frontmatter and refresh tag filters.
- Show tag names and the attached window title on notes. Toggle each display from the ▾ menu and remember the choices per note on this PC.
- Dismiss the display menu by clicking outside it. Use 🔗 for attaching windows and ▾ → tab-link settings for existing-tab navigation.

## 0.3.0-alpha.11

- Keep the attached application immediately below the clicked note, fixing the brief raise followed by a return to the old Z-order.

## 0.3.0-alpha.10 (local trial, unpublished)

- Raise an attached application when the note gains native window focus, including title-bar and first-activation clicks.
- Keep the existing pointer handler for clicks in an already focused note.
- Do not raise the old attachment while a window picker is active.

## 0.3.0-alpha.9 (local trial, unpublished)

- Resize note text with Ctrl+wheel; remember size per note on this PC and reset with Ctrl+0.
- Clicking an attached note raises its target application behind it without moving keyboard focus out of the note.
- Raise the pair only on an explicit note click, preserving normal background layering otherwise.

## 0.3.0-alpha.8 (local trial, unpublished)

- Highlight 🔗 only when a note is actually attached; show ◎ with a dashed outline while choosing a window.
- Click an attached note's 🔗 to arm detaching, then click again within three seconds to return it to the desktop; Escape or timeout cancels.
- Shift-click 🔗 to choose a different window; cancelling preserves the original attachment and says so.
- Recheck the saved attachment when clicking the button.

## 0.3.0-alpha.7 (local trial, unpublished)

- Highlight the link button only while picking a target window, clearing it after success, cancellation or error.
- Show the current attachment in the tooltip instead of a persistent active-button style.

## 0.3.0-alpha.6 (local trial, unpublished)

- Click the link button, then click the target application window to attach a note.
- Cancel selection with Escape; stop listening after 30 seconds.
- Keep the dropdown selector and tab settings behind a separate ▾ button.
- Use transient mouse-button/Escape state and WindowFromPoint; no cursor replacement or permanent input listener.

## 0.3.0-alpha.5

- Enable the pin toggle while attached to an application window.
- With pin off, keep notes immediately above the target in Z-order so other windows can cover both.
- With pin on, keep notes globally topmost, including at their last position while the target is minimized.
- Preserve non-activating geometry following and existing-tab navigation.

## 0.3.0-alpha.4

- Keep attached notes visible and topmost when another application receives focus.
- Only hide attached notes when the target window itself is minimized or hidden.
- Preserve no-focus-stealing window following and explicit existing-tab navigation.

## 0.3.0-alpha.3

- Save an independent reference to an existing Chrome or VS Code tab.
- Return to that tab with the note's ↗ button; do not switch note visibility when tabs change.
- Distinguish same-title Chrome tabs and the same VS Code file in separate editor groups.
- Report closed tabs or disconnected extensions without creating replacement tabs or changing note contents.
- Keep whole-window following independent of tab links.
- Include Chrome native-host registration/removal, VS Code VSIX, and setup instructions.
- Use native stdio and small per-user local state/request/receipt files; no network listener.

## 0.3.0-alpha.1

- Attach a note to a selected Windows application window using the link button.
- Follow the target's movement and resizing; hide on minimization or switching apps, and return without stealing focus.
- Retain editing/autosave while attached, allow detaching, and keep the note when the target closes.
- Store attachment settings locally, separate from Markdown. Whole-window only; Chrome/VS Code tab adapters are still pending.
- Check native window behavior with an isolated Win32 fixture.

## 0.2.0

- Filter notes by folder, frontmatter tags/status and normalized full-text search.
- Sort by modified time, creation time, title or folder in either direction.
- Keep notes without metadata visible as unorganized; remember local display choices.
- Archive and restore with `archived: true/false` without moving files or losing the original status.
- Move notes between registered folders without changing their bytes or overwriting same-named files.
- Save open drafts before archive/move requests and route actions to only the corresponding note window.
- Read YAML metadata using yaml-rust2 and update third-party notices.

## 0.1.0

- Initial public source release of the Windows Markdown sticky-note app.
- Preserve edits typed during save requests and external file reads.
- Keep note windows open when saving fails or conflicts.
- Save before moving notes to trash and before normal application exit.
- Use content revisions, serialized local writes and unique temporary files.
- Refuse silent replacement of invalid UTF-8 input.
- Add an original icon, MIT licensing and third-party notices.
