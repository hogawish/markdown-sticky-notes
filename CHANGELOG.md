# Changelog

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
