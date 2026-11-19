use super::*;

#[derive(Default)]
pub(super) struct Tools { pub parent_pick: Option<String>, pub merge_paths: Vec<String> }

fn validate_parent(cfg: &Config, child: &str, parent: &str) -> Result<(), String> {
    if child == parent { return Err("別の付箋を親に選んでください".into()); }
    let mut seen=std::collections::HashSet::new();
    let mut current=parent;
    loop {
        if current==child || !seen.insert(current) { return Err("付箋の親子関係が循環するため貼り付けられません".into()); }
        match cfg.notes.get(current).and_then(|n|n.parent_note.as_deref()) {
            Some(next)=>current=next,
            None=>return Ok(()),
        }
    }
}

pub(super) fn root(cfg:&Config,path:&str)->Option<String>{
    let mut seen=std::collections::HashSet::new();let mut current=path;
    while seen.insert(current){
        match cfg.notes.get(current)?.parent_note.as_deref(){Some(parent)=>current=parent,None=>return Some(current.into())}
    }
    None
}

// Parents are placed first so every descendant inherits the current native Z band.
pub(super) fn ordered_links(cfg:&Config)->Vec<(String,String)>{
    let mut links=Vec::new();
    for (path,note) in &cfg.notes {
        let Some(parent)=note.parent_note.as_ref() else{continue};
        let mut current=path.as_str();let mut seen=std::collections::HashSet::new();let mut depth=0;
        while let Some(next)=cfg.notes.get(current).and_then(|n|n.parent_note.as_deref()){
            if !seen.insert(current){break;}depth+=1;current=next;
        }
        if root(cfg,path).is_some(){links.push((depth,path.clone(),parent.clone()));}
    }
    links.sort_by(|a,b|(a.0,&a.1).cmp(&(b.0,&b.1)));
    links.into_iter().map(|(_,child,parent)|(child,parent)).collect()
}

/// Place a complete subtree before moving on to its next sibling/root.
/// Each band has a running front anchor, so siblings never displace each other
/// by repeatedly requesting the same immediate position above their parent.
pub(super) struct Layers<'a>{
    app:&'a AppHandle,
    children:HashMap<String,Vec<String>>,
    pins:HashMap<String,bool>,
    pub visited:HashSet<String>,
    pub followed:HashSet<String>,
}
impl<'a> Layers<'a>{
    pub fn new(app:&'a AppHandle,cfg:&Config)->Self{
        let mut children:HashMap<String,Vec<String>>=HashMap::new();
        for (child,parent) in ordered_links(cfg){children.entry(parent).or_default().push(child);}
        // Preserve the former effective sibling order: lower paths in front.
        for siblings in children.values_mut(){siblings.sort_by(|a,b|b.cmp(a));}
        Self{app,children,pins:cfg.notes.iter().map(|(p,n)|(p.clone(),n.pin)).collect(),visited:HashSet::new(),followed:HashSet::new()}
    }
    pub fn follow(&mut self,parent:&str,parent_hwnd:usize,target:usize,pin:bool,anchors:&mut HashMap<(usize,bool),usize>){
        if !self.visited.insert(parent.into()){return;}
        for child in self.children.get(parent).cloned().unwrap_or_default(){
            let Some(window)=self.app.get_webview_window(&label_for(&child)) else{continue};
            let Ok(h)=window.hwnd() else{continue};let hwnd=h.0 as usize;
            let own_pin=self.pins.get(&child).copied().unwrap_or(false);
            let child_pin=pin||own_pin;
            self.followed.insert(child.clone());
            if !follow::available(parent_hwnd)&&!own_pin {follow::hide(hwnd);}
            else if let Some(r)=follow::rect(hwnd){
                let anchor=anchors.entry((target,child_pin)).or_insert(if child_pin{0}else{parent_hwnd});
                follow::place_note(hwnd,*anchor,parent_hwnd,(r.left,r.top),child_pin);
                *anchor=hwnd;
            }
            self.follow(&child,hwnd,target,child_pin,anchors);
        }
    }
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
    let parent=root(cfg,path).filter(|root|root!=path||cfg.notes.values().any(|n|n.parent_note.as_deref()==Some(path)));
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
    moved_excluding(cfg,parent,x,y,&Default::default())
}

pub(super) fn moved_excluding(cfg:&mut Config,parent:&str,x:i32,y:i32,independent:&std::collections::HashSet<String>)->Vec<(String,i32,i32)>{
    let previous=cfg.notes.get(parent).and_then(|n|Some((n.x?,n.y?)));
    let item=cfg.notes.entry(parent.into()).or_default();item.x=Some(x);item.y=Some(y);
    let Some((old_x,old_y))=previous else{return vec![]};
    let dx=x.saturating_sub(old_x);let dy=y.saturating_sub(old_y);
    if dx==0&&dy==0{return vec![];}
    let mut descendants=std::collections::HashSet::new();let mut frontier=vec![parent.to_owned()];
    while let Some(ancestor)=frontier.pop(){
        for (path,note) in &cfg.notes {
            if path!=parent&&!independent.contains(path)&&note.parent_note.as_deref()==Some(&ancestor)&&descendants.insert(path.clone()){frontier.push(path.clone());}
        }
    }
    cfg.notes.iter_mut().filter_map(|(path,n)|{
        if !descendants.contains(path){return None;}
        let nx=n.x?.saturating_add(dx);let ny=n.y?.saturating_add(dy);n.x=Some(nx);n.y=Some(ny);Some((path.clone(),nx,ny))
    }).collect()
}

