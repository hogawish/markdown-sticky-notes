//! Explicit tab references and click-to-activate transport. Never controls note visibility.
use crate::follow::{self,Target};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{collections::{HashMap,HashSet},fs,io::{self,Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
const MAX_MESSAGE:usize=16*1024;
#[derive(Clone,Serialize,Deserialize,Debug,PartialEq)]
pub struct TabRef { pub key:String, pub id:String, pub label:String }
#[derive(Clone,Serialize,Deserialize)]
pub struct TabLink { pub target:Target, pub tab:TabRef }
#[derive(Clone,Serialize,Deserialize)]
pub struct Context { pub key:String,pub source:String,pub target:Target,pub host_pid:u32,pub host_born:String,pub active:Option<TabRef>,
    #[serde(default)] active_tab_query: bool,
    #[serde(default)] closed: bool,
    #[serde(default)] focused_tab_query: bool,
}
#[derive(Deserialize)]
struct Event {
    #[serde(rename="type")] kind:String,
    #[serde(default)] session:String,
    #[serde(default)] window:String,
    tab:Option<TabEvent>,request:Option<String>,ok:Option<bool>,error:Option<String>,
    #[serde(default)] active_tab_query: bool,
    #[serde(default)] focused_tab_query: bool,
}
#[derive(Deserialize, Serialize)]
struct TabEvent {id:String,label:String}
fn key(source:&str,session:&str,window:&str)->String {format!("{:x}",Sha256::digest(format!("{source}\0{session}\0{window}")))}
fn read_frame(reader:&mut impl Read)->io::Result<Option<Vec<u8>>> {
    let mut header=[0u8;4];if reader.read(&mut header[..1])?==0{return Ok(None)}
    reader.read_exact(&mut header[1..])?;let length=u32::from_le_bytes(header) as usize;
    if length>MAX_MESSAGE{return Err(io::Error::new(io::ErrorKind::InvalidData,"Message too large"))}
    let mut data=vec![0;length];reader.read_exact(&mut data)?;Ok(Some(data))
}
fn write_frame(writer:&mut impl Write,value:&serde_json::Value)->io::Result<()> {
    let data=serde_json::to_vec(value)?;writer.write_all(&(data.len() as u32).to_le_bytes())?;writer.write_all(&data)?;writer.flush()
}
pub fn root(config_path:&Path)->PathBuf {config_path.parent().unwrap_or(Path::new(".")).join("tab-contexts")}
fn context_path(root:&Path,key:&str)->Option<PathBuf> {(key.len()==64&&key.bytes().all(|b|b.is_ascii_hexdigit())).then(||root.join(format!("{key}.json")))}
fn live_context(root:&Path,key:&str)->Option<Context> {
    let path=context_path(root,key)?;if fs::metadata(&path).ok()?.len()>MAX_MESSAGE as u64{return None}
    let c:Context=serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (c.key==key&&follow::process_birth(c.host_pid).as_ref()==Some(&c.host_born)).then_some(c)
}
pub fn read_context(root:&Path,key:&str)->Option<Context> {
    live_context(root,key).filter(|c| !c.closed && follow::valid(&c.target))
}
fn contexts(root:&Path, read: fn(&Path,&str)->Option<Context>)->Vec<Context> {
    let Ok(entries)=fs::read_dir(root) else{return Vec::new()};
    entries.flatten().filter_map(|e|{let name=e.file_name();let key=name.to_str()?.strip_suffix(".json")?;read(root,key)
    }).collect()
}
fn window_contexts(root:&Path,target:&Target)->Vec<Context> {
    contexts(root,read_context).into_iter().filter(|c| c.target.hwnd==target.hwnd && c.target.pid==target.pid && c.target.born==target.born).collect()
}
pub fn choices(root:&Path,target:&Target)->Vec<TabRef> {
    window_contexts(root,target).into_iter().filter_map(|context| context.active).collect()
}
pub fn is_current(root:&Path,target:&Target,tab:&TabRef)->bool {
    read_context(root,&tab.key).is_some_and(|c|c.target.hwnd==target.hwnd&&c.target.born==target.born&&c.active.is_some_and(|t|t.id==tab.id))
}
fn safe_id(id:&str)->bool {!id.is_empty()&&id.len()<=100&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}
fn now_ms()->u128 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}
#[derive(Serialize,Deserialize)]
struct Request {request:String,key:String,tab:String,host_pid:u32,host_born:String,expires:u128}
pub fn picked_tab(root: &Path, target: Target) -> Result<TabLink, String> {
    let mut routes = window_contexts(root, &target);
    let mut focused = false;
    if routes.is_empty() && follow::application_name(&target).as_deref() == Some("chrome.exe") {
        focused = true;
        let mut hosts = HashSet::new();
        routes = contexts(root,live_context).into_iter().filter(|c| {
            c.source == "chrome" && c.focused_tab_query && c.target.pid == target.pid
                && c.target.born == target.born && hosts.insert((c.host_pid,c.host_born.clone()))
        }).collect();
    }
    let [context] = routes.as_slice() else {
        return Err("このウィンドウのタブを特定できません。対象ウィンドウで拡張ボタンを押して接続してください".into());
    };
    if !context.active_tab_query {
        return Err("クリックで選ぶには、拡張を更新して接続し直してください".into());
    }
    if focused && follow::foreground() != target.hwnd {
        return Err("対象のChromeウィンドウを前面にして、もう一度タブを選んでください".into());
    }
    let reply = request_tab(root, context, if focused { "focused-tab".into() } else { String::new() })?;
    if focused && follow::foreground() != target.hwnd {
        return Err("選択中にウィンドウが変わりました。もう一度タブを選んでください".into());
    }
    let picked: TabEvent = serde_json::from_value(reply["tab"].clone())
        .map_err(|_| "選択中のタブを取得できません。対応する拡張へ更新して接続してください")?;
    if !safe_id(&picked.id) {
        return Err("拡張から有効なタブIDを取得できませんでした".into());
    }
    Ok(TabLink { target: context.target.clone(), tab: TabRef { key: context.key.clone(), id: picked.id, label: picked.label.chars().take(160).collect() } })
}

pub fn activate(root:&Path,link:&TabLink)->Result<(),String> {
    let c=live_context(root,&link.tab.key).filter(|c| c.source=="chrome" || (!c.closed && follow::valid(&c.target)))
        .ok_or("接続が切れています。拡張から接続し直してタブをリンクしてください")?;
    if c.target.hwnd!=link.target.hwnd||c.target.born!=link.target.born{return Err("リンク先のウィンドウが変わりました".into())}
    request_tab(root, &c, link.tab.id.clone())?;
    if c.source == "vscode" { follow::activate(&link.target); }
    Ok(())
}

fn request_tab(root: &Path, c: &Context, tab: String) -> Result<serde_json::Value, String> {
    let request=format!("{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    let requests=root.join("requests");let replies=root.join("replies");
    fs::create_dir_all(&requests).and_then(|_|fs::create_dir_all(&replies)).map_err(|e|e.to_string())?;
    let command=Request {request:request.clone(),key:c.key.clone(),tab,host_pid:c.host_pid,host_born:c.host_born.clone(),expires:now_ms()+5000};
    let command_path=requests.join(format!("{request}.json"));let reply_path=replies.join(format!("{request}.json"));
    crate::atomic_write(&command_path,&serde_json::to_vec(&command).map_err(|e|e.to_string())?)?;
    for _ in 0..55 {
        if let Ok(bytes)=fs::read(&reply_path) {
            let _=fs::remove_file(&reply_path);let _=fs::remove_file(&command_path);
            let reply:serde_json::Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
            return if reply["ok"]==true{Ok(reply)}else{Err(reply["error"].as_str().unwrap_or("タブを取得できませんでした").to_string())};
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _=fs::remove_file(&command_path);Err("拡張から応答がありません。接続を確認してもう一度押してください".into())
}
struct Host {root:PathBuf,source:String,windows:HashMap<String,Context>,pid:u32,born:String}
impl Host {
    fn event(&mut self,e:Event)->Result<String,String> {
        if e.session.is_empty()||e.session.len()>128||e.window.is_empty()||e.window.len()>128{return Err("Invalid context identity".into())}
        let key=key(&self.source,&e.session,&e.window);
        if e.kind=="close" {
            if let Some(context)=self.windows.get_mut(&key) {
                context.closed=true;
                context.active=None;
                crate::atomic_write(&context_path(&self.root,&key).unwrap(),&serde_json::to_vec(context).map_err(|e|e.to_string())?)?;
            }
            return Ok(key);
        }
        let target=if e.kind=="pair" {follow::inspect(follow::foreground()).ok_or("Focus the matching application window and connect again")?}
        else if e.kind=="active"{self.windows.get(&key).ok_or("Connect this application window first")?.target.clone()}
        else{return Err("Unknown event".into())};
        if !follow::valid(&target){return Err("Application window has closed".into())}
        let executable=follow::application_name(&target).unwrap_or_default();
        let expected=match self.source.as_str(){"chrome"=>executable=="chrome.exe","vscode"=>executable=="code.exe"||executable=="code - insiders.exe","fixture"=>cfg!(debug_assertions)&&executable=="window_fixture.exe",_=>false};
        if !expected{return Err("Focus the matching application window and connect again".into())}
        let active=e.tab.map(|t|TabRef{key:key.clone(),id:t.id,label:t.label.chars().take(160).collect()});
        let context=Context{key:key.clone(),source:self.source.clone(),target,host_pid:self.pid,host_born:self.born.clone(),active,active_tab_query:e.active_tab_query,closed:false,focused_tab_query:e.focused_tab_query};
        fs::create_dir_all(&self.root).map_err(|e|e.to_string())?;
        crate::atomic_write(&context_path(&self.root,&key).unwrap(),&serde_json::to_vec(&context).map_err(|e|e.to_string())?)?;
        self.windows.insert(key.clone(),context);Ok(key)
    }
}
impl Drop for Host {fn drop(&mut self){for(key,c)in &self.windows {
    let Some(path)=context_path(&self.root,key) else{continue};
    let current=fs::read(&path).ok().and_then(|b|serde_json::from_slice::<Context>(&b).ok());
    if current.is_some_and(|now|now.host_pid==c.host_pid&&now.host_born==c.host_born){let _=fs::remove_file(path);}
}}}
pub fn run_host(source:&str,config_root:PathBuf) {
    let pid=std::process::id();let born=follow::process_birth(pid).unwrap_or_default();
    let mut host=Host{root:config_root.join("tab-contexts"),source:source.into(),windows:HashMap::new(),pid,born:born.clone()};
    let output=Arc::new(Mutex::new(io::stdout()));let outstanding=Arc::new(Mutex::new(HashSet::<String>::new()));let stop=Arc::new(AtomicBool::new(false));
    let worker_output=output.clone();let worker_stop=stop.clone();let sent=outstanding.clone();let root=host.root.clone();
    let worker=std::thread::spawn(move||{
        while !worker_stop.load(Ordering::Relaxed) {
            if let Ok(entries)=fs::read_dir(root.join("requests")){for entry in entries.flatten(){
                let path=entry.path();if fs::metadata(&path).map(|m|m.len()>MAX_MESSAGE as u64).unwrap_or(true){continue}
                let Some(c)=fs::read(&path).ok().and_then(|b|serde_json::from_slice::<Request>(&b).ok()) else{continue};
                if c.host_pid!=pid||c.host_born!=born||!safe_id(&c.request){continue}
                if c.expires<now_ms(){let _=fs::remove_file(&path);continue}
                if live_context(&root,&c.key).is_none(){continue}
                if fs::remove_file(&path).is_err(){continue}
                sent.lock().unwrap().insert(c.request.clone());
                let action = match c.tab.as_str() { "" => "active-tab", "focused-tab" => "focused-tab", _ => "activate" };
                let message=serde_json::json!({"action":action,"request":c.request,"key":c.key,"tab":c.tab});
                let _=write_frame(&mut *worker_output.lock().unwrap(),&message);
            }}
            std::thread::sleep(Duration::from_millis(80));
        }
    });
    let mut input=io::stdin().lock();
    while let Ok(Some(bytes))=read_frame(&mut input) {
        let event=serde_json::from_slice::<Event>(&bytes);
        if let Ok(e)=&event {if e.kind=="result" {
            if let Some(request)=&e.request {if safe_id(request)&&outstanding.lock().unwrap().remove(request){
                let reply=serde_json::json!({"ok":e.ok.unwrap_or(false),"error":e.error,"tab":e.tab});
                let _=crate::atomic_write(&host.root.join("replies").join(format!("{request}.json")),&serde_json::to_vec(&reply).unwrap());
            }}continue
        }}
        let result=event.map_err(|e|e.to_string()).and_then(|event|host.event(event));
        let reply=match result{Ok(key)=>serde_json::json!({"ok":true,"key":key}),Err(error)=>serde_json::json!({"ok":false,"error":error})};
        if write_frame(&mut *output.lock().unwrap(),&reply).is_err(){break}
    }
    stop.store(true,Ordering::Relaxed);let _=worker.join();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn frames_keep_utf8_and_handle_partial_headers(){
        let value=serde_json::json!({"tab":"制作メモ"});let mut data=Vec::new();write_frame(&mut data,&value).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&read_frame(&mut &data[..]).unwrap().unwrap()).unwrap(),value);
        assert!(read_frame(&mut &[0u8,1][..]).is_err());assert!(read_frame(&mut &(MAX_MESSAGE as u32+1).to_le_bytes()[..]).is_err());
    }
    #[test] fn identities_do_not_confuse_same_tab_in_another_session_or_window(){
        assert_ne!(key("chrome","a","1"),key("chrome","b","1"));assert_ne!(key("chrome","a","1"),key("chrome","a","2"));
        assert!(context_path(Path::new("."),"../config").is_none());assert!(!safe_id("../reply"));
    }
}
