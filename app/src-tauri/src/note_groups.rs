use super::*;

#[derive(Deserialize)]
pub(super) struct Entry { path: String, revision: String }

pub(super) fn info(front: &str) -> (String, String) {
    let Ok(doc) = parse_frontmatter(front) else { return Default::default() };
    (doc["sticky_group"].as_str().unwrap_or("").into(), doc["sticky_group_title"].as_str().unwrap_or("").into())
}

fn grouped(text: &str, id: &str, title: &str) -> Result<String, String> {
    let mut result = text.to_owned();
    for (key, value) in [("sticky_group", id), ("sticky_group_title", title)] {
        let value = (!value.is_empty()).then_some(value);
        result = metadata_text(&result, key, &serde_json::to_string(&value).map_err(|e|e.to_string())?,
            value.map_or(yaml_rust2::Yaml::Null, |v|yaml_rust2::Yaml::String(v.into())))?;
    }
    Ok(result)
}

// Preflight all revisions. If a write fails, restore only our still-unchanged writes.
fn commit_changes(changes: &[(PathBuf, String, String)]) -> Result<(), String> {
    for (file, before, _) in changes { if read_snapshot(file)?.0 != *before { return Err("conflict".into()); } }
    for (index, (file, before, after)) in changes.iter().enumerate() {
        let result = (|| { if read_snapshot(file)?.0 != *before { return Err("conflict".into()); } write_note_text(file, after) })();
        if let Err(error) = result {
            for (file, before, after) in changes[..index].iter().rev() {
                if read_snapshot(file).ok().is_some_and(|v|v.0 == *after) { let _ = write_note_text(file, before); }
            }
            return Err(format!("処理を完了できませんでした。元の付箋を確認してください: {error}"));
        }
    }
    Ok(())
}

fn merge_text(title: &str, sections: &[(String, String)], tags: &[String], id: &str) -> Result<String, String> {
    let created = chrono::Local::now().to_rfc3339();
    let mut text = format!("---\nid: {}\ncreated: {}\ntitle: {}\ntags: {}\narchived: false\n---\n",
        serde_json::to_string(id).unwrap(), serde_json::to_string(&created).unwrap(),
        serde_json::to_string(title).unwrap(), serde_json::to_string(tags).unwrap());
    for (heading, body) in sections {
        text.push_str(&format!("\n## {}\n\n{}\n", heading.replace(['\r','\n'], " "), body.trim_end()));
    }
    if text.len() > MAX_NOTE_BYTES { return Err("まとめた本文が4 MiBを超えます。元の付箋は変更していません".into()); }
    Ok(text)
}

