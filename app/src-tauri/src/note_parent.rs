use super::*;

#[derive(Default)]
pub(super) struct Tools { pub parent_pick: Option<String>, pub merge_paths: Vec<String>, pub layer_path: Option<String>, pub layer_focus_seen: bool, pub held_note: Option<String>, pub control_note: Option<String>, pub menu_note: Option<String> }
impl Tools {
    fn release_keys(&mut self,mouse:bool,control:bool)->Option<String>{
        if !mouse{self.held_note=None;}
        if !control{self.control_note.take()}else{None}
    }
    pub(super) fn forget_window(&mut self,label:&str)->bool{
        if self.menu_note.as_ref().is_some_and(|path|label_for(path)==label){self.menu_note=None;}
        if self.held_note.as_ref().is_some_and(|path|label_for(path)==label){self.held_note=None;}
        if self.control_note.as_ref().is_some_and(|path|label_for(path)==label){self.control_note=None;}
        if self.parent_pick.as_ref().is_some_and(|path|label_for(path)==label){self.parent_pick=None;true}else{false}
    }
}

#[tauri::command]
pub(super) fn set_note_menu_open(window:WebviewWindow,state:State<'_,AppState>,open:bool)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    {
        let mut tools=state.note_tools.lock().unwrap();
        if open{tools.menu_note=Some(path.clone());}
        else if tools.menu_note.as_deref()==Some(&path){tools.menu_note=None;}
    }
    if open{raise_family(window.app_handle(),&state,&path,window.hwnd().map_err(|e|e.to_string())?.0 as usize,false)?;}
    follow::wake();Ok(())
}

pub(super) fn release_hold(app:&AppHandle,state:&AppState){
    let cleared=state.note_tools.lock().unwrap().release_keys(follow::primary_button_down(),follow::control_only_down());
    if let Some(path)=cleared{let _=app.emit_to(label_for(&path),"sticky-control-held",false);}
}
pub(super) fn hold_control(app:&AppHandle,state:&AppState,path:&str,control:bool){
    let previous={let mut tools=state.note_tools.lock().unwrap();let old=tools.control_note.take();if control{tools.control_note=Some(path.into());}old};
    if let Some(old)=previous.filter(|p|!control||p!=path){let _=app.emit_to(label_for(&old),"sticky-control-held",false);}
    if control{let _=app.emit_to(label_for(path),"sticky-control-held",true);}
}

#[tauri::command]
pub(super) fn end_note_hold(window:WebviewWindow,state:State<'_,AppState>)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    if !follow::primary_button_down(){
        let mut tools=state.note_tools.lock().unwrap();
        if tools.held_note.as_deref()==Some(&path){tools.held_note=None;}
    }
    follow::wake();Ok(())
}

// Reuse the existing foreground/geometry worker: a note and its layer editor
// form one editing surface, even while the editor itself is not focused.
pub(super) fn watch_layer_focus(app:&AppHandle,state:&AppState){
    let Some(editor)=app.get_webview_window("layer-order") else{
        state.note_tools.lock().unwrap().layer_focus_seen=false;return;
    };
    let foreground=follow::foreground();if foreground==0{return;}
    let inside=app.webview_windows().iter().any(|(label,w)|
        (label=="layer-order"||label.starts_with("note-"))&&w.hwnd().is_ok_and(|h|h.0 as usize==foreground));
    let dismiss={let mut tools=state.note_tools.lock().unwrap();
        if inside{tools.layer_focus_seen=true;false}
        else{std::mem::take(&mut tools.layer_focus_seen)}
    };
    if dismiss{let _=editor.emit("sticky-layer-outside",());}
}

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
#[cfg(test)]
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

