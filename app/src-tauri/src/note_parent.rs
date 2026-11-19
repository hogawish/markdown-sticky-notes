use super::*;

#[derive(Default)]
pub(super) struct Tools { pub parent_pick: Option<String>, pub merge_paths: Vec<String> }

fn validate_parent(cfg: &Config, child: &str, parent: &str) -> Result<(), String> {
    if child == parent { return Err("別の付箋を親に選んでください".into()); }
    if cfg.notes.get(parent).is_some_and(|n|n.parent_note.is_some()) { return Err("子の付箋は親にできません。まず親子付けを解除してください".into()); }
    if cfg.notes.values().any(|n|n.parent_note.as_deref()==Some(child)) { return Err("子を持つ付箋を、別の付箋の子にはできません".into()); }
    Ok(())
}

pub(super) fn attach_to(app:&AppHandle,state:&AppState,child:&str,parent:&str)->Result<(),String>{
    checked(state,child)?;checked(state,parent)?;
    let child_window=app.get_webview_window(&label_for(child)).ok_or("元の付箋が閉じられています")?;
    let pin={let mut cfg=state.cfg.lock().unwrap();validate_parent(&cfg,child,parent)?;
        let note=cfg.notes.entry(child.into()).or_default();note.parent_note=Some(parent.into());note.attachment=None;note.attachment_order=0;note.pin};
    if let Ok(h)=child_window.hwnd(){follow::detach(h.0 as usize,pin);}
    mark_dirty(state);app.emit("sticky-parent-changed",()).map_err(|e|e.to_string())
}

pub(super) fn family(cfg:&Config,path:&str)->(String,String){
    let parent=cfg.notes.get(path).and_then(|n|n.parent_note.clone()).or_else(||cfg.notes.values().any(|n|n.parent_note.as_deref()==Some(path)).then(||path.to_owned()));
    parent.map(|p|{let title=read_snapshot(Path::new(&p)).ok().map(|v|note_metadata(split_front(&v.0).0).title.unwrap_or_else(||title_of(split_front(&v.0).1))).unwrap_or_else(||"親の付箋".into());(p,title)}).unwrap_or_default()
}

#[tauri::command]
pub(super) fn set_note_family(window:WebviewWindow,state:State<'_,AppState>,paths:Vec<String>,parent:Option<String>)->Result<(),String>{
    if window.label()!="list"{return Err("一覧から操作してください".into());}
    let paths=paths.iter().map(|p|checked(&state,p).map(|p|p.to_string_lossy().into_owned())).collect::<Result<Vec<_>,_>>()?;
    let parent=parent.map(|p|checked(&state,&p).map(|p|p.to_string_lossy().into_owned())).transpose()?;
    if parent.as_ref().is_some_and(|p|!paths.contains(p)){return Err("選択した付箋から親を選んでください".into());}
    let mut changed=Vec::new();
    {let mut cfg=state.cfg.lock().unwrap();
     if let Some(parent)=&parent{for child in &paths{if child!=parent{validate_parent(&cfg,child,parent)?;}}}
     for path in paths{if parent.as_ref()==Some(&path){continue;}let note=cfg.notes.entry(path.clone()).or_default();note.parent_note=parent.clone();if parent.is_some(){note.attachment=None;note.attachment_order=0;changed.push((path,note.pin));}}
    }
    for (path,pin) in changed{if let Some(w)=window.app_handle().get_webview_window(&label_for(&path)){if let Ok(h)=w.hwnd(){follow::detach(h.0 as usize,pin);}}}
    mark_dirty(&state);window.app_handle().emit("sticky-parent-changed",()).map_err(|e|e.to_string())
}

#[tauri::command]
pub(super) fn begin_note_parent_pick(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let child = path_of_window(&state,&window)?;
    state.note_tools.lock().unwrap().parent_pick = Some(child.clone());
    window.app_handle().emit("sticky-parent-pick",Some(child)).map_err(|e|e.to_string())
}

#[tauri::command]
pub(super) fn cancel_note_parent_pick(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    path_of_window(&state,&window)?;
    state.note_tools.lock().unwrap().parent_pick = None;
    window.app_handle().emit("sticky-parent-pick",Option::<String>::None).map_err(|e|e.to_string())
}

#[tauri::command]
pub(super) fn attach_note_parent(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let parent = path_of_window(&state,&window)?;
    let child = state.note_tools.lock().unwrap().parent_pick.clone().ok_or("親の選択を始めてください")?;
    checked(&state,&child)?;
    let child_window = window.app_handle().get_webview_window(&label_for(&child)).ok_or("元の付箋が閉じられています")?;
    let pin;
    {
        let mut cfg=state.cfg.lock().unwrap();validate_parent(&cfg,&child,&parent)?;
        let item=cfg.notes.entry(child.clone()).or_default();item.parent_note=Some(parent);item.attachment=None;item.attachment_order=0;pin=item.pin;
    }
    if let Ok(hwnd)=child_window.hwnd(){follow::detach(hwnd.0 as usize,pin);}
    state.note_tools.lock().unwrap().parent_pick=None;
    mark_dirty(&state);
    window.app_handle().emit("sticky-parent-pick",Option::<String>::None).map_err(|e|e.to_string())?;
    window.app_handle().emit("sticky-parent-changed",()).map_err(|e|e.to_string())
}

