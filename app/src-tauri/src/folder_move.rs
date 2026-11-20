use super::*;
use std::collections::BTreeMap;

#[derive(Serialize)]
pub(super) struct Plan { pub source:String, pub destination:String }
#[derive(Serialize)]
pub(super) struct Moved { pub source:String, pub destination:String, pub warning:Option<String> }
type Tree=BTreeMap<PathBuf,Option<String>>;

pub(super) fn ensure_available(st:&AppState,path:&Path)->Result<(),String>{
    if st.moving_folder.lock().unwrap().as_ref().is_some_and(|root|path.starts_with(root)){
        Err("このフォルダは移動中です。完了してから開いてください".into())
    }else{Ok(())}
}
fn plan(st:&AppState,source:&str,parent:&str)->Result<(PathBuf,PathBuf),String>{
    let source=registered_dir(st,source)?;
    let parent=Path::new(parent).canonicalize().map_err(|e|e.to_string())?;
    if !parent.is_dir(){return Err("移動先の親フォルダを選んでください".into());}
    let name=source.file_name().ok_or("ドライブ全体は移動できません")?;
    if parent.starts_with(&source){return Err("自分自身や、その中には移動できません".into());}
    if st.cfg_path.canonicalize().ok().is_some_and(|p|p.starts_with(&source)) || env::current_exe().ok().and_then(|p|p.canonicalize().ok()).is_some_and(|p|p.starts_with(&source)){
        return Err("アプリ本体や設定を含むフォルダは移動できません".into());
    }
    let destination=parent.join(name);
    if fs::symlink_metadata(&destination).is_ok(){return Err("移動先に同名フォルダがあります。上書きせず中止しました".into());}
    Ok((source,destination))
}
#[tauri::command]
pub(super) fn plan_folder_move(window:WebviewWindow,state:State<'_,AppState>,source:String,parent:String)->Result<Plan,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}
    let (source,destination)=plan(&state,&source,&parent)?;
    Ok(Plan{source:source.to_string_lossy().into(),destination:destination.to_string_lossy().into()})
}
fn regular(meta:&fs::Metadata)->bool{
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return false;}}
    !meta.file_type().is_symlink()&&(meta.is_file()||meta.is_dir())
}
fn digest(path:&Path)->Result<String,String>{
    let mut f=fs::File::open(path).map_err(|e|e.to_string())?;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
    loop{let n=f.read(&mut buffer).map_err(|e|e.to_string())?;if n==0{break;}hash.update(&buffer[..n]);}
    Ok(format!("{:x}",hash.finalize()))
}
fn snapshot(root:&Path)->Result<Tree,String>{
    fn walk(root:&Path,relative:&Path,out:&mut Tree,depth:usize)->Result<(),String>{
        if depth>128{return Err("フォルダの階層が深すぎます".into());}
        let path=root.join(relative);let meta=fs::symlink_metadata(&path).map_err(|e|format!("{}: {e}",path.display()))?;
        if !regular(&meta){return Err(format!("リンクや特殊なファイルは移動できません: {}",path.display()));}
        if meta.is_dir(){out.insert(relative.to_owned(),None);for entry in fs::read_dir(&path).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;walk(root,&relative.join(entry.file_name()),out,depth+1)?;}}
        else{out.insert(relative.to_owned(),Some(digest(&path)?));}Ok(())
    }
    let mut tree=Tree::new();walk(root,Path::new(""),&mut tree,0)?;Ok(tree)
}
fn copy_times(file:&fs::File,meta:&fs::Metadata)->Result<(),String>{
    #[cfg(windows)] {
        use std::os::windows::{fs::MetadataExt,io::AsRawHandle};
        #[repr(C)] struct FileTime {low:u32,high:u32}
        impl From<u64> for FileTime{fn from(v:u64)->Self{Self{low:v as u32,high:(v>>32)as u32}}}
        #[link(name="kernel32")] unsafe extern "system"{fn SetFileTime(handle:*mut std::ffi::c_void,created:*const FileTime,accessed:*const FileTime,modified:*const FileTime)->i32;}
        let created=FileTime::from(meta.creation_time());let accessed=FileTime::from(meta.last_access_time());let modified=FileTime::from(meta.last_write_time());
        if unsafe{SetFileTime(file.as_raw_handle(),&created,&accessed,&modified)}==0{return Err(std::io::Error::last_os_error().to_string());}
    }
    #[cfg(not(windows))] {let mut times=fs::FileTimes::new();if let Ok(t)=meta.modified(){times=times.set_modified(t);}file.set_times(times).map_err(|e|e.to_string())?;}
    Ok(())
}
fn copy_tree(source:&Path,target:&Path,tree:&Tree)->Result<(),String>{
    for (relative,hash) in tree{
        if relative.as_os_str().is_empty(){continue;}
        let from=source.join(relative);let to=target.join(relative);
        if hash.is_none(){fs::create_dir(&to).map_err(|e|e.to_string())?;continue;}
        let meta=fs::symlink_metadata(&from).map_err(|e|e.to_string())?;
        if !regular(&meta)||!meta.is_file(){return Err("移動中にファイルの種類が変わりました".into());}
        let mut input=fs::File::open(&from).map_err(|e|e.to_string())?;
        let mut output=fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|e|e.to_string())?;
        std::io::copy(&mut input,&mut output).map_err(|e|e.to_string())?;
        copy_times(&output,&meta)?;output.sync_all().map_err(|e|e.to_string())?;
        fs::set_permissions(&to,meta.permissions()).map_err(|e|e.to_string())?;
    }Ok(())
}
fn mapped(path:&str,old:&Path,new:&Path)->String{
    let value=Path::new(path);
    let rewrite=|rest:&Path|if rest.as_os_str().is_empty(){new.to_string_lossy().into_owned()}else{new.join(rest).to_string_lossy().into_owned()};
    for prefix in [old.to_owned(),PathBuf::from(shell_path(old))]{
        if let Ok(rest)=value.strip_prefix(&prefix){return rewrite(rest);}
    }
    value.canonicalize().ok().and_then(|p|p.strip_prefix(old).ok().map(rewrite)).unwrap_or_else(||path.into())
}
fn retarget(cfg:&mut Config,old:&Path,new:&Path){
    for folder in cfg.folders.iter_mut().chain(cfg.removed_folders.iter_mut()){folder.path=mapped(&folder.path,old,new);}
    cfg.notes=std::mem::take(&mut cfg.notes).into_iter().map(|(path,mut note)|{
        if let Some(parent)=&mut note.parent_note{*parent=mapped(parent,old,new);}
        for member in &mut note.family_order{*member=mapped(member,old,new);}
        (mapped(&path,old,new),note)
    }).collect();
}
fn clean_source(root:&Path,tree:&Tree)->Result<(),String>{
    if snapshot(root)?!=*tree{return Err("元フォルダに別の変更があったため、元のデータは削除せず残しました".into());}
    for (relative,hash) in tree.iter().rev(){
        let path=root.join(relative);
        if hash.is_some(){
            let meta=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
            if !regular(&meta)||digest(&path)?!=*hash.as_ref().unwrap(){return Err("元ファイルに変更があったため削除を止めました".into());}
            #[cfg(windows)] if meta.permissions().readonly(){let mut p=meta.permissions();p.set_readonly(false);fs::set_permissions(&path,p).map_err(|e|e.to_string())?;}
            fs::remove_file(&path).map_err(|e|e.to_string())?;
        }else{fs::remove_dir(&path).map_err(|e|e.to_string())?;}
    }Ok(())
}
struct Moving<'a>(&'a AppState);
impl Drop for Moving<'_>{fn drop(&mut self){*self.0.moving_folder.lock().unwrap()=None;}}
fn relocate(st:&AppState,source:&str,parent:&str,is_open:impl Fn(&Path)->bool)->Result<Moved,String>{
    let _writer=st.writes.lock().unwrap();
    let (source,destination)=plan(st,source,parent)?;
    *st.moving_folder.lock().unwrap()=Some(source.clone());let _moving=Moving(st);
    if is_open(&source){return Err("このフォルダの付箋を保存して閉じてから移動してください".into());}
    let tree=snapshot(&source)?;
    let staging=tempfile::Builder::new().prefix(".sticky-folder-move-").tempdir_in(destination.parent().ok_or("移動先を確認してください")?).map_err(|e|e.to_string())?;
    copy_tree(&source,staging.path(),&tree)?;
    if snapshot(staging.path())?!=tree||snapshot(&source)?!=tree{return Err("コピー中にファイルが変わりました。元フォルダは変更せず中止しました".into());}
    if is_open(&source){return Err("移動中に付箋が開かれたため中止しました".into());}
    // rename cannot merge a nonempty destination. Recheck even an empty one.
    if fs::symlink_metadata(&destination).is_ok(){return Err("移動先が作成されたため上書きせず中止しました".into());}
    fs::rename(staging.path(),&destination).map_err(|e|e.to_string())?;
    let destination=destination.canonicalize().map_err(|e|e.to_string())?;
    let persist=(||->Result<(),String>{
        let _config_writer=st.config_writes.lock().unwrap();let mut cfg=st.cfg.lock().unwrap();
        if !cfg.folders.iter().any(|f|Path::new(&f.path).canonicalize().ok().as_ref()==Some(&source)){return Err("登録が変更されました".into());}
        let mut next=cfg.clone();retarget(&mut next,&source,&destination);
        let json=serde_json::to_vec_pretty(&next).map_err(|e|e.to_string())?;
        atomic_write(&st.cfg_path,&json)?;*cfg=next;Ok(())
    })();
    if let Err(e)=persist{return Err(format!("設定を保存できず、元フォルダを残しました。コピー先: {} — {e}",strip_unc(&destination.to_string_lossy())));}
    st.labels.lock().unwrap().retain(|_,path|mapped(path,&source,&destination)==*path);
    let mut tools=st.note_tools.lock().unwrap();
    for path in &mut tools.merge_paths{*path=mapped(path,&source,&destination);}
    if let Some(path)=&mut tools.layer_path{*path=mapped(path,&source,&destination);}drop(tools);
    let warning=clean_source(&source,&tree).err().map(|e|format!("移動先への切り替えは完了しました。元フォルダの整理は未完了です: {} — {e}",strip_unc(&source.to_string_lossy())));
    Ok(Moved{source:source.to_string_lossy().into(),destination:destination.to_string_lossy().into(),warning})
}
#[tauri::command]
pub(super) async fn move_registered_folder(window:WebviewWindow,source:String,parent:String)->Result<Moved,String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}
    let app=window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let st=app.state::<AppState>();
        let result=relocate(&st,&source,&parent,|root|st.labels.lock().unwrap().iter().any(|(label,path)|Path::new(path).starts_with(root)&&app.get_webview_window(label).is_some()));
        let _=app.emit("sticky-parent-changed",());result
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub(super) fn rename_folder_label(window:WebviewWindow,state:State<'_,AppState>,id:String,label:String)->Result<(),String>{
    if window.label()!="list"{return Err("付箋の一覧から操作してください".into());}
    let label=label.trim();if label.is_empty()||label.chars().count()>80{return Err("表示名は1〜80文字で入力してください".into());}
    let _writer=state.config_writes.lock().unwrap();let mut cfg=state.cfg.lock().unwrap();let mut next=cfg.clone();
    let folder=next.folders.iter_mut().find(|f|f.id==id).ok_or("登録フォルダがありません")?;
    folder.label=label.into();
    atomic_write(&state.cfg_path,&serde_json::to_vec_pretty(&next).map_err(|e|e.to_string())?)?;
    *cfg=next;Ok(())
}