/// Front-to-back order is independent of movement parentage.
fn stack_order(cfg:&Config, family_root:&str)->Vec<String>{
    fn visit(cfg:&Config,path:&str,out:&mut Vec<String>){
        out.push(path.to_owned());
        let mut children:Vec<_>=cfg.notes.iter().filter(|(_,n)|n.parent_note.as_deref()==Some(path)).map(|(p,_)|p.clone()).collect();
        children.sort_by(|a,b|b.cmp(a));
        for child in children {visit(cfg,&child,out);}
    }
    if root(cfg,family_root).is_none(){return vec![];}
    let mut defaults=Vec::new();visit(cfg,family_root,&mut defaults);defaults.reverse();
    let saved=cfg.notes.get(family_root).map(|n|n.family_order.as_slice()).unwrap_or_default();
    if saved.is_empty(){return defaults;}
    let mut result=Vec::new();
    for p in saved{if defaults.contains(p)&&!result.contains(p){result.push(p.clone());}}
    // Newly attached children go just in front of their parent. Existing rows keep their order.
    for p in defaults.iter().rev(){if !result.contains(p){
        let parent=cfg.notes.get(p).and_then(|n|n.parent_note.as_ref());
        let at=parent.and_then(|v|result.iter().position(|p|p==v)).unwrap_or(result.len());
        result.insert(at,p.clone());
    }}
    result
}

fn display_order(cfg:&Config,family_root:&str,held:Option<&str>)->Vec<String>{
    let mut order=stack_order(cfg,family_root);
    if let Some(index)=held.and_then(|p|order.iter().position(|row|row==p)){
        let row=order.remove(index);order.insert(0,row);
    }
    order
}

/// Resolve tree visibility/pin inheritance first, then place the flat stack once.
/// Every band has a running anchor, avoiding competing sibling/ancestor restacks.
pub(super) struct Layers<'a>{
    app:&'a AppHandle,
    cfg:Config,
    held:Option<String>,
    pub visited:HashSet<String>,
    pub followed:HashSet<String>,
}
impl<'a> Layers<'a>{
    pub fn new(app:&'a AppHandle,cfg:&Config)->Self{
        let state=app.state::<AppState>();
        let tools=state.note_tools.lock().unwrap();
        let held=tools.control_note.clone().or_else(||tools.held_note.clone()).or_else(||tools.menu_note.clone());
        Self{app,cfg:cfg.clone(),held,visited:HashSet::new(),followed:HashSet::new()}
    }
    pub fn follow(&mut self,parent:&str,parent_hwnd:usize,target:usize,pin:bool,anchors:&mut HashMap<(usize,bool),usize>,position:Option<(i32,i32)>,raise:bool){
        let mut entries=HashMap::<String,(usize,bool,(i32,i32))>::new();
        let available=if target==parent_hwnd{follow::available(parent_hwnd)}else{follow::available(target)};
        let translation=position.and_then(|(x,y)|follow::rect(parent_hwnd).map(|r|(x-r.left,y-r.top))).unwrap_or((0,0));
        self.collect(parent,parent_hwnd,pin,available||pin,position,translation,&mut entries);
        let family_root=root(&self.cfg,parent).unwrap_or_else(||parent.into());
        // A standalone family's own HWND is an ordering anchor, not an external
        // source of topmost state: inheriting it would latch an obsolete pin.
        let band_target=if target==parent_hwnd{0}else{target};
        let mut order=display_order(&self.cfg,&family_root,self.held.as_deref());order.reverse();
        for path in order{
            let Some((hwnd,effective_pin,xy))=entries.get(&path).copied() else{continue};
            if raise&&!anchors.contains_key(&(target,effective_pin)){
                follow::bring_note_front(hwnd,band_target,effective_pin);
                anchors.insert((target,effective_pin),hwnd);continue;
            }
            let anchor=anchors.entry((target,effective_pin)).or_insert(if target==parent_hwnd{hwnd}else if effective_pin{0}else{target});
            follow::place_note(hwnd,*anchor,band_target,xy,effective_pin);*anchor=hwnd;
        }
    }
    fn collect(&mut self,path:&str,hwnd:usize,pin:bool,visible:bool,position:Option<(i32,i32)>,translation:(i32,i32),entries:&mut HashMap<String,(usize,bool,(i32,i32))>){
        if !self.visited.insert(path.into()){return;}
        if visible {if let Some(r)=follow::rect(hwnd){entries.insert(path.into(),(hwnd,pin,position.unwrap_or((r.left.saturating_add(translation.0),r.top.saturating_add(translation.1)))));}}
        else{follow::hide(hwnd);}
        let children:Vec<_>=self.cfg.notes.iter().filter(|(_,n)|n.parent_note.as_deref()==Some(path)).map(|(p,n)|(p.clone(),n.pin)).collect();
        for (child,own_pin) in children{
            let Some(w)=self.app.get_webview_window(&label_for(&child))else{continue};let Ok(h)=w.hwnd()else{continue};
            self.followed.insert(child.clone());
            self.collect(&child,h.0 as usize,pin||own_pin,visible||own_pin,None,translation,entries);
        }
    }
}