#[tauri::command]
pub(super) fn organize_notes(window: WebviewWindow, state: State<'_, AppState>, entries: Vec<Entry>, action: String, title: String, folder: Option<String>) -> Result<Option<String>, String> {
    if !["list","merge-notes"].contains(&window.label()) { return Err("付箋の一覧から操作してください".into()); }
    if window.label()=="merge-notes" {
        let allowed=state.note_tools.lock().unwrap().merge_paths.clone();
        if action!="merge" || entries.len()!=allowed.len() || entries.iter().any(|e|!allowed.contains(&e.path)){return Err("選択した付箋だけをまとめられます".into());}
    }
    if !["group","ungroup","merge"].contains(&action.as_str()) { return Err("操作が不正です".into()); }
    if entries.is_empty() || (action != "ungroup" && entries.len() < 2) { return Err("付箋を2件以上選んでください".into()); }
    let title = title.trim();
    if action != "ungroup" && (title.is_empty() || title.contains(['\r','\n']) || title.chars().count() > 100) { return Err("名前を1〜100文字で入力してください".into()); }
    let _writer = state.writes.lock().unwrap();
    let mut sources = Vec::new(); let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let file = checked(&state, &entry.path)?;
        if !seen.insert(file.clone()) { return Err("同じ付箋が重複しています".into()); }
        if window.app_handle().get_webview_window(&label_for(&file.to_string_lossy())).is_some() { return Err("付箋の保存・閉鎖を待って、もう一度お試しください".into()); }
        let (text, revision) = read_snapshot(&file)?;
        if revision != entry.revision { return Err("他で変更されました。一覧を更新してください".into()); }
        if note_metadata(split_front(&text).0).error.is_some() { return Err("付箋の属性を確認してください".into()); }
        sources.push((file,text));
    }
    let id = format!("group-{}-{}", chrono::Local::now().timestamp_nanos_opt().unwrap_or_default(), make_id(0));
    if action != "merge" {
        let changes = sources.iter().map(|(file,text)|Ok((file.clone(),text.clone(),grouped(text,if action=="group" {&id} else {""},if action=="group" {title} else {""})?))).collect::<Result<Vec<_>,String>>()?;
        commit_changes(&changes)?;
        return Ok(None);
    }
    let destination = registered_dir(&state, &folder.ok_or("保存先を選んでください")?)?;
    let mut images = HashMap::<String, Vec<u8>>::new(); let mut sections = Vec::new(); let mut tags = Vec::new();
    for (file,text) in &sources {
        let (front,body) = split_front(text); let metadata = note_metadata(front); let mut body = body.to_owned();
        attachments::for_each_linked(file, text, |name,bytes| {
            let hashed = format!("{:x}.png", Sha256::digest(bytes));
            body = body.replace(&format!("attachments/{name}"), &format!("attachments/{hashed}"));
            images.insert(hashed,bytes.to_vec()); Ok(())
        })?;
        sections.push((metadata.title.unwrap_or_else(||title_of(split_front(text).1)),body));
        for tag in metadata.tags { if !tags.contains(&tag) { tags.push(tag); } }
    }
    let text = merge_text(title,&sections,&tags,&id)?;
    let mut staged = Vec::new();
    for (name,bytes) in images {
        let mut file = tempfile::NamedTempFile::new_in(&destination).map_err(|e|e.to_string())?;
        file.write_all(&bytes).map_err(|e|e.to_string())?; staged.push((name,file));
    }
    attachments::install_imported(&destination, staged.into_iter())?;
    let mut output = tempfile::NamedTempFile::new_in(&destination).map_err(|e|e.to_string())?;
    output.write_all(text.as_bytes()).and_then(|()|output.as_file().sync_all()).map_err(|e|e.to_string())?;
    let file = destination.join(format!("merge-{id}.md"));
    output.persist_noclobber(&file).map_err(|e|e.to_string())?;
    let changes = sources.iter().map(|(file,text)|Ok((file.clone(),text.clone(),archive_text(text,true)?))).collect::<Result<Vec<_>,String>>()?;
    commit_changes(&changes).map_err(|error|format!("まとめた付箋は {} に保存済みです。{error}",file.display()))?;
    Ok(Some(file.to_string_lossy().into_owned()))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn grouping_roundtrip_keeps_original_metadata_and_body() {
        let source="---\nid: old\ntags: [test]\ncustom: yes\n---\nBody\n![x](attachments/a.png)\n";
        let text=grouped(source,"group-1","名前: \"test\"").unwrap();
        assert_eq!(info(split_front(&text).0),("group-1".into(),"名前: \"test\"".into()));
        let undone=grouped(&text,"","").unwrap();assert_eq!(info(split_front(&undone).0),Default::default());
        assert_eq!(split_front(&undone).1,split_front(source).1);assert!(undone.contains("custom: yes"));
    }
    #[test] fn merge_keeps_order_tags_and_rejects_changed_sources() {
        let result=merge_text("Result",&[("A".into(),"First".into()),("B".into(),"Second".into())],&["tag".into()],"id").unwrap();
        assert!(result.find("First").unwrap()<result.find("Second").unwrap());assert_eq!(note_metadata(split_front(&result).0).tags,vec!["tag"]);
        let dir=tempfile::tempdir().unwrap();let file=dir.path().join("a.md");fs::write(&file,"newer").unwrap();
        assert!(commit_changes(&[(file.clone(),"old".into(),"changed".into())]).is_err());assert_eq!(fs::read_to_string(file).unwrap(),"newer");
    }
}
