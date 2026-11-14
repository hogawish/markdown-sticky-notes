use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read, Write},
    path::Path,
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;
use zip::ZipArchive;

use super::{AppState, MAX_NOTE_BYTES, attachments, make_id, registered_dir};

fn stage(folder: &Path, bytes: &[u8]) -> io::Result<NamedTempFile> {
    let mut file = NamedTempFile::new_in(folder)?;
    file.write_all(bytes)?;
    Ok(file)
}

fn unpack(source: &Path, folder: &Path, writes: &std::sync::Mutex<()>) -> Result<usize, String> {
    let file = File::open(source).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    let mut images: BTreeMap<String, (String, NamedTempFile)> = BTreeMap::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        // Only the paths produced by this app are recognized. Nothing is extracted by its ZIP path.
        let name = entry.name().map_err(|error| error.to_string())?.into_owned();
        if entry.is_dir() { continue; }
        if !entry.is_file() || entry.enclosed_name().is_none() || name.contains(['\\', ':']) {
            return Err("ZIP内に取り込めないファイルがあります".into());
        }
        let (prefix, leaf) = name.rsplit_once('/').unwrap_or(("", name.as_str()));
        let is_group = |part: &str| part.strip_prefix("Notes-").is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
        });
        let is_note = (prefix.is_empty() || is_group(prefix)) && leaf.ends_with(".md");
        let is_image = (prefix == "attachments" || prefix.strip_suffix("/attachments").is_some_and(is_group))
            && leaf.strip_suffix(".png").is_some_and(|stem| {
                !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            });
        if !is_note && !is_image { return Err(format!("ZIP内の形式に対応していません（{name}）")); }
        let limit = if is_note { MAX_NOTE_BYTES } else { attachments::MAX_BYTES };
        let mut bytes = Vec::new();
        entry.take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() > limit { return Err(format!("ファイルが大きすぎます（{name}）")); }
        if is_note {
            std::str::from_utf8(&bytes).map_err(|_| format!("UTF-8の付箋を指定してください（{name}）"))?;
            notes.push(stage(folder, &bytes).map_err(|error| error.to_string())?);
        } else {
            if !attachments::png(&bytes) { return Err(format!("PNG画像を読み取れません（{name}）")); }
            let key = leaf.to_ascii_lowercase();
            if let Some((_, previous)) = images.get(&key) {
                if fs::read(previous.path()).map_err(|error| error.to_string())? != bytes {
                    return Err(format!("ZIP内に内容が異なる同名画像があります（{leaf}）"));
                }
            } else {
                images.insert(key, (leaf.to_owned(), stage(folder, &bytes).map_err(|error| error.to_string())?));
            }
        }
    }
    if notes.is_empty() { return Err("ZIPに付箋が入っていません".into()); }

    let _writer = writes.lock().unwrap();
    attachments::install_imported(folder, images.into_values())?;
    let mut installed = Vec::new();
    for (index, note) in notes.into_iter().enumerate() {
        let destination = folder.join(format!("{}.md", make_id(index as u32)));
        if let Err(error) = note.persist_noclobber(&destination) {
            for path in installed { let _ = fs::remove_file(path); }
            return Err(error.to_string());
        }
        installed.push(destination);
    }
    Ok(installed.len())
}

#[tauri::command]
pub(super) async fn import_notes(
    window: WebviewWindow,
    state: State<'_, AppState>,
    folder: String,
) -> Result<Option<usize>, String> {
    if window.label() != "list" { return Err("付箋の一覧から取り込んでください".into()); }
    registered_dir(&state, &folder)?;
    let source = window.dialog().file().set_parent(&window).add_filter("ZIP", &["zip"]).blocking_pick_file();
    let Some(source) = source else { return Ok(None); };
    let source = source.into_path().map_err(|error| error.to_string())?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let folder = registered_dir(&state, &folder)?;
        unpack(&source, &folder, &state.writes).map(Some)
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn imports_multiple_groups_without_overwriting_destination_notes() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().canonicalize().unwrap();
        let source = folder.join("fixture.zip");
        let existing = folder.join("original.md");
        fs::write(&existing, "existing note").unwrap();
        let markdown = "---\ntags: [新規タグ]\nstatus: review\n---\n本文\n![](attachments/Image.png)";
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let mut archive = ZipWriter::new(File::create(&source).unwrap());
        for group in ["Notes-1", "Notes-2"] {
            archive.start_file(format!("{group}/original.md"), SimpleFileOptions::default()).unwrap();
            archive.write_all(markdown.as_bytes()).unwrap();
            archive.start_file(format!("{group}/attachments/Image.png"), SimpleFileOptions::default()).unwrap();
            archive.write_all(png).unwrap();
        }
        archive.finish().unwrap();
        assert_eq!(unpack(&source, &folder, &Mutex::new(())).unwrap(), 2);
        assert_eq!(fs::read(&existing).unwrap(), b"existing note");
        assert_eq!(fs::read(folder.join("attachments/Image.png")).unwrap(), png);
        let imported = fs::read_dir(&folder).unwrap().flatten().filter(|entry| {
            let path = entry.path();
            path != existing && path.extension().is_some_and(|ext| ext == "md")
        }).collect::<Vec<_>>();
        assert_eq!(imported.len(), 2);
        for entry in imported {
            assert_eq!(fs::read(entry.path()).unwrap(), markdown.as_bytes());
        }
    }
}