/// User activation raises the whole visible family, never just the clicked row.
pub(super) fn raise_family(app:&AppHandle,state:&AppState,path:&str,clicked:usize,restore_minimized:bool)->Result<(),String>{
    if follow::is_picking(){return Ok(());}
    let (cfg,family,binding)={
        let mut cfg=state.cfg.lock().unwrap();
        let Some(mut family)=root(&cfg,path)else{return Ok(())};
        // A closed ancestor no longer owns its open descendant's native layer.
        if app.get_webview_window(&label_for(&family)).is_none(){
            family=path.into();
            while let Some(parent)=cfg.notes.get(&family).and_then(|n|n.parent_note.clone()){
                if app.get_webview_window(&label_for(&parent)).is_none(){break;}family=parent;
            }
        }
        let binding=cfg.notes.get(&family).and_then(|n|n.attachment.clone().map(|b|(b,n.pin)));
        let control=follow::control_only_down()||state.note_tools.lock().unwrap().control_note.as_ref().is_some_and(|p|root(&cfg,p).as_ref()==Some(&family));
        if binding.is_some()&&!control{cfg.promote_attachment(&family);mark_dirty(state);}
        (cfg.clone(),family,binding)
    };
    let Some(root_window)=app.get_webview_window(&label_for(&family))else{return Ok(())};
    let root_hwnd=root_window.hwnd().map_err(|e|e.to_string())?.0 as usize;
    let pin=cfg.notes.get(&family).is_some_and(|n|n.pin);
    let target=if let Some((binding,pin))=binding{
        if !restore_minimized&&!follow::available(binding.target.hwnd){return Ok(());}
        follow::raise_group(clicked,&binding.target,pin,restore_minimized)?;
        binding.target.hwnd
    }else{
        if stack_order(&cfg,&family).len()<2{return Ok(());}root_hwnd
    };
    Layers::new(app,&cfg).follow(&family,root_hwnd,target,pin,&mut HashMap::new(),None,true);
    Ok(())
}

#[derive(Serialize)]
pub(super) struct LayerRow{path:String,title:String,color:Option<String>,depth:usize,current:bool,open:bool,pin:bool}
#[tauri::command]
pub(super) async fn open_layer_order(window:WebviewWindow,state:State<'_,AppState>)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    {let mut tools=state.note_tools.lock().unwrap();tools.layer_path=Some(path);tools.layer_focus_seen=false;}
    let app=window.app_handle();
    if let Some(w)=app.get_webview_window("layer-order"){w.emit("sticky-layer-start",()).map_err(|e|e.to_string())?;w.set_focus().map_err(|e|e.to_string())?;}
    else{WebviewWindowBuilder::new(app,"layer-order",WebviewUrl::App("layer-order.html".into())).title("重なり順").inner_size(320.0,380.0).min_inner_size(260.0,220.0).always_on_top(true).center().build().map_err(|e|e.to_string())?;}
    Ok(())
}
fn layer_context(window:&WebviewWindow,state:&AppState)->Result<(String,String),String>{
    if window.label()!="layer-order"{return Err("重なり順の画面から操作してください".into());}
    let path=state.note_tools.lock().unwrap().layer_path.clone().ok_or("対象の付箋がありません")?;
    checked(state,&path)?;
    let family=root(&state.cfg.lock().unwrap(),&path).ok_or("親子関係が変更されています")?;
    Ok((path,family))
}
#[tauri::command]
pub(super) fn get_layer_order(window:WebviewWindow,state:State<'_,AppState>)->Result<Vec<LayerRow>,String>{
    let (current,family)=layer_context(&window,&state)?;
    let cfg=state.cfg.lock().unwrap().clone();
    stack_order(&cfg,&family).into_iter().map(|path|{
        checked(&state,&path)?;
        let (text,_)=read_snapshot(Path::new(&path))?;let (front,body)=split_front(&text);
        let title=note_metadata(front).title.unwrap_or_else(||title_of(body));
        let mut depth=0;let mut p=path.as_str();while let Some(parent)=cfg.notes.get(p).and_then(|n|n.parent_note.as_deref()){depth+=1;p=parent;}
        Ok(LayerRow{color:front_value(front,"color"),title,depth,current:path==current,open:window.app_handle().get_webview_window(&label_for(&path)).is_some(),pin:cfg.notes[&path].pin,path})
    }).collect()
}
#[tauri::command]
pub(super) fn set_layer_order(window:WebviewWindow,state:State<'_,AppState>,paths:Option<Vec<String>>)->Result<(),String>{
    let (_,family)=layer_context(&window,&state)?;
    {let mut cfg=state.cfg.lock().unwrap();
        let members=stack_order(&cfg,&family);
        if let Some(paths)=&paths{let supplied:HashSet<_>=paths.iter().collect();
            if supplied.len()!=paths.len()||paths.len()!=members.len()||members.iter().any(|p|!supplied.contains(p)){return Err("付箋の構成が変わりました。一覧を開き直してください".into());}
        }
        cfg.notes.get_mut(&family).ok_or("親の付箋がありません")?.family_order=paths.unwrap_or_default();
    }
    mark_dirty(&state);Ok(())
}