#[cfg(test)] mod tests{
 use super::*;
 fn state(root:&Path,source:&Path)->AppState{
  let cfg=Config{folders:vec![FolderCfg{id:"folder-a".into(),path:source.to_string_lossy().into(),label:"My notes".into()}],..Default::default()};
  let state=AppState{cfg:Mutex::new(cfg),cfg_path:root.join("config.json"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),moving_folder:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()};
  atomic_write(&state.cfg_path,&serde_json::to_vec(&*state.cfg.lock().unwrap()).unwrap()).unwrap();state
 }
 fn fixture(root:&Path)->PathBuf{
  let p=root.join("notes");fs::create_dir_all(p.join("attachments")).unwrap();fs::create_dir(p.join(".trash")).unwrap();fs::create_dir(p.join(".git")).unwrap();
  fs::write(p.join("first.md"),b"\xef\xbb\xbf---\r\ntags: [a]\r\n---\r\n![x](attachments/image.png)\r\n").unwrap();
  fs::write(p.join("attachments/image.png"),b"synthetic-image-bytes").unwrap();
  fs::write(p.join(".trash/old.md"),b"trashed note").unwrap();fs::write(p.join(".git/config"),b"synthetic git config").unwrap();fs::write(p.join(".gitignore"),b"attachments/\n").unwrap();p.canonicalize().unwrap()
 }
 #[test] fn folder_move_verifies_all_files_and_retargets_identity_and_family_links(){
  let temp=tempfile::tempdir().unwrap();let source=fixture(temp.path());let target=temp.path().join("target");fs::create_dir(&target).unwrap();
  let st=state(temp.path(),&source);let first=source.join("first.md").to_string_lossy().into_owned();
  let before=snapshot(&source).unwrap();let meta=fs::metadata(source.join("first.md")).unwrap();
  st.cfg.lock().unwrap().notes.insert(first.clone(),NoteState{x:Some(200),pin:true,..Default::default()});
  st.cfg.lock().unwrap().notes.insert("outside.md".into(),NoteState{parent_note:Some(first.clone()),family_order:vec![first.clone()],..Default::default()});
  let result=relocate(&st,&source.to_string_lossy(),&target.to_string_lossy(),|_|false).unwrap();assert!(result.warning.is_none(),"{:?}",result.warning);
  let dest=Path::new(&result.destination);assert!(!source.exists());assert_eq!(snapshot(dest).unwrap(),before);
  let cfg=st.cfg.lock().unwrap();assert_eq!(cfg.folders[0].id,"folder-a");assert_eq!(cfg.folders[0].label,"My notes");assert_eq!(Path::new(&cfg.folders[0].path),dest);
  let new=dest.join("first.md").to_string_lossy().into_owned();assert_eq!(cfg.notes[&new].x,Some(200));assert!(cfg.notes[&new].pin);
  assert_eq!(cfg.notes["outside.md"].parent_note.as_ref(),Some(&new));assert_eq!(cfg.notes["outside.md"].family_order,vec![new]);
  assert_eq!(fs::metadata(dest.join("first.md")).unwrap().modified().unwrap(),meta.modified().unwrap());
  #[cfg(windows)] {use std::os::windows::fs::MetadataExt;assert_eq!(fs::metadata(dest.join("first.md")).unwrap().creation_time(),meta.creation_time());}
  assert_eq!(load_cfg(&st.cfg_path).folders[0].id,"folder-a");assert!(st.moving_folder.lock().unwrap().is_none());
 }
 #[test] fn collision_nested_destination_and_open_notes_leave_originals_untouched(){
  let temp=tempfile::tempdir().unwrap();let source=fixture(temp.path());let st=state(temp.path(),&source);let before=snapshot(&source).unwrap();
  assert!(relocate(&st,&source.to_string_lossy(),&source.join("attachments").to_string_lossy(),|_|false).is_err());
  let parent=temp.path().join("other");fs::create_dir_all(parent.join("notes")).unwrap();fs::write(parent.join("notes/keep"),b"keep").unwrap();
  assert!(relocate(&st,&source.to_string_lossy(),&parent.to_string_lossy(),|_|false).is_err());assert_eq!(fs::read(parent.join("notes/keep")).unwrap(),b"keep");
  fs::create_dir(temp.path().join("empty-target")).unwrap();
  assert!(relocate(&st,&source.to_string_lossy(),&temp.path().join("empty-target").to_string_lossy(),|_|true).is_err());
  assert_eq!(snapshot(&source).unwrap(),before);assert!(st.moving_folder.lock().unwrap().is_none());
 }
 #[test] fn config_save_failure_keeps_originals_and_old_registration(){
  let temp=tempfile::tempdir().unwrap();let source=fixture(temp.path());let parent=temp.path().join("other");fs::create_dir(&parent).unwrap();
  let mut st=state(temp.path(),&source);st.cfg_path=temp.path().join("directory-not-config");fs::create_dir(&st.cfg_path).unwrap();
  let before=snapshot(&source).unwrap();assert!(relocate(&st,&source.to_string_lossy(),&parent.to_string_lossy(),|_|false).is_err());
  assert_eq!(snapshot(&source).unwrap(),before);assert_eq!(snapshot(&parent.join("notes")).unwrap(),before);
  assert_eq!(st.cfg.lock().unwrap().folders[0].path,source.to_string_lossy());assert!(st.moving_folder.lock().unwrap().is_none());
 }
 #[test] fn legacy_non_namespace_registration_is_retargeted_before_original_is_removed(){
  let temp=tempfile::tempdir().unwrap();let source=fixture(temp.path());let parent=temp.path().join("other");fs::create_dir(&parent).unwrap();let st=state(temp.path(),&source);
  st.cfg.lock().unwrap().folders[0].path=shell_path(&source);
  let result=relocate(&st,&source.to_string_lossy(),&parent.to_string_lossy(),|_|false).unwrap();
  assert!(!source.exists());assert_eq!(st.cfg.lock().unwrap().folders[0].path,result.destination);assert_eq!(load_cfg(&st.cfg_path).folders[0].path,result.destination);
 }
 #[test] fn old_folder_registration_gets_a_stable_id_without_changing_paths_or_labels(){
  let temp=tempfile::tempdir().unwrap();let path=temp.path().join("config.json");
  fs::write(&path,r#"{"folders":[{"path":"notes","label":"Work"},{"path":"elsewhere/notes","label":"Personal"}]}"#).unwrap();
  let cfg=load_cfg(&path);assert!(!cfg.folders[0].id.is_empty());assert_ne!(cfg.folders[0].id,cfg.folders[1].id);
  atomic_write(&path,&serde_json::to_vec(&cfg).unwrap()).unwrap();let mut again=load_cfg(&path);assert_eq!(again.folders[0].id,cfg.folders[0].id);assert_eq!(again.folders[0].label,"Work");
  let id=again.folders[0].id.clone();again.unregister_folder("notes");let removed=again.removed_folders[0].clone();again.register_folder(removed);assert!(again.folders.iter().any(|f|f.id==id&&f.path=="notes"));
 }
}
