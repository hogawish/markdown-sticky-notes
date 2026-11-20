use super::*;

fn encode(value:&str)->String{
    value.bytes().map(|b|if b.is_ascii_alphanumeric()||b"-_.~".contains(&b){(b as char).to_string()}else{format!("%{b:02X}")}).collect()
}
fn decode(value:&str)->Result<String,String>{
    let mut bytes=vec![];let mut iter=value.bytes();while let Some(b)=iter.next(){
        if b==b'%'{let a=iter.next().and_then(|b|(b as char).to_digit(16));let c=iter.next().and_then(|b|(b as char).to_digit(16));match (a,c){(Some(a),Some(c))=>bytes.push((a*16+c)as u8),_=>return Err("リンクの文字コードを確認してください".into())}}
        else{bytes.push(b);}
    }String::from_utf8(bytes).map_err(|_|"リンクはUTF-8で指定してください".into())
}
fn leaf(value:&str)->Result<String,String>{
    let value=decode(value)?;let value=value.strip_prefix("./").unwrap_or(&value);
    if value.is_empty()||value.contains(['/', '\\', ':','\0','?','#'])||value.chars().any(char::is_control)||!value.ends_with(".md")||value.trim()!=value||value.ends_with([' ','.']){
        return Err("登録フォルダ内の付箋の相対パスを指定してください".into());
    }Ok(value.into())
}
fn folder_for(st:&AppState,path:&Path)->Result<FolderCfg,String>{
    st.cfg.lock().unwrap().folders.iter().find(|f|Path::new(&f.path).canonicalize().ok().as_deref()==path.parent()).cloned().ok_or("付箋の登録フォルダがありません".into())
}
pub(super) fn resolve(st:&AppState,origin:&Path,uri:&str)->Result<PathBuf,String>{
    let path=if let Some(value)=uri.strip_prefix("sticky-note://"){
        let (id,name)=value.split_once('/').ok_or("付箋リンクの形式を確認してください")?;let id=decode(id)?;let name=leaf(name)?;
        let folders=st.cfg.lock().unwrap().folders.clone();let mut found=vec![];
        for f in folders{if folder_identity::ids(Path::new(&f.path),&f.id).is_ok_and(|ids|ids.contains(&id)){found.push(f);}}
        if found.len()!=1{return Err(if found.is_empty(){"リンク先のフォルダが未登録、または見つかりません"}else{"同じIDのフォルダが複数あります。登録先を確認してください"}.into());}
        registered_dir(st,&found[0].path)?.join(name)
    }else{let folder=folder_for(st,origin)?;registered_dir(st,&folder.path)?.join(leaf(uri)?)};
    checked(st,&path.to_string_lossy())
}
fn origin(window:&WebviewWindow,st:&AppState,path:Option<String>)->Result<PathBuf,String>{
    let path=if window.label()=="list"{path.ok_or("リンク元の付箋を指定してください")?}
        else if window.label().starts_with("note-"){path_of_window(st,window)?}
        else{return Err("付箋または一覧から操作してください".into());};checked(st,&path)
}
#[tauri::command]
pub(super) fn note_link(window:WebviewWindow,state:State<'_,AppState>,path:Option<String>)->Result<String,String>{
    let path=origin(&window,&state,path)?;let folder=folder_for(&state,&path)?;
    folder_identity::ensure(Path::new(&folder.path),&folder.id)?;
    let text=read_snapshot(&path)?.0;let(front,body)=split_front(&text);let title=note_metadata(front).title.unwrap_or_else(||title_of(body));
    let title=title.replace('\\',"\\\\").replace('[',"\\[").replace(']',"\\]").replace(['\r','\n']," ");
    Ok(format!("[{title}](sticky-note://{}/{})",encode(&folder.id),encode(&path.file_name().ok_or("ファイル名がありません")?.to_string_lossy())))
}
#[tauri::command]
pub(super) async fn open_note_link(window:WebviewWindow,state:State<'_,AppState>,uri:String,source:Option<String>)->Result<(),String>{
    let source=origin(&window,&state,source)?;let path=resolve(&state,&source,&uri)?;let app=window.app_handle().clone();
    // Windows WebView creation must not block the IPC/UI thread.
    tauri::async_runtime::spawn_blocking(move||open_window(&app,&path,true)).await.map_err(|e|e.to_string())?
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn links_encode_unicode_spaces_and_reject_escape_paths(){
  assert_eq!(leaf(&encode("日本語 (a).md")).unwrap(),"日本語 (a).md");assert_eq!(leaf("./test.md").unwrap(),"test.md");
  for bad in ["../other.md","%2e%2e%2fother.md","/x.md","C:x.md","x%00.md","x.md/..","file:///x.md","x.md:stream.md","x.md ","%xx"]{assert!(leaf(bad).is_err(),"{bad}");}
 }
 #[test]fn ids_and_relative_paths_resolve_only_within_registered_note_roots(){
  let temp=tempfile::tempdir().unwrap();let a=temp.path().join("a");let b=temp.path().join("b");fs::create_dir(&a).unwrap();fs::create_dir(&b).unwrap();let a=a.canonicalize().unwrap();let b=b.canonicalize().unwrap();
  folder_identity::ensure(&a,"a").unwrap();folder_identity::ensure(&b,"b").unwrap();fs::write(a.join("one.md"),"one").unwrap();fs::write(a.join("two.md"),"two").unwrap();fs::write(b.join("日本語 (a).md"),"three").unwrap();
  let st=AppState{cfg:Mutex::new(Config{folders:vec![FolderCfg{id:"a".into(),path:a.to_string_lossy().into(),label:"same".into()},FolderCfg{id:"b".into(),path:b.to_string_lossy().into(),label:"same".into()}],..Default::default()}),cfg_path:temp.path().join("cfg"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),moving_folder:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()};
  assert_eq!(resolve(&st,&a.join("one.md"),"two.md").unwrap(),a.join("two.md"));assert_eq!(resolve(&st,&a.join("one.md"),&format!("sticky-note://b/{}",encode("日本語 (a).md"))).unwrap(),b.join("日本語 (a).md"));
  assert!(resolve(&st,&a.join("one.md"),"sticky-note://missing/two.md").is_err());
  let marker=folder_identity::merged_marker(&b,"b",vec!["old-b".into()]).unwrap();atomic_write(&b.join(folder_identity::MARKER),&marker).unwrap();
  assert_eq!(resolve(&st,&a.join("one.md"),&format!("sticky-note://old-b/{}",encode("日本語 (a).md"))).unwrap(),b.join("日本語 (a).md"));
 }
}
