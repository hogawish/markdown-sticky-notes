use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::{Seek, Write},
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use zip::{ZipWriter, write::SimpleFileOptions};

use super::{AppState, attachments, checked, read_snapshot};

fn write_zip(output: impl Write + Seek, paths: BTreeSet<PathBuf>) -> Result<(), String> {
    let mut folders: BTreeMap<&Path, Vec<&Path>> = BTreeMap::new();
    for path in &paths {
        folders.entry(path.parent().ok_or("付箋フォルダがありません")?).or_default().push(path);
    }
    let multiple_folders = folders.len() > 1;
    let mut zip = ZipWriter::new(output);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, SimpleFileOptions::default())
            .map_err(|error| error.to_string())?;
        zip.write_all(bytes).map_err(|error| error.to_string())
    };
    for (index, notes) in folders.into_values().enumerate() {
        let prefix = if multiple_folders { format!("Notes-{}/", index + 1) } else { String::new() };
        let mut images = HashSet::new();
        for path in notes {
            let (markdown, _) = read_snapshot(path)?;
            let name = path.file_name().and_then(|name| name.to_str()).ok_or("付箋のファイル名を読み取れません")?;
            add(&format!("{prefix}{name}"), markdown.as_bytes())?;
            attachments::for_each_linked(path, &markdown, |name, bytes| {
                if images.insert(name.to_owned()) {
                    add(&format!("{prefix}attachments/{name}"), bytes)?;
                }
                Ok(())
            })?;
        }
    }
    zip.finish().map(|_| ()).map_err(|error| error.to_string())
}

fn save_zip(destination: &Path, paths: BTreeSet<PathBuf>) -> Result<(), String> {
    if !destination.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
        return Err("保存先の拡張子は .zip にしてください".into());
    }
    let folder = destination.parent().ok_or("保存先のフォルダがありません")?;
    let mut file = tempfile::NamedTempFile::new_in(folder).map_err(|error| error.to_string())?;
    write_zip(file.as_file_mut(), paths)?;
    file.as_file().sync_all().map_err(|error| error.to_string())?;
    file.persist(destination).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(super) async fn export_notes(
    window: WebviewWindow,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Option<usize>, String> {
    if window.label() != "list" {
        return Err("付箋の一覧から書き出してください".into());
    }
    let paths = paths.iter().map(|path| checked(&state, path)).collect::<Result<BTreeSet<_>, _>>()?;
    if paths.is_empty() { return Ok(None); }
    let destination = window.dialog().file().set_parent(&window)
        .set_file_name("sticky-notes.zip").add_filter("ZIP", &["zip"]).blocking_save_file();
    let Some(destination) = destination else { return Ok(None); };
    let destination = destination.into_path().map_err(|error| error.to_string())?;
    let count = paths.len();
    tauri::async_runtime::spawn_blocking(move || save_zip(&destination, paths))
        .await.map_err(|error| error.to_string())??;
    Ok(Some(count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read};
    use zip::ZipArchive;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    fn make_note(folder: &Path, name: &str, markdown: &str) -> PathBuf {
        fs::create_dir_all(folder).unwrap();
        let path = folder.join(name);
        fs::write(&path, markdown).unwrap();
        path
    }

    #[test]
    fn exports_notes_and_their_images_with_relative_paths() {
        let work = tempfile::tempdir().unwrap();
        let folder = work.path().canonicalize().unwrap();
        let content = "\u{feff}---\r\ntags: [確認, review]\r\n---\r\n本文\r\n![](attachments/linked.png)\r\n";
        let first = make_note(&folder, "付箋.md", content);
        let second = make_note(&folder, "other.md", content);
        let pictures = folder.join("attachments");
        fs::create_dir(&pictures).unwrap();
        fs::write(pictures.join("linked.png"), PNG).unwrap();
        fs::write(pictures.join("unrelated.png"), PNG).unwrap();
        make_note(&folder, "unselected.md", "third note");
        let output = folder.join("notes.zip");
        save_zip(&output, [first, second].into()).unwrap();

        let mut archive = ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        let mut markdown = String::new();
        archive.by_name("付箋.md").unwrap().read_to_string(&mut markdown).unwrap();
        assert_eq!(markdown, content);
        let mut image = Vec::new();
        archive.by_name("attachments/linked.png").unwrap().read_to_end(&mut image).unwrap();
        assert_eq!(image, PNG);
    }

    #[test]
    fn separates_identical_names_from_different_folders() {
        let work = tempfile::tempdir().unwrap();
        let first = make_note(&work.path().join("a"), "note.md", "first");
        let second = make_note(&work.path().join("b"), "note.md", "second");
        let output = work.path().join("notes.zip");
        save_zip(&output, [first, second].into()).unwrap();
        let archive = ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
        let names: BTreeSet<_> = archive.file_names().map(|name| name.unwrap().into_owned()).collect();
        assert_eq!(names, ["Notes-1/note.md".to_owned(), "Notes-2/note.md".to_owned()].into());
    }

    #[test]
    fn missing_image_does_not_replace_existing_zip() {
        let work = tempfile::tempdir().unwrap();
        let note = make_note(work.path(), "note.md", "![](attachments/gone.png)");
        let output = work.path().join("existing.zip");
        fs::write(&output, b"previous archive").unwrap();
        assert!(save_zip(&output, [note].into()).is_err());
        assert_eq!(fs::read(output).unwrap(), b"previous archive");
    }
}
