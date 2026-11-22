//! A transient, non-activating label above the moving family. No saved state.
use super::*;
use std::time::Instant;

const LABEL:&str="placement-feedback";
#[derive(Clone)]
struct Notice{root:String,basis:String,reference:String,until:Instant}
#[derive(Default)]
pub(super) struct Feedback(Mutex<Option<Notice>>);
#[derive(Serialize,Clone)]
pub(super) struct Message{label:String,basis:String}
fn message(basis:&str,reference:&str)->Result<Message,String>{
    let label=match basis{"app"=>"アプリ基準","monitor"=>"モニター基準",_=>return Err("不明な移動基準です".into())};
    let suffix=match reference{"attached"=>"","active"=>" · アクティブ側",_=>return Err("不明な移動先です".into())};
    Ok(Message{label:format!("{label}{suffix}"),basis:basis.into()})
}
pub(super) fn setup(app:&AppHandle)->Result<(),String>{
    app.manage(Feedback::default());
    let window=WebviewWindowBuilder::new(app,LABEL,WebviewUrl::App("placement-feedback.html".into()))
        .title("移動基準").inner_size(260.0,44.0).resizable(false).decorations(false)
        .transparent(true).shadow(false).skip_taskbar(true).always_on_top(true)
        .focused(false).focusable(false).visible(false).build().map_err(|e|e.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|e|e.to_string())
}
#[tauri::command]
pub(super) fn placement_feedback_init(window:WebviewWindow,state:State<'_,Feedback>)->Result<Option<Message>,String>{
    if window.label()!=LABEL{return Err("移動表示から呼び出してください".into());}
    state.0.lock().unwrap().as_ref().map(|n|message(&n.basis,&n.reference)).transpose()
}
#[tauri::command]
pub(super) fn show_placement_feedback(window:WebviewWindow,state:State<'_,AppState>,basis:String,reference:String)->Result<(),String>{
    let path=path_of_window(&state,&window)?;
    let root=note_parent::root(&state.cfg.lock().unwrap(),&path).ok_or("親の付箋が見つかりません")?;
    let payload=message(&basis,&reference)?;
    let app=window.app_handle();
    let feedback=app.try_state::<Feedback>().ok_or("移動基準の表示を準備できませんでした")?;
    *feedback.0.lock().unwrap()=Some(Notice{root,basis,reference,until:Instant::now()+Duration::from_millis(1600)});
    app.emit_to(LABEL,"sticky-placement-feedback",payload).map_err(|e|e.to_string())?;
    follow::wake();Ok(())
}
fn above(bounds:follow::Rect,area:follow::Rect,width:i32,height:i32)->(i32,i32){
    let x=bounds.left+(bounds.right-bounds.left-width)/2;
    let y=if bounds.top-area.top>=height+10{bounds.top-height-10}else{bounds.top+8};
    (x.clamp(area.left,(area.right-width).max(area.left)),y.clamp(area.top,(area.bottom-height).max(area.top)))
}
fn hide(window:&WebviewWindow){if let Ok(hwnd)=window.hwnd(){follow::hide(hwnd.0 as usize);}}
pub(super) fn tick(app:&AppHandle,state:&AppState){
    let Some(feedback)=app.try_state::<Feedback>()else{return};
    let notice={let mut current=feedback.0.lock().unwrap();
        if let Some(n)=current.as_mut(){if follow::placement_keys_down(){n.until=Instant::now()+Duration::from_millis(800);}}
        if current.as_ref().is_some_and(|n|Instant::now()>=n.until){*current=None;}
        current.clone()
    };
    let Some(window)=app.get_webview_window(LABEL)else{return};
    let Some(notice)=notice else{hide(&window);return};
    // Release all data locks before touching native windows.
    let labels=state.labels.lock().unwrap().clone();
    let paths={let cfg=state.cfg.lock().unwrap();
        labels.values().filter(|path|note_parent::root(&cfg,path).as_deref()==Some(&notice.root)).cloned().collect::<Vec<_>>()};
    let bounds=paths.iter().filter_map(|p|app.get_webview_window(&label_for(p))).filter_map(|w|w.hwnd().ok())
        .filter(|h|follow::available(h.0 as usize)).filter_map(|h|follow::rect(h.0 as usize)).reduce(|a,b|follow::Rect{
            left:a.left.min(b.left),top:a.top.min(b.top),right:a.right.max(b.right),bottom:a.bottom.max(b.bottom)});
    let Some(bounds)=bounds else{hide(&window);*feedback.0.lock().unwrap()=None;return};
    let Ok(Some(monitor))=app.monitor_from_point((bounds.left+bounds.right)as f64/2.0,(bounds.top+bounds.bottom)as f64/2.0)else{return};
    let work=monitor.work_area();let area=follow::Rect{left:work.position.x,top:work.position.y,right:work.position.x+work.size.width as i32,bottom:work.position.y+work.size.height as i32};
    let Ok(size)=window.outer_size()else{return};
    let (x,y)=above(bounds,area,size.width as i32,size.height as i32);
    // WebView's ordinary show() activates a popup on Windows. Use the same
    // non-activating native placement path as the note follower instead.
    if let Ok(hwnd)=window.hwnd(){follow::place_feedback(hwnd.0 as usize,(x,y));}
}

#[cfg(test)] mod tests{
 use super::*;
 #[test] fn label_stays_above_overlapping_notes_and_inside_negative_coordinate_monitor(){
  let area=follow::Rect{left:-1920,top:0,right:0,bottom:1080};
  let bounds=follow::Rect{left:-1800,top:200,right:-1200,bottom:650};
  assert_eq!(above(bounds,area,260,44),(-1630,146));
  assert_eq!(above(follow::Rect{top:0,..bounds},area,260,44),(-1630,8));
 }
}
