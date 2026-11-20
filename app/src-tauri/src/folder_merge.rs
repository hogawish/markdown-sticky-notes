use super::*;
use folder_move::{Tree,snapshot};

#[derive(Serialize)]pub(super) struct Plan{
    source:String,destination:String,token:String,added:usize,shared:usize,conflicts:Vec<String>,
}
#[derive(Serialize)]pub(super) struct Merged{source:String,destination:String,backup:String,warning:Option<String>}
fn excluded(path:&Path)->bool{path.components().next().is_some_and(|c|c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))||path==Path::new(folder_identity::MARKER)}
fn roots(st:&AppState,source:&str,destination:&str)->Result<(PathBuf,PathBuf,FolderCfg,FolderCfg),String>{
    let a=registered_dir(st,source)?;let b=registered_dir(st,destination)?;
    if a.file_name().is_none()||b.file_name().is_none(){return Err("ドライブ全体はマージできません".into());}
    if a.starts_with(&b)||b.starts_with(&a){return Err("同じフォルダや、互いに入れ子のフォルダはマージできません".into());}
    for path in [st.cfg_path.canonicalize().ok(),env::current_exe().ok().and_then(|p|p.canonicalize().ok())].into_iter().flatten(){
        if path.starts_with(&a)||path.starts_with(&b){return Err("アプリ本体や設定を含むフォルダは対象にできません".into());}
    }
    let cfg=st.cfg.lock().unwrap();
    if cfg.folders.iter().any(|f|Path::new(&f.path).canonicalize().ok().is_some_and(|p|(p!=a&&p.starts_with(&a))||(p!=b&&p.starts_with(&b)))){return Err("中に別の登録フォルダがあります。先に登録を整理してください".into());}
    let f=|p:&Path|cfg.folders.iter().find(|f|Path::new(&f.path).canonicalize().ok().as_deref()==Some(p)).cloned().ok_or("登録フォルダがありません".to_owned());
    Ok((a.clone(),b.clone(),f(&a)?,f(&b)?))
}
fn build(a:&Path,b:&Path,from:&Tree,to:&Tree)->Result<Plan,String>{
    let mut added=0;let mut shared=0;let mut conflicts=vec![];
    let target:HashMap<_,_>=to.iter().map(|(p,h)|(p.to_string_lossy().to_lowercase(),h)).collect();
    for(p,hash)in from.iter().filter(|(p,_)|!p.as_os_str().is_empty()&&!excluded(p)){
        match target.get(&p.to_string_lossy().to_lowercase()){
            Some(other)if *other==hash=>{if hash.is_some(){shared+=1;}},
            Some(_)=>conflicts.push(p.to_string_lossy().into()),
            None=>{if hash.is_some(){added+=1;}},
        }
    }
    let token=revision_of(&serde_json::to_vec(&(from,to)).map_err(|e|e.to_string())?);
    Ok(Plan{source:a.to_string_lossy().into(),destination:b.to_string_lossy().into(),token,added,shared,conflicts})
}
#[tauri::command]pub(super) async fn plan_folder_merge(window:WebviewWindow,source:String,destination:String)->Result<Plan,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}let app=window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move||{let st=app.state::<AppState>();let(a,b,_,_)=roots(&st,&source,&destination)?;build(&a,&b,&snapshot(&a)?,&snapshot(&b)?)}).await.map_err(|e|e.to_string())?
}
fn safe_directory(root:&Path,relative:&Path)->Result<(),String>{
    let mut path=root.to_owned();
    for part in relative.components(){
        if !matches!(part,std::path::Component::Normal(_)){return Err("フォルダ内の相対パスを確認してください".into());}
        path.push(part);match fs::create_dir(&path){Ok(())=>{},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e.to_string())}
        let meta=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;if !meta.is_dir()||!folder_move::regular(&meta){return Err("マージ先にリンクや特殊なフォルダがあります".into());}
    }Ok(())
}
fn install(a:&Path,b:&Path,tree:&Tree)->Result<(),String>{
    for (relative,hash)in tree.iter().filter(|(p,_)|!p.as_os_str().is_empty()&&!excluded(p)){
        if hash.is_none(){safe_directory(b,relative)?;continue;}
        safe_directory(b,relative.parent().unwrap_or(Path::new("")))?;
        let from=a.join(relative);let to=b.join(relative);
        if fs::symlink_metadata(&to).is_err(){
            let mut out=tempfile::NamedTempFile::new_in(to.parent().ok_or("コピー先の親がありません")?).map_err(|e|e.to_string())?;
            let meta=fs::symlink_metadata(&from).map_err(|e|e.to_string())?;if !folder_move::regular(&meta){return Err("元ファイルの種類が変更されました".into());}
            let mut input=fs::File::open(&from).map_err(|e|e.to_string())?;std::io::copy(&mut input,&mut out).map_err(|e|e.to_string())?;
            folder_move::copy_times(out.as_file(),&meta)?;out.as_file().sync_all().map_err(|e|e.to_string())?;
            if Some(&folder_move::digest(out.path())?)!=hash.as_ref(){return Err("コピー中に元ファイルが変更されました".into());}
            if let Err(e)=out.persist_noclobber(&to){if e.error.kind()!=std::io::ErrorKind::AlreadyExists{return Err(e.error.to_string());}}
        }
        let meta=fs::symlink_metadata(&to).map_err(|e|e.to_string())?;if !meta.is_file()||!folder_move::regular(&meta){return Err("マージ先にリンクや特殊なファイルがあります".into());}
        let current=folder_move::digest(&to)?;
        if Some(&current)!=hash.as_ref(){return Err(format!("コピー先が変更されました（{}）。元データは残しています",relative.display()));}
    }Ok(())
}
fn verify_copied(from:&Tree,after:&Tree)->Result<(),String>{
    let actual:HashMap<_,_>=after.iter().map(|(p,h)|(p.to_string_lossy().to_lowercase(),h)).collect();
    if from.iter().filter(|(p,_)|!p.as_os_str().is_empty()&&!excluded(p)).any(|(p,h)|actual.get(&p.to_string_lossy().to_lowercase()).copied()!=Some(h)){
        return Err("コピーしたファイルが変更または削除されたため中止しました。元フォルダは残しています".into());
    }Ok(())
}
fn normalize_parents(cfg:&mut Config){
    let mut keys=cfg.notes.keys().cloned().collect::<Vec<_>>();keys.sort();
    for path in keys{
        let mut seen=HashSet::new();let mut current=path;
        loop{
            if !seen.insert(current.clone()){
                if let Some(note)=cfg.notes.get_mut(&current){note.parent_note=None;}break;
            }
            let Some(parent)=cfg.notes.get(&current).and_then(|n|n.parent_note.clone())else{break};current=parent;
        }
    }
    for note in cfg.notes.values_mut(){let mut seen=HashSet::new();note.family_order.retain(|p|seen.insert(p.clone()));}
}
fn merge(st:&AppState,source:&str,destination:&str,token:&str,is_open:impl Fn(&Path)->bool)->Result<Merged,String>{
    let _writes=st.writes.lock().unwrap();let(a,b,fa,fb)=roots(st,source,destination)?;
    *st.moving_folder.lock().unwrap()=vec![a.clone(),b.clone()];
    struct Guard<'a>(&'a AppState);impl Drop for Guard<'_>{fn drop(&mut self){self.0.moving_folder.lock().unwrap().clear();}}let _gate=Guard(st);
    if is_open(&a)||is_open(&b){return Err("両方のフォルダの付箋を保存して閉じてから操作してください".into());}
    let from=snapshot(&a)?;let to=snapshot(&b)?;let plan=build(&a,&b,&from,&to)?;
    if !plan.conflicts.is_empty(){return Err(format!("内容が違う同名ファイルがあります。上書きしていません: {}",plan.conflicts.join("、")));}
    if plan.token!=token{return Err("確認後に内容が変わりました。もう一度内容を確認してください".into());}
    let source_ids=folder_identity::ids(&a,&fa.id)?;let marker=folder_identity::merged_marker(&b,&fb.id,source_ids.clone())?;
    // Existing destination files are never overwritten. A failed copy leaves both originals available.
    install(&a,&b,&from).map_err(|e|format!("{e}\n元フォルダはそのままです。追加済みのコピーが移動先に残る場合があります。"))?;
    if snapshot(&a)?!=from{return Err("コピー中に元の内容が変わったため中止しました。元フォルダは残しています".into());}
    let after=snapshot(&b)?;
    if to.iter().any(|(p,h)|after.get(p)!=Some(h)){return Err("コピー中に移動先の内容が変わったため中止しました。元フォルダは残しています".into());}
    verify_copied(&from,&after)?;
    let marker_path=b.join(folder_identity::MARKER);let old_marker=fs::read(&marker_path).map_err(|e|e.to_string())?;
    let _cfg_writer=st.config_writes.lock().unwrap();let mut cfg=st.cfg.lock().unwrap();
    if !cfg.folders.iter().any(|f|f.id==fa.id&&f.path==fa.path)||!cfg.folders.iter().any(|f|f.id==fb.id&&f.path==fb.path){return Err("登録先が変更されました。元フォルダは残しています".into());}
    let mut next=cfg.clone();let existing=next.notes.iter().filter(|(p,_)|Path::new(p).starts_with(&b)).map(|(p,n)|(p.clone(),n.clone())).collect::<HashMap<_,_>>();
    next.folders.retain(|f|f.id!=fa.id);next.removed_folders.retain(|f|!source_ids.contains(&f.id));folder_move::retarget(&mut next,&a,&b);next.notes.extend(existing);
    // Target layout wins for shared notes, but its references still need migration.
    for note in next.notes.values_mut(){
        if let Some(parent)=&mut note.parent_note{*parent=folder_move::mapped(parent,&a,&b);}
        for member in &mut note.family_order{*member=folder_move::mapped(member,&a,&b);}
    }
    normalize_parents(&mut next);
    let next_bytes=serde_json::to_vec_pretty(&next).map_err(|e|e.to_string())?;
    atomic_write(&marker_path,&marker)?;
    if let Err(e)=atomic_write(&st.cfg_path,&next_bytes){
        let restore=if fs::read(&marker_path).ok().as_ref()==Some(&marker){atomic_write(&marker_path,&old_marker)}else{Err("IDファイルが他で変更されました".into())};
        return Err(format!("設定を保存できませんでした: {e}。元フォルダは残しています。{}",restore.err().unwrap_or_default()));
    }
    *cfg=next;drop(cfg);
    st.labels.lock().unwrap().retain(|_,p|folder_move::mapped(p,&a,&b)==*p);
    let mut tools=st.note_tools.lock().unwrap();for p in &mut tools.merge_paths{*p=folder_move::mapped(p,&a,&b);}if let Some(p)=&mut tools.layer_path{*p=folder_move::mapped(p,&a,&b);}drop(tools);
    let backup=a.parent().ok_or("元フォルダの親がありません")?.join(format!("sticky-merge-backup-{}",make_id(0)));
    let warning=if snapshot(&a).ok().as_ref()!=Some(&from){Some(format!("元フォルダに変更があったため、その場所に保全しました: {}",shell_path(&a)))}
        else{fs::rename(&a,&backup).err().map(|e|format!("元フォルダをその場所に保全しました: {} — {e}",shell_path(&a)))};
    let backup=if warning.is_some(){a.clone()}else{backup};
    Ok(Merged{source:a.to_string_lossy().into(),destination:b.to_string_lossy().into(),backup:shell_path(&backup),warning})
}
#[tauri::command]pub(super) async fn merge_registered_folders(window:WebviewWindow,source:String,destination:String,token:String)->Result<Merged,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}let app=window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let st=app.state::<AppState>();let result=merge(&st,&source,&destination,&token,|root|st.labels.lock().unwrap().iter().any(|(label,p)|folder_move::mapped(p,root,Path::new("__moved__"))!=*p&&app.get_webview_window(label).is_some()));
        let _=app.emit("sticky-parent-changed",());result
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]mod tests{
 use super::*;
 fn fixture()->(tempfile::TempDir,AppState,PathBuf,PathBuf){
  let temp=tempfile::tempdir().unwrap();let a=temp.path().join("source");let b=temp.path().join("target");for(p,id)in[(&a,"a"),(&b,"b")]{fs::create_dir_all(p.join("attachments")).unwrap();folder_identity::ensure(p,id).unwrap();}
  let a=a.canonicalize().unwrap();let b=b.canonicalize().unwrap();
  let st=AppState{cfg:Mutex::new(Config{folders:vec![FolderCfg{id:"a".into(),path:a.to_string_lossy().into(),label:"Work".into()},FolderCfg{id:"b".into(),path:b.to_string_lossy().into(),label:"Personal".into()}],..Default::default()}),cfg_path:temp.path().join("cfg.json"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),moving_folder:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()};
  (temp,st,a,b)
 }
 fn plan(a:&Path,b:&Path)->Plan{build(a,b,&snapshot(a).unwrap(),&snapshot(b).unwrap()).unwrap()}
 #[test]fn merge_keeps_bytes_images_trash_git_backup_and_original_id_links(){
  let(_temp,st,a,b)=fixture();let raw=b"\xef\xbb\xbf---\r\ntags: [work]\r\n---\r\n![x](attachments/image.png)\r\n[second](second.md)\r\n";
  fs::write(a.join("first.md"),raw).unwrap();fs::write(a.join("second.md"),b"second").unwrap();fs::write(b.join("existing.md"),b"existing").unwrap();
  for p in [&a,&b]{fs::write(p.join("attachments/image.png"),b"shared-image").unwrap();}
  fs::create_dir(a.join(".trash")).unwrap();fs::write(a.join(".trash/old.md"),b"trash").unwrap();fs::create_dir(a.join(".git")).unwrap();fs::write(a.join(".git/config"),b"source-git").unwrap();fs::create_dir(b.join(".git")).unwrap();fs::write(b.join(".git/config"),b"target-git").unwrap();
  let first=a.join("first.md").to_string_lossy().into_owned();let second=a.join("second.md").to_string_lossy().into_owned();st.cfg.lock().unwrap().notes.insert(first.clone(),NoteState{x:Some(42),..Default::default()});st.cfg.lock().unwrap().notes.insert(second.clone(),NoteState{parent_note:Some(first.clone()),family_order:vec![first],..Default::default()});
  st.cfg.lock().unwrap().notes.insert(b.join("existing.md").to_string_lossy().into_owned(),NoteState{parent_note:Some(a.join("first.md").to_string_lossy().into_owned()),family_order:vec![a.join("second.md").to_string_lossy().into_owned()],..Default::default()});
  let result=merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&plan(&a,&b).token,|_|false).unwrap();assert!(result.warning.is_none());assert!(!a.exists());assert_eq!(fs::read(b.join("first.md")).unwrap(),raw);assert_eq!(fs::read(b.join("attachments/image.png")).unwrap(),b"shared-image");assert_eq!(fs::read(b.join(".trash/old.md")).unwrap(),b"trash");assert_eq!(fs::read(b.join(".git/config")).unwrap(),b"target-git");assert_eq!(fs::read(Path::new(&result.backup).join(".git/config")).unwrap(),b"source-git");
  let cfg=st.cfg.lock().unwrap();assert_eq!(cfg.folders.len(),1);assert_eq!(cfg.folders[0].id,"b");assert_eq!(cfg.folders[0].label,"Personal");let new=b.join("first.md").to_string_lossy().into_owned();assert_eq!(cfg.notes[&new].x,Some(42));assert_eq!(cfg.notes[&b.join("second.md").to_string_lossy().into_owned()].parent_note.as_ref(),Some(&new));drop(cfg);
  assert_eq!(st.cfg.lock().unwrap().notes[&b.join("existing.md").to_string_lossy().into_owned()].parent_note.as_deref(),Some(b.join("first.md").to_string_lossy().as_ref()));
  assert_eq!(st.cfg.lock().unwrap().notes[&b.join("existing.md").to_string_lossy().into_owned()].family_order,vec![b.join("second.md").to_string_lossy().into_owned()]);
  assert_eq!(note_links::resolve(&st,&b.join("existing.md"),"sticky-note://a/first.md").unwrap(),b.join("first.md"));assert_eq!(note_links::resolve(&st,&b.join("first.md"),"second.md").unwrap(),b.join("second.md"));assert_eq!(load_cfg(&st.cfg_path).folders.len(),1);assert!(st.moving_folder.lock().unwrap().is_empty());
 }
 #[test]fn conflicts_stale_preview_and_open_windows_do_not_modify_folders(){
  let(_temp,st,a,b)=fixture();fs::write(a.join("same.md"),b"source").unwrap();fs::write(b.join("same.md"),b"target").unwrap();let before=(snapshot(&a).unwrap(),snapshot(&b).unwrap());let p=plan(&a,&b);assert_eq!(p.conflicts,vec!["same.md"]);assert!(merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&p.token,|_|false).is_err());assert_eq!((snapshot(&a).unwrap(),snapshot(&b).unwrap()),before);
  fs::remove_file(b.join("same.md")).unwrap();let p=plan(&a,&b);fs::write(a.join("new.md"),b"new").unwrap();assert!(merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&p.token,|_|false).is_err());assert!(!b.join("new.md").exists());assert!(merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&plan(&a,&b).token,|_|true).is_err());assert!(st.moving_folder.lock().unwrap().is_empty());
 }
 #[test]fn failed_config_preserves_source_registration_and_marker_and_can_retry(){
  let(temp,mut st,a,b)=fixture();fs::write(a.join("a.md"),b"body").unwrap();let original_marker=fs::read(b.join(folder_identity::MARKER)).unwrap();st.cfg_path=temp.path().join("bad-config");fs::create_dir(&st.cfg_path).unwrap();
  assert!(merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&plan(&a,&b).token,|_|false).is_err());assert!(a.exists());assert_eq!(st.cfg.lock().unwrap().folders.len(),2);assert_eq!(fs::read(b.join(folder_identity::MARKER)).unwrap(),original_marker);assert_eq!(fs::read(b.join("a.md")).unwrap(),b"body");
  st.cfg_path=temp.path().join("cfg.json");let p=plan(&a,&b);assert_eq!(p.shared,1);merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&p.token,|_|false).unwrap();assert!(!a.exists());
 }
 #[test]fn successive_merges_carry_aliases_and_shared_note_keeps_target_state(){
  let(temp,st,a,b)=fixture();for p in [&a,&b]{fs::write(p.join("same.md"),b"same").unwrap();}
  st.cfg.lock().unwrap().notes.insert(a.join("same.md").to_string_lossy().into(),NoteState{x:Some(10),..Default::default()});st.cfg.lock().unwrap().notes.insert(b.join("same.md").to_string_lossy().into(),NoteState{x:Some(20),..Default::default()});merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&plan(&a,&b).token,|_|false).unwrap();assert_eq!(st.cfg.lock().unwrap().notes[&b.join("same.md").to_string_lossy().into_owned()].x,Some(20));
  let c=temp.path().join("third");fs::create_dir(&c).unwrap();let c=c.canonicalize().unwrap();folder_identity::ensure(&c,"c").unwrap();st.cfg.lock().unwrap().folders.push(FolderCfg{id:"c".into(),path:c.to_string_lossy().into(),label:"Third".into()});merge(&st,&b.to_string_lossy(),&c.to_string_lossy(),&plan(&b,&c).token,|_|false).unwrap();assert_eq!(folder_identity::ids(&c,"c").unwrap(),vec!["a","b","c"]);assert_eq!(note_links::resolve(&st,&c.join("same.md"),"sticky-note://a/same.md").unwrap(),c.join("same.md"));
 }
 #[test]fn changed_copy_is_not_published_and_final_verification_checks_new_files(){
  let(_temp,_st,a,b)=fixture();fs::write(a.join("new.md"),b"expected").unwrap();let expected=snapshot(&a).unwrap();fs::write(a.join("new.md"),b"changed").unwrap();assert!(install(&a,&b,&expected).is_err());assert!(!b.join("new.md").exists());
  assert!(verify_copied(&expected,&snapshot(&b).unwrap()).is_err());fs::write(b.join("new.md"),b"changed").unwrap();assert!(verify_copied(&expected,&snapshot(&b).unwrap()).is_err());fs::write(b.join("new.md"),b"expected").unwrap();assert!(verify_copied(&expected,&snapshot(&b).unwrap()).is_ok());
 }
 #[test]fn sharing_identical_notes_does_not_create_self_parenting(){
  let(_temp,st,a,b)=fixture();for p in [&a,&b]{fs::write(p.join("same.md"),b"same").unwrap();}
  st.cfg.lock().unwrap().notes.insert(a.join("same.md").to_string_lossy().into(),NoteState::default());st.cfg.lock().unwrap().notes.insert(b.join("same.md").to_string_lossy().into(),NoteState{parent_note:Some(a.join("same.md").to_string_lossy().into()),..Default::default()});
  merge(&st,&a.to_string_lossy(),&b.to_string_lossy(),&plan(&a,&b).token,|_|false).unwrap();let cfg=st.cfg.lock().unwrap();assert!(cfg.notes[&b.join("same.md").to_string_lossy().into_owned()].parent_note.is_none());assert!(note_parent::root(&cfg,&b.join("same.md").to_string_lossy()).is_some());
 }
}
