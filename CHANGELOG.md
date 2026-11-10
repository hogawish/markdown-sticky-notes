# Changelog

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
