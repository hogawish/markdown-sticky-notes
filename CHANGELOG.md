# Changelog

## 0.13.2

- Copy a note’s Markdown ID and full local path from its context menu. Notes without an ID copy their path.

## 0.13.1

- Restore notes that remain below the minimum window size after display changes. Preserve the last usable dimensions and repair invalid sizes on startup.
- Restore the default note size from the right-click menu. Open it from more of the toolbar or footer, and from any visible part of an undersized note.

## 0.13.0

- Minimize individual notes to colored title chips at the bottom of their monitor. Restore one with a click.
- Select a note and its descendants in the context menu, minimize the selection, and restore all minimized notes on a monitor from its chip menu.
- Show note context menus in a vertical list and open menus, color controls, and dialogs in floating windows sized independently of the note.

## 0.12.3

- Convert a text selection spanning multiple blocks from the block handle menu. The entire change can be undone in one step.
- Ctrl-click local Windows paths to open folders in Explorer or select the linked file in its folder.
- Open new tab-linked notes on the source window's monitor from the first display, keeping the note within that monitor's work area.

## 0.12.2

- Organize Shift-click-selected notes from the note context menu. Click Bulk Archive twice to archive the selection, or hold it to reveal Move Selection to Trash. Each note saves pending edits before it is archived or moved.
- Keep Ctrl+Alt+P scoped to the selected note's family root and update the corresponding pin icon.

## 0.12.1

- Register the fixed Chrome Web Store extension ID automatically during per-user installation and updates, without a manual PowerShell step. Preserve explicitly registered development IDs for the same installation and leave foreign registrations untouched.
- Keep uninstall ownership checks and preserve Markdown notes and configuration data.
- Add Chrome extension 0.4.1 icons and a verified public key for the assigned store ID; provide a reproducible store-only ZIP packager, privacy policy and English reviewer setup instructions. Runtime extension permissions are unchanged.

## 0.12.0

- Show a transient reference label above the whole moving family when toggling placement mode or using movement shortcuts. Keep it visible while Ctrl+Alt is held, follow the group's bounds, avoid taking input focus or intercepting clicks, and hide it about 0.2 seconds after release.
- Keep a Ctrl-clicked note temporarily in front until Ctrl is released, without changing saved stack order; retain Ctrl+Shift drag.
- Add app-relative and monitor-relative placement. Toggle the reference with Ctrl+Alt+M; arrows move to an edge, Home centers, and Shift uses the last active external application or its monitor. App edges overlap by 24 physical pixels; monitor edges stay in the work area.
- Nudge whole note families by 10 physical pixels with Ctrl+Alt+I/J/K/L, or 1px with Shift. Toggle the family root pin with Ctrl+Alt+P.
- Hold Ctrl+Alt+Space to put the attached family behind its application temporarily; release to restore saved order and pin inheritance.
- Create a tab-linked, window-attached note from Chrome and VS Code tab context menus. Preserve the link when reparenting. Save in the last selected registered folder, confirm the source window before creation, and do not retry timed-out requests automatically.
- Chrome/VS Code extensions 0.4.0 add creation commands; no page bodies, VS Code file URIs, broad browsing permissions or network listener are introduced. Chrome adds the contextMenus permission.

## 0.11.0

- Give registered folders portable IDs in `.sticky-folder.json`, separate editable labels, and a right-click menu for relocation, merge, and finding a manually moved folder within a selected scope. Show duplicate-ID candidates for explicit selection.
- Move a complete registered folder by copying, verifying hashes, persisting the new registration and preserving relative images, note family state and display preferences before removing unchanged originals.
- Merge registered folders with a preview: share identical files and stop on differing same-name contents. Copy new files without replacing target files, verify the result, preserve source Git metadata in an original-folder backup, and report its location. Save and close affected notes first; retain originals on failure.
- Keep old folder IDs as portable aliases after merging. Copy a note link from the note menu or list context menu, paste it into another note, and Ctrl+click to open. Support same-folder `.md` links and folder-ID-relative links across registrations, merges and whole-folder relocation. No Windows URI handler or external file access is added.
- Preserve target layout for shared notes while migrating incoming parent/order references; prevent self/cycles caused by shared notes. Report unresolved links in list previews.
- Keep the folder-operation gate out of Windows/WebView creation calls to avoid a wait cycle during rapid bulk opening. Track pending opens separately so folder changes still wait for them.

## 0.10.0

- Move a note from its body or toolbar with Ctrl+Shift+drag. Preserve Ctrl-click links, Shift-click selection and the usual title-grip drag. This replaces the unpublished long-press movement experiment.
- Choose top, bottom, left or right toolbars per note. Keep horizontal toolbars to one row; side toolbars show the full title on the edit icon's tooltip and open a floating title editor without reducing the body area.
- Set individual block backgrounds from the block handle menu. Store colors with the Markdown, retain them when moving blocks, and show them in list previews. Code fences keep their existing presentation.
- Add explicit toggle heading blocks at levels 1, 2 and 3. Fold indented children, preserve nesting and direct-child counts, and restore fold state when reopening. Ordinary headings remain ordinary headings.
- Support Ctrl+Shift+Z for redo alongside Ctrl+Y.
- Temporarily bring a note to the front of its family while its menus or controls are open; restore the saved order afterward, and clear transient state when the note closes.
- Stop standalone note families from inheriting their own stale native topmost state. Reconcile the actual Windows topmost flag when changing the pin from the UI or CLI. This addresses the latch reported in issue #10; the company's original trigger and its verification of this build remain pending.

