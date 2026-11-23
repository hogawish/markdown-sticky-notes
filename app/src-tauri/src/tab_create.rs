//! Profile-local one-shot creation requests from the existing native tab host.
use super::*;
use std::process::{Command,Stdio};
use std::os::windows::process::CommandExt;

#[derive(Serialize,Deserialize)]
struct Creation { id:String, link:tab_context::TabLink, host_pid:u32, host_born:String, expires:u64 }
fn now()->u64{std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn valid_id(id:&str)->bool{!id.is_empty()&&id.len()<100&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}

pub(super) const NOTE_SIZE: PhysicalSize<u32> = PhysicalSize::new(360, 300);

pub(super) fn creation_position(target: follow::Rect, area: follow::Rect, size: PhysicalSize<u32>) -> (i32, i32) {
    let width = size.width as i32;
    let height = size.height as i32;
    // Overlap the right edge by 24 px when space allows. Keep the whole note
    // on the target monitor when the window is maximized or near an edge.
    (
        (target.right - 24).clamp(area.left, (area.right - width).max(area.left)),
        (target.top + 56).clamp(area.top, (area.bottom - height).max(area.top)),
    )
}

pub(super) fn register_ui(state:&AppState)->Result<(),String>{
    let pid=std::process::id();
    atomic_write(&state.cfg_path.with_file_name("tab-ui.json"),&serde_json::to_vec(&serde_json::json!({"pid":pid,"born":follow::process_birth(pid)})).map_err(|e|e.to_string())?)
}
fn ui_alive(config:&Path)->bool{
    let Ok(bytes)=fs::read(config.join("tab-ui.json"))else{return false};
    let Ok(value)=serde_json::from_slice::<serde_json::Value>(&bytes)else{return false};
    let Some(pid)=value["pid"].as_u64().and_then(|v|u32::try_from(v).ok())else{return false};
    follow::process_birth(pid).as_deref()==value["born"].as_str()
}

pub(super) fn request(config:&Path,context:&tab_context::Context)->Result<(),String>{
    let tab=context.active.clone().filter(|t|valid_id(&t.id)).ok_or("有効なタブがありません")?;
    if !ui_alive(config){
        if env::var_os("STICKY_NO_SINGLE").is_some(){return Err("先に試用版の付箋を起動してください".into());}
        Command::new(env::current_exe().map_err(|e|e.to_string())?).creation_flags(0x08000000)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e|e.to_string())?;
        for _ in 0..80{if ui_alive(config){break;}std::thread::sleep(Duration::from_millis(100));}
        if !ui_alive(config){return Err("付箋アプリを起動できませんでした".into());}
    }
    let root=tab_context::root(&config.join("config.json"));
    let id=format!("{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let request=Creation{id:id.clone(),link:tab_context::TabLink{target:context.target.clone(),tab},host_pid:context.host_pid,host_born:context.host_born.clone(),expires:now()+15000};
    let dir=root.join("create-requests");let replies=root.join("create-replies");
    fs::create_dir_all(&dir).and_then(|_|fs::create_dir_all(&replies)).map_err(|e|e.to_string())?;
    let input=dir.join(format!("{id}.json"));let output=replies.join(format!("{id}.json"));
    atomic_write(&input,&serde_json::to_vec(&request).map_err(|e|e.to_string())?)?;
    for _ in 0..155{
        if let Ok(bytes)=fs::read(&output){let _=fs::remove_file(&output);
            let reply:serde_json::Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
            return if reply["ok"]==true{Ok(())}else{Err(reply["error"].as_str().unwrap_or("付箋を作成できませんでした").into())};
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _=fs::remove_file(input);
    Err("応答がありません。重複を避けるため、付箋一覧を確認してから再実行してください".into())
}

pub(super) fn poll(app:&AppHandle,state:&AppState){
    let root=tab_context::root(&state.cfg_path);let dir=root.join("create-requests");
    let Ok(entries)=fs::read_dir(&dir)else{return};
    for entry in entries.flatten().take(32){
        let path=entry.path();if path.extension().and_then(|v|v.to_str())!=Some("json"){continue;}
        let Ok(meta)=fs::metadata(&path)else{continue};if !meta.is_file()||meta.len()>16384{continue;}
        let Some(request)=fs::read(&path).ok().and_then(|b|serde_json::from_slice::<Creation>(&b).ok())else{continue};
        if !valid_id(&request.id)||path.file_stem().and_then(|s|s.to_str())!=Some(&request.id){continue;}
        let claimed=path.with_extension("processing");if fs::rename(&path,&claimed).is_err(){continue;}
        let app=app.clone();let reply=root.join("create-replies").join(format!("{}.json",request.id));
        std::thread::spawn(move||{
            let result=create(&app,&request);
            let value=match result{Ok(path)=>serde_json::json!({"ok":true,"path":path}),Err(error)=>serde_json::json!({"ok":false,"error":error})};
            let _=atomic_write(&reply,&serde_json::to_vec(&value).unwrap());let _=fs::remove_file(claimed);
        });
    }
}

fn create(app:&AppHandle,request:&Creation)->Result<String,String>{
    let state=app.state::<AppState>();
    if request.expires<now(){return Err("作成要求の期限が切れました".into());}
    let writer=state.writes.lock().unwrap();
    if request.expires<now(){return Err("作成要求の期限が切れました。付箋は作成していません".into());}
    let context=tab_context::read_context(&tab_context::root(&state.cfg_path),&request.link.tab.key).ok_or("拡張の接続が切れました")?;
    if context.host_pid!=request.host_pid||context.host_born!=request.host_born||!context.target.same_window(&request.link.target)||!valid_id(&request.link.tab.id){return Err("タブの接続が変わりました".into());}
    let (preferred,folders)={let cfg=state.cfg.lock().unwrap();(cfg.preferred_folder_id.clone(),cfg.folders.clone())};
    let dir=if !preferred.is_empty(){
        let folder=folders.iter().find(|f|f.id==preferred).ok_or("選択した保存先がありません。付箋一覧で保存先を選び直してください")?;
        registered_dir(&state,&folder.path)?
    }else{folders.iter().find_map(|f|registered_dir(&state,&f.path).ok()).ok_or("付箋一覧で保存先フォルダを登録してください")?};
    let target = request.link.target.clone();
    if !follow::valid(&target) || !follow::available(target.hwnd) {
        return Err("作成元のウィンドウを開き直してください".into());
    }
    let rect = follow::rect(target.hwnd).ok_or("作成元のウィンドウ位置を取得できません")?;
    let center = (f64::midpoint(rect.left.into(), rect.right.into()), f64::midpoint(rect.top.into(), rect.bottom.into()));
    let monitor = app.monitor_from_point(center.0, center.1)
        .map_err(|e| e.to_string())?.ok_or("作成元の画面を取得できません")?;
    let work = monitor.work_area();
    let area = follow::Rect {
        left: work.position.x,
        top: work.position.y,
        right: work.position.x + work.size.width as i32,
        bottom: work.position.y + work.size.height as i32,
    };
    let (x, y) = creation_position(rect, area, NOTE_SIZE);
    let mut attachment = follow::Binding { target, right: 0, top: 0 };
    attachment.reposition(rect, NOTE_SIZE.width as i32, x, y);
    let file=create_note_in(&dir)?;let key=file.to_string_lossy().into_owned();
    let text=fs::read_to_string(&file).map_err(|e|e.to_string())?;
    let title=serde_json::to_string(&request.link.tab.label).map_err(|e|e.to_string())?;
    atomic_write(&file,set_front_key(&text,"title",&title).as_bytes())?;
    state.cfg.lock().unwrap().notes.insert(key.clone(), NoteState {
        x: Some(x),
        y: Some(y),
        w: Some(NOTE_SIZE.width),
        h: Some(NOTE_SIZE.height),
        tab_link: Some(request.link.clone()),
        attachment: Some(attachment),
        ..Default::default()
    });
    mark_dirty(&state);
    {let _guard=state.config_writes.lock().unwrap();let bytes=serde_json::to_vec_pretty(&*state.cfg.lock().unwrap()).map_err(|e|e.to_string())?;atomic_write(&state.cfg_path,&bytes)?;}
    drop(writer);
    open_window_with(app,&file,true,None,Some((rect,area))).map_err(|e|format!("付箋は保存しましたが開けません。一覧から開いてください: {e}"))?;
    Ok(key)
}

#[tauri::command]
pub(super) fn select_creation_folder(window:WebviewWindow,state:State<'_,AppState>,folder:String)->Result<(),String>{
    if window.label()!="list"{return Err("付箋一覧から操作してください".into());}
    let dir=registered_dir(&state,&folder)?;
    let mut cfg=state.cfg.lock().unwrap();let id=cfg.folders.iter().find(|f|Path::new(&f.path)==dir).map(|f|f.id.clone()).ok_or("保存先が見つかりません")?;
    cfg.preferred_folder_id=id;drop(cfg);mark_dirty(&state);Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_overlaps_the_source_window_on_a_left_monitor() {
        let target = follow::Rect { left: -1800, top: 100, right: -800, bottom: 820 };
        let area = follow::Rect { left: -1920, top: 0, right: 0, bottom: 1040 };
        let (x, y) = creation_position(target, area, NOTE_SIZE);
        assert_eq!((x, y), (-824, 156));
    }

    #[test]
    fn creation_stays_on_the_source_monitor_at_the_work_area_edges() {
        let target = follow::Rect { left: 1920, top: 700, right: 3200, bottom: 1100 };
        let area = follow::Rect { left: 1920, top: 0, right: 3200, bottom: 1040 };
        let outer = PhysicalSize::new(376, 309);
        let (x, y) = creation_position(target, area, outer);
        assert_eq!((x, y), (2824, 731));
        let mut binding = follow::Binding {
            target: follow::Target { hwnd: 0, pid: 0, born: String::new(), title: String::new() },
            right: 0,
            top: 0,
        };
        binding.reposition(target, outer.width as i32, x, y);
        assert_eq!(binding.position(target, outer.width as i32), (x, y));
    }
}