#[tauri::command]
pub(super) fn detach_note_parent(window: WebviewWindow,state: State<'_,AppState>)->Result<(),String>{
    let child=path_of_window(&state,&window)?;
    if let Some(note)=state.cfg.lock().unwrap().notes.get_mut(&child){note.parent_note=None;}
    mark_dirty(&state);window.app_handle().emit("sticky-parent-changed",()).map_err(|e|e.to_string())
}

#[derive(Serialize)] pub(super) struct ParentInfo {path:String,title:String}
#[tauri::command]
pub(super) fn get_note_parent(window:WebviewWindow,state:State<'_,AppState>)->Result<Option<ParentInfo>,String>{
    let child=path_of_window(&state,&window)?;
    let parent=state.cfg.lock().unwrap().notes.get(&child).and_then(|n|n.parent_note.clone());
    Ok(parent.map(|path|{let title=read_snapshot(Path::new(&path)).ok().map(|v|note_metadata(split_front(&v.0).0).title.unwrap_or_else(||title_of(split_front(&v.0).1))).unwrap_or_else(||"親の付箋".into());ParentInfo{path,title}}))
}

// Child positions are also kept when closed. Dragging a child changes only its own position.
pub(super) fn moved(cfg:&mut Config,parent:&str,x:i32,y:i32)->Vec<(String,i32,i32)>{
    let previous=cfg.notes.get(parent).and_then(|n|Some((n.x?,n.y?)));
    let item=cfg.notes.entry(parent.into()).or_default();item.x=Some(x);item.y=Some(y);
    let Some((old_x,old_y))=previous else{return vec![]};
    let dx=x.saturating_sub(old_x);let dy=y.saturating_sub(old_y);
    if dx==0&&dy==0{return vec![];}
    cfg.notes.iter_mut().filter_map(|(path,n)|{
        if n.parent_note.as_deref()!=Some(parent){return None;}
        let nx=n.x?.saturating_add(dx);let ny=n.y?.saturating_add(dy);n.x=Some(nx);n.y=Some(ny);Some((path.clone(),nx,ny))
    }).collect()
}

#[tauri::command]
pub(super) async fn open_selected_merge(window:WebviewWindow,state:State<'_,AppState>)->Result<(),String>{
    path_of_window(&state,&window)?;
    if let Some(existing)=window.app_handle().get_webview_window("merge-notes"){existing.set_focus().map_err(|e|e.to_string())?;return Ok(());}
    let members=state.drag_group.lock().unwrap().members.clone();
    if !members.iter().any(|s|s==window.label()) || members.len()<2{return Err("Shiftクリックで付箋を2枚以上選んでください".into());}
    let labels=state.labels.lock().unwrap();
    let paths=members.iter().filter_map(|l|labels.get(l).cloned()).collect::<Vec<_>>();drop(labels);
    if paths.len()<2{return Err("選択した付箋を確認してください".into());}
    state.note_tools.lock().unwrap().merge_paths=paths;
    let app=window.app_handle();
    if let Some(existing)=app.get_webview_window("merge-notes"){let _=existing.set_focus();existing.emit("sticky-merge-start",()).map_err(|e|e.to_string())?;}
    else{WebviewWindowBuilder::new(app,"merge-notes",WebviewUrl::App("merge.html".into())).title("付箋を1枚にまとめる").inner_size(480.0,520.0).min_inner_size(360.0,360.0).center().build().map_err(|e|e.to_string())?;}
    Ok(())
}

#[tauri::command]
pub(super) fn selected_merge_paths(window:WebviewWindow,state:State<'_,AppState>)->Result<Vec<String>,String>{
    if window.label()!="merge-notes"{return Err("merge画面から操作してください".into());}
    Ok(state.note_tools.lock().unwrap().merge_paths.clone())
}

#[cfg(test)] mod tests{
 use super::*;
 #[test] fn parent_moves_children_but_child_can_adjust_its_offset(){
  let mut cfg=Config::default();cfg.notes.insert("p".into(),NoteState{x:Some(100),y:Some(100),..Default::default()});cfg.notes.insert("c".into(),NoteState{x:Some(130),y:Some(160),parent_note:Some("p".into()),..Default::default()});
  assert_eq!(moved(&mut cfg,"p",120,130),vec![("c".into(),150,190)]);assert!(moved(&mut cfg,"c",180,200).is_empty());assert_eq!(moved(&mut cfg,"p",130,140),vec![("c".into(),190,210)]);
  assert!(validate_parent(&cfg,"p","c").is_err());assert!(validate_parent(&cfg,"p","p").is_err());
  let loaded:Config=serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();assert_eq!(loaded.notes["c"].parent_note.as_deref(),Some("p"));
 }
 #[test] fn unlink_keeps_child_geometry_and_only_removes_links(){
  let mut child=NoteState{parent_note:Some("p".into()),x:Some(123),y:Some(234),pin:true,..Default::default()};
  assert_eq!(child.clear_links(),(true,false));assert_eq!(child.parent_note,None);assert_eq!((child.x,child.y,child.pin),(Some(123),Some(234),true));assert_eq!(child.clear_links(),(false,false));
 }
}
