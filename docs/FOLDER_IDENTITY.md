# Registered folder identity and relocation

Human direction: support whole-folder relocation, later folder merging, and note links based on a folder-relative path. Physical folders may share a basename. Registration labels must be editable independently of the physical name.

## Implemented in the local trial

- A folder registration has `id`, `path`, and `label`. The same ID is stored in the folder's `.sticky-folder.json` (format/version/id only). Whole-folder manual moves carry this file along. Existing configurations receive IDs and initialize a marker without changing note files or labels; an existing differing or malformed marker is never overwritten. If marker creation fails (for example a read-only directory), its tracking limitation is exposed in the folder tooltip. A marker absent from a legacy directory does not block ordinary note use.
- Right-click a folder chip → “場所を探す…” and select the search root. Search reads folder ID markers only, at most 10,000 directories and 8 levels under that selected root; no background whole-drive search. Reparse directories, `.git`, and `node_modules` are skipped. Partial searches and skipped locations are reported.
- Search does not change registrations. Every match is shown with its full path, including copies sharing the same ID; none is preselected. Explicit “この場所につなぎ直す” changes the local mapping after rechecking the ID, without moving or deleting either candidate. Open source note windows must first be saved and closed. Parent links, saved stack order, native note state and per-note display preferences are retargeted. A second active registration of the same folder ID is rejected rather than silently aliasing the copies.
- Settings can edit a registration label without renaming the directory.
- Relocation selects a destination parent and keeps the physical basename. Never merge with or overwrite an existing destination. Preserve hidden files, attachments, Trash, and ordinary Git metadata as files.
- Save and close affected note windows first. Copy the complete tree into a new temporary directory in the destination parent; compare file content hashes, recheck the source, then install the destination and atomically persist registration/settings before deleting the unchanged originals. On configuration failure the original remains registered and a verified destination copy may remain; the UI reports its location. On original cleanup failure the UI reports that the destination is active and the old location still needs attention.
- Reject special/reparse files, moving a drive root, placing a folder into itself, and moving the app/configuration directory. A move-in-progress guard prevents opening or creating source notes while committing the relocation.
- Retarget all affected registrations and native note state, including parent links and saved stack order. Migrate known per-note display preferences in WebView storage before reopening notes. Preserve Windows file creation and modified timestamps.

The operation copies and verifies across any accessible destination parent, including another local drive. The synthetic tests exercise the same copy/verify/commit/delete path, but no real user folder or cross-drive user data was moved by the Agent.

## Next increments — not implemented yet

- Folder merge needs an explicit collision policy and a source-ID redirect/mapping so existing links do not silently change meaning. It must remain separate from non-overwriting relocation.
- Note links should resolve a relative path within a registered folder. Same-folder links can be ordinary relative Markdown links; cross-folder links should refer to a folder ID plus a relative path rather than an absolute drive path. Syntax remains to be chosen.
- Validate link traversal against the registered root. Internal note links must not grant arbitrary filesystem access or run arbitrary URI handlers.
- Folder IDs now travel with the folder. Cross-PC link syntax, ID redirects for merges, and assigning a fresh identity to an independent copy remain separate future work. Current marker discovery is not a cross-PC state sync feature.

Existing absolute links in Markdown and the internals of external Git worktrees or other applications are not rewritten by relocation. Relative attachment links within the moved tree continue to resolve.
