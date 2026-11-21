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

fn position(direction:&str,base:follow::Rect,note:follow::Rect,area:follow::Rect)->Result<(i32,i32),String>{
    let w=note.right-note.left;let h=note.bottom-note.top;let inset=16;
    let (x,y)=match direction{
        "left"=>(base.left+inset,note.top),
        "right"=>(base.right-w-inset,note.top),
        "up"=>(note.left,base.top+inset),
        "down"=>(note.left,base.bottom-h-inset),
        "center"=>(base.left+(base.right-base.left-w)/2,base.top+(base.bottom-base.top-h)/2),
        _=>return Err("不明な移動方向です".into()),
    };
    // Even a small/off-screen target must leave the note reachable.
    Ok((x.clamp(area.left,(area.right-w).max(area.left)),y.clamp(area.top,(area.bottom-h).max(area.top))))
}

#[tauri::command]
pub(super) fn place_note_family(window:WebviewWindow,state:State<'_,AppState>,direction:String,reference:String)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    let app=window.app_handle();
    let (root,binding)={let cfg=state.cfg.lock().unwrap();let root=note_parent::root(&cfg,&path).ok_or("親の付箋が見つかりません")?;
        let binding=cfg.notes.get(&root).and_then(|n|n.attachment.clone());(root,binding)};
    let target=match reference.as_str(){
        "attached"=>binding.as_ref().map(|b|b.target.clone()).ok_or("ウィンドウに貼り付けた付箋で使えます")?,
        "active"=>state.note_tools.lock().unwrap().placement_target.clone().ok_or("先に移動先のアプリを選んでください")?,
        _=>return Err("不明な移動基準です".into()),
    };
    if !follow::valid(&target)||!follow::available(target.hwnd){return Err("移動先のウィンドウを開き直してください".into());}
    let root_window=app.get_webview_window(&label_for(&root)).ok_or("親の付箋を開いてください")?;
    let hwnd=root_window.hwnd().map_err(|e|e.to_string())?.0 as usize;
    let note=follow::rect(hwnd).ok_or("付箋の位置を取得できません")?;
    let base=follow::rect(target.hwnd).ok_or("移動先の位置を取得できません")?;
    let monitor=app.monitor_from_point((base.left+base.right) as f64/2.0,(base.top+base.bottom) as f64/2.0)
        .map_err(|e|e.to_string())?.ok_or("移動先の画面を取得できません")?;
    let work=monitor.work_area();
    let area=follow::Rect{left:work.position.x,top:work.position.y,right:work.position.x+work.size.width as i32,bottom:work.position.y+work.size.height as i32};
    let reference_note=if reference=="active"{
        let x=base.left+(base.right-base.left-(note.right-note.left))/2;
        let y=base.top+(base.bottom-base.top-(note.bottom-note.top))/2;
        follow::Rect{left:x,top:y,right:x+note.right-note.left,bottom:y+note.bottom-note.top}
    }else{note};
    let (x,y)=position(&direction,base,reference_note,area)?;
    // Commit all geometry before native move events so descendants move once.
    let children={let mut cfg=state.cfg.lock().unwrap();
        let n=cfg.notes.get_mut(&root).ok_or("親の付箋が見つかりません")?;
        n.x=Some(note.left);n.y=Some(note.top);
        if let Some(b)=n.attachment.as_mut(){
            let r=follow::rect(b.target.hwnd).ok_or("貼付先の位置を取得できません")?;
            b.reposition(r,note.right-note.left,x,y);
        }
        note_parent::moved(&mut cfg,&root,x,y)
    };
    mark_dirty(&state);
    root_window.set_position(PhysicalPosition::new(x,y)).map_err(|e|e.to_string())?;
    for (child,cx,cy) in children{if let Some(w)=app.get_webview_window(&label_for(&child)){w.set_position(PhysicalPosition::new(cx,cy)).map_err(|e|e.to_string())?;}}
    follow::wake();Ok(())
}

#[tauri::command]
pub(super) fn toggle_family_pin(window:WebviewWindow,state:State<'_,AppState>)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    let (root,on)={let cfg=state.cfg.lock().unwrap();let root=note_parent::root(&cfg,&path).ok_or("親の付箋が見つかりません")?;let on=!cfg.notes[&root].pin;(root,on)};
    let w=window.app_handle().get_webview_window(&label_for(&root)).ok_or("親の付箋を開いてください")?;
    apply_note_pin(&w,&state,&root,on)?;
    w.emit("sticky-pin-changed",on).map_err(|e|e.to_string())?;
    follow::wake();Ok(())
}

#[cfg(test)] mod tests{
 use super::*;
 #[test] fn edges_and_center_use_physical_coordinates_and_remain_on_monitor(){
  let base=follow::Rect{left:-1800,top:100,right:-400,bottom:1000};
  let note=follow::Rect{left:-1400,top:300,right:-1100,bottom:500};
  let area=follow::Rect{left:-1920,top:0,right:0,bottom:1040};
  for (direction,expected) in [("left",(-1784,300)),("right",(-716,300)),("up",(-1400,116)),("down",(-1400,784)),("center",(-1250,450))]{assert_eq!(position(direction,base,note,area).unwrap(),expected);}
  assert!(position("unknown",base,note,area).is_err());
  let tiny=follow::Rect{left:-10,top:0,right:20,bottom:20};
  assert_eq!(position("center",tiny,note,area).unwrap(),(-300,0));
 }
}
