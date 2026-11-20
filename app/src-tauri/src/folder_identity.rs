use super::*;
use std::collections::VecDeque;
pub(super) const MARKER:&str=".sticky-folder.json";
#[derive(Serialize,Deserialize)]
pub(super) struct Identity{format:String,version:u32,pub id:String,#[serde(default,skip_serializing_if="Vec::is_empty")]pub aliases:Vec<String>}
fn plain(path:&Path)->bool{
    let Ok(meta)=fs::symlink_metadata(path)else{return false};
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return false;}}
    !meta.file_type().is_symlink()
}
pub(super) fn read_id(dir:&Path)->Result<Option<String>,String>{
    Ok(read_marker(dir)?.map(|m|m.id))
}
pub(super) fn read_marker(dir:&Path)->Result<Option<Identity>,String>{
    let path=dir.join(MARKER);
    match fs::symlink_metadata(&path){Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(e)=>return Err(e.to_string()),Ok(m)=>{if !m.is_file()||!plain(&path){return Err("追跡用IDファイルが通常のファイルではありません".into());}}}
    let mut bytes=Vec::new();fs::File::open(path).map_err(|e|e.to_string())?.take(8193).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>8192{return Err("追跡用IDファイルが大きすぎます".into());}
    let marker:Identity=serde_json::from_slice(&bytes).map_err(|_|"追跡用IDファイルを読めません")?;
    let valid=|id:&str|!id.is_empty()&&id.len()<=160&&!id.chars().any(char::is_control);
    if marker.format!="markdown-sticky-notes-folder"||marker.version!=1||!valid(&marker.id)||marker.aliases.iter().any(|id|!valid(id)){return Err("追跡用IDファイルの形式が異なります".into());}
    Ok(Some(marker))
}
pub(super) fn ids(dir:&Path,id:&str)->Result<Vec<String>,String>{
    verify(dir,id)?;
    let mut ids=vec![id.to_owned()];if let Some(marker)=read_marker(dir)?{ids.extend(marker.aliases);}ids.sort();ids.dedup();Ok(ids)
}
pub(super) fn merged_marker(dir:&Path,id:&str,additional:Vec<String>)->Result<Vec<u8>,String>{
    let mut aliases=ids(dir,id)?;aliases.extend(additional);aliases.retain(|v|v!=id);aliases.sort();aliases.dedup();
    let bytes=serde_json::to_vec_pretty(&Identity{format:"markdown-sticky-notes-folder".into(),version:1,id:id.into(),aliases}).map_err(|e|e.to_string())?;
    if bytes.len()>8192{return Err("フォルダIDの履歴が大きすぎます".into());}Ok(bytes)
}
pub(super) fn ensure(dir:&Path,id:&str)->Result<(),String>{
    if let Some(existing)=read_id(dir)?{return if existing==id{Ok(())}else{Err("登録とフォルダ内のIDが異なります。「場所を探す」で確認してください".into())};}
    let marker=Identity{format:"markdown-sticky-notes-folder".into(),version:1,id:id.into(),aliases:vec![]};
    let mut file=tempfile::NamedTempFile::new_in(dir).map_err(|e|e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&marker).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;file.as_file().sync_all().map_err(|e|e.to_string())?;
    match file.persist_noclobber(dir.join(MARKER)){Ok(_)=>Ok(()),Err(_)=>verify_existing(dir,id)}
}
fn verify_existing(dir:&Path,id:&str)->Result<(),String>{
    if read_id(dir)?.as_deref()==Some(id){Ok(())}else{Err("追跡用IDファイルを保存できませんでした".into())}
}
pub(super) fn adopt_or_create(dir:&Path)->Result<String,String>{
    if let Some(id)=read_id(dir)?{return Ok(id);}
    let id=make_id(0);ensure(dir,&id)?;Ok(id)
}
pub(super) fn verify(dir:&Path,id:&str)->Result<(),String>{
    if id.is_empty(){return Ok(());}
    match read_id(dir)?{Some(actual)if actual!=id=>Err("登録とフォルダ内のIDが異なります。「場所を探す」で確認してください".into()),_=>Ok(())}
}
pub(super) fn tracking_error(dir:&Path,id:&str)->Option<String>{
    match read_id(dir){Ok(Some(actual))if actual==id=>None,Ok(None)=>Some("追跡用IDファイルがありません".into()),Ok(Some(_))=>Some("登録とフォルダ内のIDが異なります".into()),Err(e)=>Some(e)}
}
#[derive(Serialize)]pub(super) struct Candidate{path:String,display:String}
#[derive(Serialize)]pub(super) struct Search{candidates:Vec<Candidate>,visited:usize,skipped:usize,truncated:bool}
fn search(id:&str,root:&Path)->Result<Search,String>{
    let root=root.canonicalize().map_err(|e|e.to_string())?;
    if !root.is_dir()||!plain(&root){return Err("検索する通常のフォルダを選んでください".into());}
    let mut queue=VecDeque::from([(root,0usize)]);let mut result=Search{candidates:vec![],visited:0,skipped:0,truncated:false};
    while let Some((dir,depth))=queue.pop_front(){
        if result.visited>=10000{result.truncated=true;break;}
        if !plain(&dir){result.skipped+=1;continue;}result.visited+=1;
        match read_id(&dir){Ok(Some(found))if found==id=>{result.candidates.push(Candidate{display:shell_path(&dir),path:dir.to_string_lossy().into()});continue;},Err(_)=>result.skipped+=1,_=>{}}
        let entries=match fs::read_dir(&dir){Ok(v)=>v,Err(_)=>{result.skipped+=1;continue}};
        for entry in entries{
            let Ok(entry)=entry else{result.skipped+=1;continue};let path=entry.path();
            let Ok(meta)=fs::symlink_metadata(&path)else{result.skipped+=1;continue};
            if !meta.is_dir(){continue;}if !plain(&path){result.skipped+=1;continue;}
            if matches!(entry.file_name().to_str(),Some(".git"|"node_modules")){continue;}
            if depth>=8{result.truncated=true;continue;}
            if queue.len()+result.visited>=10000{result.truncated=true;continue;}
            queue.push_back((path,depth+1));
        }
    }
    result.candidates.sort_by(|a,b|a.path.cmp(&b.path));Ok(result)
}
#[tauri::command]pub(super) async fn find_folder_location(window:WebviewWindow,id:String,root:String)->Result<Search,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}
    if !window.state::<AppState>().cfg.lock().unwrap().folders.iter().any(|f|f.id==id){return Err("登録フォルダがありません".into());}
    tauri::async_runtime::spawn_blocking(move||search(&id,Path::new(&root))).await.map_err(|e|e.to_string())?
}
#[derive(Serialize)]pub(super) struct Reconnected{source:String,destination:String,reopen:Vec<String>}
fn reconnect(st:&AppState,id:&str,target:&Path,is_open:impl Fn(&Path)->bool)->Result<Reconnected,String>{
    let _writer=st.writes.lock().unwrap();let target=target.canonicalize().map_err(|e|e.to_string())?;
    if !target.is_dir()||!plain(&target)||read_id(&target)?.as_deref()!=Some(id){return Err("選んだ場所は、この登録のIDと一致しません".into());}
    let source={let cfg=st.cfg.lock().unwrap();PathBuf::from(&cfg.folders.iter().find(|f|f.id==id).ok_or("登録フォルダがありません")?.path)};
    *st.moving_folder.lock().unwrap()=vec![source.clone()];
    struct Guard<'a>(&'a AppState);impl Drop for Guard<'_>{fn drop(&mut self){*self.0.moving_folder.lock().unwrap()=vec![];}}
    let _gate=Guard(st);
    if folder_move::has_opening(st,&source)||is_open(&source){return Err("元の登録の付箋を保存して閉じてから、つなぎ直してください。未保存の本文は破棄していません".into());}
    let _config_writer=st.config_writes.lock().unwrap();let mut cfg=st.cfg.lock().unwrap();
    if cfg.folders.iter().any(|f|f.id!=id&&Path::new(&f.path).canonicalize().ok().as_ref()==Some(&target)){return Err("その場所は別の登録として使用されています".into());}
    let mut next=cfg.clone();folder_move::retarget(&mut next,&source,&target);
    let reopen=next.notes.iter().filter(|(path,n)|n.open&&Path::new(path).starts_with(&target)).map(|(p,_)|p.clone()).collect();
    atomic_write(&st.cfg_path,&serde_json::to_vec_pretty(&next).map_err(|e|e.to_string())?)?;*cfg=next;drop(cfg);
    st.labels.lock().unwrap().retain(|_,p|folder_move::mapped(p,&source,&target)==*p);
    let mut tools=st.note_tools.lock().unwrap();for p in &mut tools.merge_paths{*p=folder_move::mapped(p,&source,&target);}if let Some(p)=&mut tools.layer_path{*p=folder_move::mapped(p,&source,&target);}
    Ok(Reconnected{source:source.to_string_lossy().into(),destination:target.to_string_lossy().into(),reopen})
}
#[tauri::command]pub(super) async fn reconnect_folder(window:WebviewWindow,id:String,path:String)->Result<Reconnected,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}
    let app=window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let st=app.state::<AppState>();let result=reconnect(&st,&id,Path::new(&path),|root|st.labels.lock().unwrap().iter().any(|(label,p)|folder_move::mapped(p,root,Path::new("__moved__"))!=*p&&app.get_webview_window(label).is_some()));
        let _=app.emit("sticky-parent-changed",());result
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)] mod tests{
 use super::*;
 fn state(root:&Path,source:&Path)->AppState{
  AppState{cfg:Mutex::new(Config{folders:vec![FolderCfg{id:"test-id".into(),path:source.to_string_lossy().into(),label:"Work".into()}],..Default::default()}),cfg_path:root.join("config.json"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),moving_folder:Default::default(),opening_notes:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()}
 }
 #[test]fn manual_move_and_copy_are_discovered_by_carried_id_without_changing_files(){
  let temp=tempfile::tempdir().unwrap();let source=temp.path().join("notes");fs::create_dir(&source).unwrap();ensure(&source,"test-id").unwrap();fs::write(source.join("a.md"),b"keep").unwrap();
  let moved=temp.path().join("manually-moved");fs::rename(&source,&moved).unwrap();let copy=temp.path().join("copy");fs::create_dir(&copy).unwrap();fs::copy(moved.join(MARKER),copy.join(MARKER)).unwrap();
  let found=search("test-id",temp.path()).unwrap();assert_eq!(found.candidates.len(),2);assert!(!found.truncated);assert!(!source.exists());assert_eq!(fs::read(moved.join("a.md")).unwrap(),b"keep");
  assert_eq!(search("different-id",temp.path()).unwrap().candidates.len(),0);
 }
 #[test]fn reconnect_retargets_missing_plain_and_namespace_paths_and_family_state(){
  let temp=tempfile::tempdir().unwrap();let source=temp.path().join("notes");fs::create_dir(&source).unwrap();ensure(&source,"test-id").unwrap();fs::write(source.join("a.md"),b"unchanged").unwrap();
  let canonical=source.canonicalize().unwrap();let old=canonical.join("a.md").to_string_lossy().into_owned();let st=state(temp.path(),Path::new(&shell_path(&canonical)));
  st.cfg.lock().unwrap().notes.insert(old.clone(),NoteState{open:true,x:Some(42),..Default::default()});
  st.cfg.lock().unwrap().notes.insert("outside.md".into(),NoteState{parent_note:Some(old.clone()),family_order:vec![old],..Default::default()});
  let target=temp.path().join("renamed");fs::rename(&source,&target).unwrap();let result=reconnect(&st,"test-id",&target,|_|false).unwrap();let new=Path::new(&result.destination).join("a.md").to_string_lossy().into_owned();
  assert_eq!(result.reopen,vec![new.clone()]);let cfg=st.cfg.lock().unwrap();assert_eq!(cfg.folders[0].id,"test-id");assert_eq!(cfg.folders[0].label,"Work");assert_eq!(cfg.folders[0].path,result.destination);assert_eq!(cfg.notes[&new].x,Some(42));assert_eq!(cfg.notes["outside.md"].parent_note.as_ref(),Some(&new));assert_eq!(cfg.notes["outside.md"].family_order,vec![new]);
  assert_eq!(fs::read(target.join("a.md")).unwrap(),b"unchanged");assert!(!source.exists());assert!(st.moving_folder.lock().unwrap().is_empty());
 }
 #[test]fn wrong_identity_open_drafts_and_failed_config_do_not_reconnect(){
  let temp=tempfile::tempdir().unwrap();let source=temp.path().join("old");let target=temp.path().join("target");fs::create_dir(&target).unwrap();ensure(&target,"wrong-id").unwrap();let mut st=state(temp.path(),&source);
  assert!(reconnect(&st,"test-id",&target,|_|false).is_err());assert!(ensure(&target,"test-id").is_err());fs::remove_file(target.join(MARKER)).unwrap();ensure(&target,"test-id").unwrap();
  assert!(reconnect(&st,"test-id",&target,|_|true).is_err());st.cfg_path=target.clone();assert!(reconnect(&st,"test-id",&target,|_|false).is_err());assert_eq!(st.cfg.lock().unwrap().folders[0].path,source.to_string_lossy());assert_eq!(read_id(&target).unwrap().as_deref(),Some("test-id"));assert!(st.moving_folder.lock().unwrap().is_empty());
 }
 #[test]fn legacy_registration_adopts_marker_and_malformed_marker_is_not_overwritten(){
  let temp=tempfile::tempdir().unwrap();ensure(temp.path(),"existing-id").unwrap();let mut cfg=Config{folders:vec![FolderCfg{path:temp.path().to_string_lossy().into(),..Default::default()}],..Default::default()};cfg.ensure_folder_ids();assert_eq!(cfg.folders[0].id,"existing-id");
  fs::write(temp.path().join(MARKER),b"invalid").unwrap();assert!(adopt_or_create(temp.path()).is_err());assert_eq!(fs::read(temp.path().join(MARKER)).unwrap(),b"invalid");
 }
}