## 0.9.1

- Expand the note right-click menu area to include the title and its edit icon. Preserve left-click title editing and ordinary context menus in text inputs.

## 0.9.0

- Attach one sticky note to another using the same link-button-and-click gesture as window attachment. Build parent/child/grandchild chains, move a subtree together, or adjust a child independently of its ancestors.
- Keep child notes above their parent and its attached application by default. Inherit the parent's topmost layer, follow minimization, and include parent links in bulk unlink.
- Right-click a note's title bar to drag its family into a custom front-to-back order in a small separate window. Save order locally without changing movement parentage or note positions; reset to children-in-front defaults at any time.
- Click any member of a note family to bring the complete visible family forward while retaining its saved order, including standalone families behind another application.
- Keep children and grandchildren moving with an attached application even when the custom layer order places their parent in front; avoid replaying the movement twice through native window events.
- Temporarily bring the held note to the front of its family while the mouse button is pressed; restore the saved order on release without changing it on disk.
- Select multiple rows in the layer editor to remove just those notes from the family. Keep unselected descendants grouped, and preserve note positions and Markdown contents.
- Merge selected notes from the list or Shift-click selection and the note context menu. Choose the title, destination, and order; preserve source notes in Archive, combine tags, and copy referenced PNGs without filename collisions.
- Reduce activation and drag-end flicker using Windows foreground/move-end notifications, avoid redundant window placement, and skip raising an application through its own note family. Occasional Windows stacking flicker and competing notes from separate app processes can still occur.

## 0.8.4

- Open official Claude local-session links (`claude://claude.ai/epitaxy/local_<UUID>`) while preserving the existing Codex, Claude chat, and Slack link restrictions.
- After a user clicks a Claude link, try once to bring its single identifiable window to the foreground. Skip activation for ambiguous windows or if focus has already moved elsewhere.

## 0.8.3

- Render Markdown formatting and attached images in list body previews.
- Hold a note's Archive button to move directly to Trash.
- Manage Trash from Settings: search, select multiple notes, restore, and permanently delete after confirmation. Restores preserve contents and archive state; attachments remain for separate cleanup.

## 0.8.2

- Expand and copy a note's body directly from the note list.

## 0.8.1

- Duplicate a sticky note from its menu. The app saves the current edits and opens an editable copy in the same folder with its own identity.

## 0.8.0

- Export selected notes as a ZIP with Markdown, tags, and referenced PNGs. Import shared ZIPs into a registered folder from Settings.
- Edit and filter Status from the list. Pick a default, search existing options, or add a new value.
- Customize tag and Status chip colors. Waiting for review defaults to yellow.
- Close selected notes using the regular save-and-close flow. Click outside Settings to dismiss it.

## 0.7.0

- Search existing tags as you type, select suggestions as removable chips, or create a new tag from the same picker.
- Add tags to selected notes in bulk from the list. Rename, merge, or delete a tag across registered notes, including archived notes, after reviewing the affected count.
- Open all selected notes from the list with one action.

## 0.6.0

- Select notes with Shift-click to drag them together or arrange them using a preview, direction, and stacking order.
- Give notes custom paper and border colors and save reusable styles. Show note colors and link destinations in the list, and clear links in bulk.
- Bring an attached note to the front from the list and let its target window minimize normally.
- Link to an existing File Explorer tab. Return to a detached Chrome tab and move an attached note to its destination window, retrying the window lookup when needed. Update the Chrome extension to 0.3.2 for the new destination lookup.
- Open supported Codex, Claude, and Slack links with Ctrl-click. Confirm archiving with a second click.
- Keep note text visible in small windows and support Ctrl+wheel text sizing on attached notes.

## 0.5.0

- Paste screenshots into a note, view them in a separate window, and clean up unused attachments from Settings.
- Link to an existing Chrome or VS Code tab from the link button. Chrome links follow tabs detached into another window.
- Preserve the order of notes attached to one window, with the last clicked note in front of its group.

## 0.4.0

- Restore recently unregistered note folders from Settings. Folder removal requires a second click.
- Switch between Notes and Archive views, select individual notes or all visible results, and archive or restore them in bulk.
- Move archived notes to the local `.trash` folder individually or in bulk after confirmation.

## 0.3.1

- Offer a way to leave the editor open or explicitly close without saving when a save fails.
- Preserve BOM and CRLF on edits, keep Markdown rules at the start of the body, and bound note and YAML metadata parsing.
- Queue positioning on the attached Windows app's thread so a slow window does not block the sticky note.
- Remove this installation's Chrome Native Messaging registry entry on uninstall.
- Add Windows CI and regression coverage for save recovery, Markdown file handling and registered-folder access.

## 0.3.0

- Click the small pencil beside the drag handle to edit the title in place. Drag the title area to move the note. Press Enter to save or Esc to cancel. The title is stored separately in Markdown frontmatter and shown in the note and list.

## 0.3.0-alpha.18

- Guide the active nested row back to its parent with a subtle line and parent highlight. Update the guide as the caret moves or the row is indented.

- Count only immediate children in collapsed toggle badges, excluding blank lines.

- Align nested toggle arrows with their indentation. Place the caret after the toggle marker when creating a toggle.

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
