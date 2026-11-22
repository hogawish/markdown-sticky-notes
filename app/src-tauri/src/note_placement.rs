use super::*;

/// Remember only the last external top-level window, never its contents.
pub(super) fn observe(state:&AppState){
    let hwnd=follow::foreground();
    let same=state.note_tools.lock().unwrap().placement_target.as_ref().is_some_and(|t|t.hwnd==hwnd);
    if same{return;}
    if let Some(target)=follow::inspect(hwnd).filter(|t|follow::available(t.hwnd)&&!t.title.is_empty()){
        state.note_tools.lock().unwrap().placement_target=Some(target);
    }
}

fn position(direction:&str,base:follow::Rect,note:follow::Rect,area:follow::Rect,monitor:bool)->Result<(i32,i32),String>{
    let w=note.right-note.left;let h=note.bottom-note.top;let inset=16;let overlap=24;
    let (x,y)=match direction{
        "left"=>(if monitor{base.left+inset}else{base.left-w+overlap},note.top),
        "right"=>(if monitor{base.right-w-inset}else{base.right-overlap},note.top),
        "up"=>(note.left,if monitor{base.top+inset}else{base.top-h+overlap}),
        "down"=>(note.left,if monitor{base.bottom-h-inset}else{base.bottom-overlap}),
        "center"=>(base.left+(base.right-base.left-w)/2,base.top+(base.bottom-base.top-h)/2),
        _=>return Err("不明な移動方向です".into()),
    };
    // Even a small/off-screen target must leave the note reachable.
    Ok((x.clamp(area.left,(area.right-w).max(area.left)),y.clamp(area.top,(area.bottom-h).max(area.top))))
}

#[tauri::command]
pub(super) fn place_note_family(window:WebviewWindow,state:State<'_,AppState>,direction:String,reference:String,basis:Option<String>)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    let app=window.app_handle();
    let (root,binding)={let cfg=state.cfg.lock().unwrap();let root=note_parent::root(&cfg,&path).ok_or("親の付箋が見つかりません")?;
        let binding=cfg.notes.get(&root).and_then(|n|n.attachment.clone());(root,binding)};
    let root_window=app.get_webview_window(&label_for(&root)).ok_or("親の付箋を開いてください")?;
    let hwnd=root_window.hwnd().map_err(|e|e.to_string())?.0 as usize;
    let note=follow::rect(hwnd).ok_or("付箋の位置を取得できません")?;
    let monitor_basis=match basis.as_deref().unwrap_or("app"){"app"=>false,"monitor"=>true,_=>return Err("不明な移動基準です".into())};
    let base=match reference.as_str(){
        "attached" if monitor_basis=>note,
        "attached"|"active"=>{
            let target=if reference=="attached"{binding.as_ref().map(|b|b.target.clone()).ok_or("ウィンドウに貼り付けた付箋で使えます")?}
                else{state.note_tools.lock().unwrap().placement_target.clone().ok_or("先に移動先のアプリを選んでください")?};
            if !follow::valid(&target)||!follow::available(target.hwnd){return Err("移動先のウィンドウを開き直してください".into());}
            follow::rect(target.hwnd).ok_or("移動先の位置を取得できません")?
        },
        _=>return Err("不明な移動基準です".into()),
    };
    let monitor=app.monitor_from_point((base.left+base.right) as f64/2.0,(base.top+base.bottom) as f64/2.0)
        .map_err(|e|e.to_string())?.ok_or("移動先の画面を取得できません")?;
    let work=monitor.work_area();
    let area=follow::Rect{left:work.position.x,top:work.position.y,right:work.position.x+work.size.width as i32,bottom:work.position.y+work.size.height as i32};
    let base=if monitor_basis{area}else{base};
    let reference_note=if reference=="active"{
        let x=base.left+(base.right-base.left-(note.right-note.left))/2;
        let y=base.top+(base.bottom-base.top-(note.bottom-note.top))/2;
        follow::Rect{left:x,top:y,right:x+note.right-note.left,bottom:y+note.bottom-note.top}
    }else{note};
    let (x,y)=position(&direction,base,reference_note,area,monitor_basis)?;
    move_to(app,&state,&root,&root_window,note,x,y)
}

