# Registered folder identity and relocation

Human direction: support whole-folder relocation, later folder merging, and note links based on a folder-relative path. Physical folders may share a basename. Registration labels must be editable independently of the physical name.

## Folder identity and relocation

- A folder registration has `id`, `path`, and `label`. The same ID is stored in the folder's `.sticky-folder.json` (format/version/id and optional merged-ID aliases). Whole-folder manual moves carry this file along. Existing configurations receive IDs and initialize a marker without changing note files or labels; an existing differing or malformed marker is never overwritten. If marker creation fails (for example a read-only directory), its tracking limitation is exposed in the folder tooltip. A marker absent from a legacy directory does not block ordinary note use.
- Right-click a folder chip → “場所を探す…” and select the search root. Search reads folder ID markers only, at most 10,000 directories and 8 levels under that selected root; no background whole-drive search. Reparse directories, `.git`, and `node_modules` are skipped. Partial searches and skipped locations are reported.
- Search does not change registrations. Every match is shown with its full path, including copies sharing the same ID; none is preselected. Explicit “この場所につなぎ直す” changes the local mapping after rechecking the ID, without moving or deleting either candidate. Open source note windows must first be saved and closed. Parent links, saved stack order, native note state and per-note display preferences are retargeted. A second active registration of the same folder ID is rejected rather than silently aliasing the copies.
- Settings can edit a registration label without renaming the directory.
- Relocation selects a destination parent and keeps the physical basename. Never merge with or overwrite an existing destination. Preserve hidden files, attachments, Trash, and ordinary Git metadata as files.
- Save and close affected note windows first. Copy the complete tree into a new temporary directory in the destination parent; compare file content hashes, recheck the source, then install the destination and atomically persist registration/settings before deleting the unchanged originals. On configuration failure the original remains registered and a verified destination copy may remain; the UI reports its location. On original cleanup failure the UI reports that the destination is active and the old location still needs attention.
- Reject special/reparse files, moving a drive root, placing a folder into itself, and moving the app/configuration directory. A move-in-progress guard prevents opening or creating source notes while committing the relocation.
- Retarget all affected registrations and native note state, including parent links and saved stack order. Migrate known per-note display preferences in WebView storage before reopening notes. Preserve Windows file creation and modified timestamps.

The operation copies and verifies across any accessible destination parent, including another local drive. The synthetic tests exercise the same copy/verify/commit/delete path, but no real user folder or cross-drive user data was moved by the Agent.

## Folder merge

Right-click a registered folder → “別の登録フォルダへマージ…”. Choose another registered folder and preview additions/shared files/conflicts before execution. Same-name same-byte files are shared; differing contents or file/directory collisions stop the operation. Filenames and Markdown bytes stay unchanged, so ordinary relative links between source notes and their attachments remain valid.

Save/close notes in both roots, recheck the preview token, and guard both roots against writes/opens. Copy each new file to a temporary file in its destination directory, sync/hash it, and publish without overwriting existing files. Verify every included source entry in the final destination snapshot, plus the unchanged source and existing destination files.

The destination keeps its primary ID and label. Its marker gains the source primary ID and earlier aliases. Remove the source registration and retarget native note paths/references. Existing target layout wins for shared notes, but parent/order references are still migrated. Break self/cycles introduced by collapsed notes. Known per-note WebView preferences migrate before reopening.

Source `.git` metadata is not merged into a different repository; it stays with the original source backup. Trash, attachments and other ordinary files keep relative names, subject to the collision policy. After marker/config persistence, rename the unchanged original source to a uniquely named `sticky-merge-backup-*` sibling and report the full path. If it changed or cannot be renamed, leave it in place and report that location. This preserves source data; it is not a one-click rollback of local configuration.

On copy/config failure the source and original registration remain. Complete published copies may remain at the target and can be shared on retry; partial copies are not published under final filenames. Config-save failure attempts to restore the unchanged old destination marker. An abrupt process/OS stop can leave complete copies or aliases before registration commit; rerun the same merge after resolving any actual content conflicts. Backups are not automatically deleted.

## Links between notes

From a note's ▾ menu, use “この付箋へのリンクをコピー”; from the list, right-click a note row to copy its link. Paste the Markdown into another note and Ctrl+click to open the destination.

Copied syntax: `[title](sticky-note://<percent-encoded-folder-id>/<percent-encoded-file.md>)`. The path is relative to the identified folder and embeds neither a drive path nor a registration label. Old source IDs resolve through the destination's portable aliases after merging and survive later whole-folder relocation/reconnection.

Ordinary same-folder `[title](other.md)` / `[title](./other%20note.md)` links work too. The existing flat note model supports direct-child `.md` files. Absolute paths, traversal, unregistered roots and arbitrary URI handlers are rejected. Preview links use that note as source and surface failures in the list.

`sticky-note://` resolves inside this app; no Windows URI handler is installed. Individual file renames/moves and ZIP import renaming do not yet rewrite incoming links. Markers do not synchronize PC-local window layouts or automatically register folders on another PC. Existing absolute links and external Git worktree internals are not rewritten.
