use super::*;

#[derive(Serialize)]
pub struct Entry {
    path: String,
    folder: String,
    title: String,
    revision: String,
    archived: bool,
}

fn checked_entry(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let trash = root.join(".trash");
    if trash.canonicalize().map_err(|e| e.to_string())? != trash {
        return Err("ゴミ箱が別の場所を参照しています".into());
    }
    let file = path.canonicalize().map_err(|e| e.to_string())?;
    if file != path || file.parent() != Some(trash.as_path()) || !file.is_file()
        || file.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("ゴミ箱の付箋ではありません".into());
    }
    Ok(file)
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let folders = state.cfg.lock().unwrap().folders.clone();
    let mut entries = Vec::new();
    for folder in folders {
        let Ok(root) = registered_dir(&state, &folder.path) else { continue };
        let trash = root.join(".trash");
        if !trash.exists() { continue; }
        for entry in fs::read_dir(&trash).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let Ok(path) = checked_entry(&root, &path) else { continue };
            let (text, revision) = read_snapshot(&path)?;
            let (front, body) = split_front(&text);
            let metadata = note_metadata(front);
            entries.push(Entry { path: path.to_string_lossy().into_owned(),
                folder: root.to_string_lossy().into_owned(),
                title: metadata.title.unwrap_or_else(|| title_of(body)), revision, archived: metadata.archived });
        }
    }
    entries.sort_by(|a,b| b.path.cmp(&a.path));
    Ok(entries)
}

fn change(root: &Path, path: &Path, revision: &str, delete: bool) -> Result<(), String> {
    let file = checked_entry(root, path)?;
    if read_snapshot(&file)?.1 != revision { return Err("付箋が変更されました。更新してやり直してください".into()); }
    if delete { return fs::remove_file(file).map_err(|e|e.to_string()); }
    let name = file.file_name().and_then(|n|n.to_str()).ok_or("ファイル名を読めません")?;
    // Keep the trash filename: collision-safe, and the original Markdown stays byte-identical.
    move_file_preserving_bytes(&file, &root.join(name), revision)?;
    Ok(())
}

#[tauri::command]
pub fn change_trash(state: State<'_, AppState>, folder: String, path: String, revision: String, delete: bool) -> Result<(), String> {
    let _writer = state.writes.lock().unwrap();
    let root = registered_dir(&state, &folder)?;
    change(&root, Path::new(&path), &revision, delete)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_and_delete_check_revision_and_boundary() {
        let root = env::temp_dir().join(format!("sticky-trash-{}",make_id(77)));
        fs::create_dir_all(root.join(".trash")).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join(".trash/test.md");
        let bytes = b"---\ntags: [test]\narchived: true\n---\n![image](attachments/a.png)";
        fs::write(&path,bytes).unwrap();
        let rev = revision_of(bytes);
        assert!(change(&root,&path,"stale",true).is_err());
        let outside = root.join("outside.md");
        fs::write(&outside,bytes).unwrap();
        assert!(change(&root,&outside,&rev,true).is_err());
        fs::write(root.join("test.md"),b"existing").unwrap();
        assert!(change(&root,&path,&rev,false).is_err());
        assert_eq!(fs::read(&path).unwrap(),bytes);
        fs::remove_file(root.join("test.md")).unwrap();
        change(&root,&path,&rev,false).unwrap();
        assert_eq!(fs::read(root.join("test.md")).unwrap(),bytes);
        fs::write(&path,bytes).unwrap();
        change(&root,&path,&rev,true).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