fn move_to(app:&AppHandle,state:&AppState,root:&str,root_window:&WebviewWindow,note:follow::Rect,x:i32,y:i32)->Result<(),String>{
    // Commit all geometry before native move events so descendants move once.
    let children={let mut cfg=state.cfg.lock().unwrap();
        let n=cfg.notes.get_mut(root).ok_or("親の付箋が見つかりません")?;
        n.x=Some(note.left);n.y=Some(note.top);
        if let Some(b)=n.attachment.as_mut(){
            let r=follow::rect(b.target.hwnd).ok_or("貼付先の位置を取得できません")?;
            b.reposition(r,note.right-note.left,x,y);
        }
        note_parent::moved(&mut cfg,root,x,y)
    };
    mark_dirty(&state);
    root_window.set_position(PhysicalPosition::new(x,y)).map_err(|e|e.to_string())?;
    for (child,cx,cy) in children{if let Some(w)=app.get_webview_window(&label_for(&child)){w.set_position(PhysicalPosition::new(cx,cy)).map_err(|e|e.to_string())?;}}
    follow::wake();Ok(())
}

#[tauri::command]
pub(super) fn nudge_note_family(window:WebviewWindow,state:State<'_,AppState>,dx:i32,dy:i32)->Result<(),String>{
    if !(-10..=10).contains(&dx)||!(-10..=10).contains(&dy)||dx!=0&&dy!=0{return Err("不明な移動量です".into());}
    let path=path_of_window(&state,&window)?;
    let root=note_parent::root(&state.cfg.lock().unwrap(),&path).ok_or("親の付箋が見つかりません")?;
    let app=window.app_handle();let w=app.get_webview_window(&label_for(&root)).ok_or("親の付箋を開いてください")?;
    let note=follow::rect(w.hwnd().map_err(|e|e.to_string())?.0 as usize).ok_or("付箋の位置を取得できません")?;
    let monitors=app.available_monitors().map_err(|e|e.to_string())?;
    let left=monitors.iter().map(|m|m.work_area().position.x).min().ok_or("画面を取得できません")?;
    let top=monitors.iter().map(|m|m.work_area().position.y).min().unwrap();
    let right=monitors.iter().map(|m|m.work_area().position.x+m.work_area().size.width as i32).max().unwrap();
    let bottom=monitors.iter().map(|m|m.work_area().position.y+m.work_area().size.height as i32).max().unwrap();
    let x=note.left.saturating_add(dx).clamp(left-(note.right-note.left)+48,right-48);
    let y=note.top.saturating_add(dy).clamp(top,bottom-48);
    move_to(app,&state,&root,&w,note,x,y)
}

#[tauri::command]
pub(super) fn retreat_note_family(window:WebviewWindow,state:State<'_,AppState>)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    let (root,target)={let cfg=state.cfg.lock().unwrap();let root=note_parent::root(&cfg,&path).ok_or("親の付箋が見つかりません")?;
        let target=cfg.notes.get(&root).and_then(|n|n.attachment.as_ref()).map(|b|b.target.clone()).ok_or("ウィンドウに貼り付けた付箋で使えます")?;(root,target)};
    if !follow::valid(&target)||!follow::available(target.hwnd){return Err("貼付先のウィンドウを開いてください".into());}
    if follow::retreat_keys_down(){state.note_tools.lock().unwrap().behind_root=Some(root);follow::wake();}
    Ok(())
}

#[cfg(test)] mod tests{
 use super::*;
 #[test] fn edges_and_center_use_physical_coordinates_and_remain_on_monitor(){
  let base=follow::Rect{left:-1800,top:100,right:-400,bottom:1000};
  let note=follow::Rect{left:-1400,top:300,right:-1100,bottom:500};
  let area=follow::Rect{left:-1920,top:0,right:0,bottom:1040};
  for (direction,expected) in [("left",(-1920,300)),("right",(-424,300)),("up",(-1400,0)),("down",(-1400,840)),("center",(-1250,450))]{assert_eq!(position(direction,base,note,area,false).unwrap(),expected);}
  assert_eq!(position("left",area,note,area,true).unwrap(),(-1904,300));
  assert_eq!(position("right",area,note,area,true).unwrap(),(-316,300));
  assert_eq!(position("center",area,note,area,true).unwrap(),(-1110,420));
  assert!(position("unknown",base,note,area,false).is_err());
  let tiny=follow::Rect{left:-10,top:0,right:20,bottom:20};
  assert_eq!(position("center",tiny,note,area,false).unwrap(),(-300,0));
 }
}