// Contract selected vertices out of the tree; unselected descendants stay together.
fn unlink_members(cfg:&mut Config,family:&str,selected:&HashSet<String>)->Result<Option<String>,String>{
    let order=stack_order(cfg,family);
    if selected.is_empty()||selected.iter().any(|p|!order.contains(p)){return Err("このグループの付箋を選んでください".into());}
    let original=cfg.clone();
    let parent_after=|path:&str|{
        let mut parent=original.notes.get(path).and_then(|n|n.parent_note.clone());
        while let Some(p)=parent.as_ref(){if !selected.contains(p){break;}parent=original.notes.get(p).and_then(|n|n.parent_note.clone());}
        parent
    };
    let remaining:Vec<_>=order.iter().filter(|p|!selected.contains(*p)).cloned().collect();
    let next_root=remaining.iter().rev().find(|p|parent_after(p).is_none()).cloned();
    for path in &remaining{
        let parent=if next_root.as_ref()==Some(path){None}else{parent_after(path).or_else(||next_root.clone())};
        cfg.notes.get_mut(path).unwrap().parent_note=parent;
    }
    for path in selected{let n=cfg.notes.get_mut(path).unwrap();n.parent_note=None;n.family_order.clear();}
    if let Some(root)=&next_root{cfg.notes.get_mut(root).unwrap().family_order=remaining;}
    Ok(next_root)
}