pub(super) fn retarget(cfg:&mut Config,previous:&str,next:Option<&str>){
    for note in cfg.notes.values_mut(){
        if note.parent_note.as_deref()==Some(previous){note.parent_note=next.map(str::to_owned);}
    }
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
 #[test] fn nested_parenting_moves_subtree_and_rejects_cycles(){
  let mut cfg=Config::default();
  for (path,parent,x) in [("p",None,10),("c",Some("p"),30),("g",Some("c"),50)]{
   cfg.notes.insert(path.into(),NoteState{x:Some(x),y:Some(x+10),parent_note:parent.map(str::to_owned),..Default::default()});
  }
  assert_eq!(root(&cfg,"g"),Some("p".into()));
  assert!(validate_parent(&cfg,"new","g").is_ok());
  assert!(validate_parent(&cfg,"p","g").is_err());
  assert!(validate_parent(&cfg,"c","g").is_err());
  assert_eq!(ordered_links(&cfg),vec![("c".into(),"p".into()),("g".into(),"c".into())]);
  assert_eq!(moved(&mut cfg,"p",20,30).len(),2);
  assert_eq!((cfg.notes["g"].x,cfg.notes["g"].y),(Some(60),Some(70)));
  assert_eq!(moved(&mut cfg,"c",45,60),vec![("g".into(),65,80)]);
  assert_eq!((cfg.notes["p"].x,cfg.notes["p"].y),(Some(20),Some(30)));
  assert!(moved(&mut cfg,"g",100,120).is_empty());
  // Already updated descendants do not move twice when native Moved callbacks arrive.
  assert!(moved(&mut cfg,"c",45,60).is_empty());
  cfg.notes.get_mut("c").unwrap().parent_note=None;
  assert_eq!(root(&cfg,"g"),Some("c".into()));
  assert!(moved(&mut cfg,"p",30,40).is_empty());
 }
 #[test] fn child_click_promotes_the_external_root_and_invalid_cycles_stop(){
  let mut cfg=Config::default();
  cfg.notes.insert("p".into(),NoteState{attachment:Some(follow::Binding{target:follow::Target{hwnd:1,pid:2,born:"fixture".into(),title:"Fixture".into()},right:0,top:0}),..Default::default()});
  cfg.notes.insert("c".into(),NoteState{parent_note:Some("p".into()),..Default::default()});
  cfg.notes.insert("g".into(),NoteState{parent_note:Some("c".into()),..Default::default()});
  assert!(cfg.promote_attachment("g").is_some());
  assert_eq!(cfg.notes["p"].attachment_order,1);
  cfg.notes.get_mut("p").unwrap().parent_note=Some("g".into());
  assert!(root(&cfg,"g").is_none());assert!(ordered_links(&cfg).is_empty());
 }
 #[test] fn selected_subtrees_move_once_in_either_event_order(){
  for child_first in [false,true]{
   let mut cfg=Config::default();
   for (path,parent,x) in [("p",None,10),("c",Some("p"),30),("g",Some("c"),50)]{
    cfg.notes.insert(path.into(),NoteState{x:Some(x),y:Some(x),parent_note:parent.map(str::to_owned),..Default::default()});
   }
   let selected=HashSet::from(["p".into(),"c".into()]);
   if child_first{moved_excluding(&mut cfg,"c",40,40,&selected);}
   assert!(moved_excluding(&mut cfg,"p",20,20,&selected).is_empty());
   if !child_first{moved_excluding(&mut cfg,"c",40,40,&selected);}
   assert_eq!((cfg.notes["p"].x,cfg.notes["c"].x,cfg.notes["g"].x),(Some(20),Some(40),Some(60)));
  }
 }
 #[test] fn moving_and_trashing_a_parent_retargets_only_its_direct_children(){
  let base=Path::new(env!("CARGO_MANIFEST_DIR")).join("target");fs::create_dir_all(&base).unwrap();
  let fixture=tempfile::tempdir_in(base).unwrap();let a=fixture.path().join("a");let b=fixture.path().join("b");
  fs::create_dir(&a).unwrap();fs::create_dir(&b).unwrap();
  for name in ["parent","child","grand"]{fs::write(a.join(format!("{name}.md")),format!("{name} body")).unwrap();}
  let key=|name:&str|a.join(format!("{name}.md")).canonicalize().unwrap().to_string_lossy().into_owned();
  let parent=key("parent");let child=key("child");let grand=key("grand");
  let mut cfg=Config::default();
  for dir in [&a,&b]{cfg.folders.push(FolderCfg{path:dir.canonicalize().unwrap().to_string_lossy().into_owned(),label:"fixture".into()});}
  cfg.notes.insert(parent.clone(),NoteState::default());
  cfg.notes.insert(child.clone(),NoteState{parent_note:Some(parent.clone()),x:Some(123),y:Some(234),..Default::default()});
  cfg.notes.insert(grand.clone(),NoteState{parent_note:Some(child.clone()),..Default::default()});
  let state=AppState{cfg:Mutex::new(cfg),cfg_path:fixture.path().join("config.json"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()};
  let revision=read_snapshot(Path::new(&parent)).unwrap().1;
  let moved=move_note_file(&state,&parent,&b.to_string_lossy(),&revision).unwrap();
  assert_eq!(state.cfg.lock().unwrap().notes[&child].parent_note.as_deref(),Some(moved.path.as_str()));
  assert_eq!(fs::read_to_string(&moved.path).unwrap(),"parent body");assert!(!Path::new(&parent).exists());
  trash_note_file(&state,&moved.path,&moved.mtime).unwrap();
  let cfg=state.cfg.lock().unwrap();assert!(cfg.notes[&child].parent_note.is_none());assert_eq!(cfg.notes[&grand].parent_note.as_deref(),Some(child.as_str()));
  assert_eq!((cfg.notes[&child].x,cfg.notes[&child].y),(Some(123),Some(234)));
  assert!(fs::read_dir(b.join(".trash")).unwrap().next().is_some());
 }
}