#[tauri::command]
pub(super) fn detach_layer_members(window:WebviewWindow,state:State<'_,AppState>,paths:Vec<String>)->Result<bool,String>{
    let (_,family)=layer_context(&window,&state)?;
    let selected:HashSet<String>=paths.iter().map(|p|checked(&state,p).map(|p|p.to_string_lossy().into_owned())).collect::<Result<_,_>>()?;
    if selected.len()!=paths.len(){return Err("付箋が重複しています".into());}
    let app=window.app_handle();
    let next_root={let mut cfg=state.cfg.lock().unwrap();
        let old_binding=cfg.notes.get(&family).and_then(|n|n.attachment.clone());
        let next=unlink_members(&mut cfg,&family,&selected)?;
        // Preserve the remaining group's app follow at its current position.
        // The removed root keeps its own window link as an independent sticky.
        if selected.contains(&family){if let (Some(root),Some(mut binding))=(&next,old_binding){
            if let Some(note_rect)=app.get_webview_window(&label_for(root)).and_then(|w|w.hwnd().ok()).and_then(|h|follow::rect(h.0 as usize)){
                if let Some(target_rect)=follow::rect(binding.target.hwnd){
                    binding.reposition(target_rect,note_rect.right-note_rect.left,note_rect.left,note_rect.top);
                    cfg.notes.get_mut(root).unwrap().attachment=Some(binding);
                }
            }
        }}
        next
    };
    {let mut tools=state.note_tools.lock().unwrap();
        tools.layer_path=next_root.clone();tools.held_note=None;
    }
    mark_dirty(&state);follow::wake();
    app.emit("sticky-parent-changed",()).map_err(|e|e.to_string())?;
    Ok(next_root.is_some())
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
        if let Some(next)=next{for path in &mut note.family_order{if path==previous{*path=next.into();}}}
        else{note.family_order.retain(|p|p!=previous);}
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
 #[test] fn closing_a_note_clears_only_its_transient_tools(){
  let mut tools=Tools{menu_note:Some("closed.md".into()),held_note:Some("other.md".into()),control_note:Some("closed.md".into()),parent_pick:Some("closed.md".into()),..Default::default()};
  assert!(tools.forget_window(&label_for("closed.md")));
  assert!(tools.menu_note.is_none());assert!(tools.parent_pick.is_none());assert!(tools.control_note.is_none());
  assert_eq!(tools.held_note.as_deref(),Some("other.md"));
  assert!(!tools.forget_window(&label_for("other.md")));
  assert!(tools.held_note.is_none());
 }
 #[test] fn holding_a_member_temporarily_previews_it_in_front_without_saving(){
  let mut cfg=Config::default();
  for (path,parent) in [("p",None),("c",Some("p")),("g",Some("c"))]{
   cfg.notes.insert(path.into(),NoteState{parent_note:parent.map(str::to_owned),..Default::default()});
  }
  cfg.notes.get_mut("p").unwrap().family_order=vec!["p".into(),"g".into(),"c".into()];
  let original=serde_json::to_string(&cfg).unwrap();
  assert_eq!(display_order(&cfg,"p",Some("c")),vec!["c","p","g"]);
  assert_eq!(display_order(&cfg,"p",Some("g")),vec!["g","p","c"]);
  assert_eq!(display_order(&cfg,"p",None),vec!["p","g","c"]);
  assert_eq!(display_order(&cfg,"p",Some("unrelated")),vec!["p","g","c"]);
  assert_eq!(serde_json::to_string(&cfg).unwrap(),original);
 }
 #[test] fn control_keeps_clicked_member_after_mouse_release_until_key_up(){
  let mut cfg=Config::default();cfg.notes.insert("p".into(),NoteState{family_order:vec!["p".into(),"c".into()],..Default::default()});cfg.notes.insert("c".into(),NoteState{parent_note:Some("p".into()),..Default::default()});
  let saved=serde_json::to_string(&cfg).unwrap();
  let mut tools=Tools{held_note:Some("c".into()),control_note:Some("c".into()),..Default::default()};
  assert!(tools.release_keys(false,true).is_none());assert!(tools.held_note.is_none());assert_eq!(display_order(&cfg,"p",tools.control_note.as_deref()),vec!["c","p"]);
  assert_eq!(tools.release_keys(false,false).as_deref(),Some("c"));assert_eq!(display_order(&cfg,"p",tools.control_note.as_deref()),vec!["p","c"]);assert_eq!(serde_json::to_string(&cfg).unwrap(),saved);
 }
 #[test] fn control_shift_leaves_mouse_drag_hold_but_releases_control_latch(){
  let mut tools=Tools{held_note:Some("c".into()),control_note:Some("c".into()),..Default::default()};
  assert_eq!(tools.release_keys(true,false).as_deref(),Some("c"));assert_eq!(tools.held_note.as_deref(),Some("c"));assert!(tools.control_note.is_none());
  tools.release_keys(false,false);assert!(tools.held_note.is_none());
 }
 #[test] fn batch_unlink_removes_only_selected_members_and_keeps_remaining_descendants(){
  let mut cfg=Config::default();
  for (path,parent) in [("p",None),("c",Some("p")),("g",Some("c")),("s",Some("p"))]{
   cfg.notes.insert(path.into(),NoteState{parent_note:parent.map(str::to_owned),x:Some(70),y:Some(90),..Default::default()});
  }
  cfg.notes.get_mut("p").unwrap().family_order=vec!["g".into(),"s".into(),"c".into(),"p".into()];
  assert_eq!(unlink_members(&mut cfg,"p",&HashSet::from(["c".into(),"s".into()])).unwrap(),Some("p".into()));
  assert_eq!(cfg.notes["c"].parent_note,None);assert_eq!(cfg.notes["s"].parent_note,None);
  assert_eq!(cfg.notes["g"].parent_note.as_deref(),Some("p"));
  assert_eq!(stack_order(&cfg,"p"),vec!["g","p"]);
  for note in cfg.notes.values(){assert_eq!((note.x,note.y),(Some(70),Some(90)));}
  let before=serde_json::to_string(&cfg).unwrap();assert!(unlink_members(&mut cfg,"p",&HashSet::from(["outside".into()])).is_err());assert_eq!(serde_json::to_string(&cfg).unwrap(),before);
 }
 #[test] fn removing_root_or_every_member_leaves_no_dangling_parent_or_cycle(){
  let mut cfg=Config::default();
  for (path,parent) in [("p",None),("c",Some("p")),("g",Some("c")),("s",Some("p"))]{cfg.notes.insert(path.into(),NoteState{parent_note:parent.map(str::to_owned),..Default::default()});}
  let next=unlink_members(&mut cfg,"p",&HashSet::from(["p".into(),"c".into()])).unwrap().unwrap();
  assert_eq!(cfg.notes["p"].parent_note,None);assert_eq!(cfg.notes["c"].parent_note,None);
  assert_eq!(root(&cfg,"g"),Some(next.clone()));assert_eq!(root(&cfg,"s"),Some(next.clone()));
  assert_eq!(unlink_members(&mut cfg,&next,&HashSet::from(["g".into(),"s".into()])).unwrap(),None);
  assert!(cfg.notes.values().all(|n|n.parent_note.is_none()));
 }
 #[test] fn manual_layer_order_is_separate_from_parentage_and_survives_reload(){
  let mut cfg=Config::default();
  for (path,parent) in [("p",None),("c",Some("p")),("g",Some("c")),("s",Some("p"))]{
   cfg.notes.insert(path.into(),NoteState{parent_note:parent.map(str::to_owned),x:Some(100),y:Some(150),..Default::default()});
  }
  assert_eq!(stack_order(&cfg,"p"),vec!["g","c","s","p"]);
  cfg.notes.get_mut("p").unwrap().family_order=vec!["p".into(),"s".into(),"c".into(),"g".into()];
  let mut cfg:Config=serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
  assert_eq!(stack_order(&cfg,"p"),vec!["p","s","c","g"]);
  assert_eq!(cfg.notes["g"].parent_note.as_deref(),Some("c"));assert_eq!(cfg.notes["g"].x,Some(100));
  cfg.notes.insert("new".into(),NoteState{parent_note:Some("c".into()),..Default::default()});
  assert_eq!(stack_order(&cfg,"p"),vec!["p","s","new","c","g"]);
  retarget(&mut cfg,"c",Some("moved"));let child=cfg.notes.remove("c").unwrap();cfg.notes.insert("moved".into(),child);
  assert_eq!(stack_order(&cfg,"p"),vec!["p","s","new","moved","g"]);
  cfg.notes.get_mut("p").unwrap().family_order.clear();
  assert_eq!(stack_order(&cfg,"p").last().map(String::as_str),Some("p"));
 }
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
  for dir in [&a,&b]{cfg.folders.push(FolderCfg{path:dir.canonicalize().unwrap().to_string_lossy().into_owned(),label:"fixture".into(),..Default::default()});}
  cfg.notes.insert(parent.clone(),NoteState::default());
  cfg.notes.insert(child.clone(),NoteState{parent_note:Some(parent.clone()),x:Some(123),y:Some(234),..Default::default()});
  cfg.notes.insert(grand.clone(),NoteState{parent_note:Some(child.clone()),..Default::default()});
  let state=AppState{cfg:Mutex::new(cfg),cfg_path:fixture.path().join("config.json"),labels:Default::default(),dirty:Default::default(),writes:Default::default(),config_writes:Default::default(),moving_folder:Default::default(),opening_notes:Default::default(),quit_requested:Default::default(),drag_group:Default::default(),note_tools:Default::default()};
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
