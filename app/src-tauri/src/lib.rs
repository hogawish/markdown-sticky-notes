//! 付箋ツール(Tauri版) Phase 1。
//! - 付箋 = 登録した付箋フォルダ直下の1つの .md(先頭に任意のfrontmatter)。
//!   frontmatterは解釈せず、元の文字のまま保つ(未知のキーを消さない)。本文だけを差し替えて保存する。
//! - 位置・大きさ・前面固定・開閉は、付箋ではなくこのPCのローカル設定(config.json)に持つ。
//! - 付箋1枚 = 1ウィンドウ。一覧窓とタスクトレイから開く。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env, fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

// ---------------------------------------------------------------- ローカル設定

#[derive(Serialize, Deserialize, Clone, Default)]
struct FolderCfg {
    path: String,
    label: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct NoteState {
    x: Option<i32>,
    y: Option<i32>,
    w: Option<u32>,
    h: Option<u32>,
    #[serde(default)]
    pin: bool,
    #[serde(default)]
    open: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Config {
    #[serde(default)]
    folders: Vec<FolderCfg>,
    /// 付箋のパス → このPCでの状態
    #[serde(default)]
    notes: HashMap<String, NoteState>,
}

struct AppState {
    cfg: Mutex<Config>,
    cfg_path: PathBuf,
    /// ウィンドウのラベル → 付箋のパス
    labels: Mutex<HashMap<String, String>>,
    dirty: AtomicBool,
    writes: Mutex<()>,
    config_writes: Mutex<()>,
    quit_requested: AtomicBool,
}

fn config_path(app: &AppHandle) -> PathBuf {
    if let Ok(d) = env::var("STICKY_CONFIG_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d).join("config.json");
        }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

fn default_folder() -> PathBuf {
    if let Ok(d) = env::var("STICKY_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Documents").join("StickyNotes")
}

fn load_cfg(path: &Path) -> Config {
    match fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_else(|_| {
            // 壊れていたら脇へ退避して、空から始める
            let _ = fs::rename(path, path.with_extension("json.corrupt"));
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

fn save_cfg(st: &AppState) {
    let _writer = st.config_writes.lock().unwrap();
    let json = {
        let cfg = st.cfg.lock().unwrap();
        serde_json::to_string_pretty(&*cfg).unwrap_or_default()
    };
    if let Some(dir) = st.cfg_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Err(error) = atomic_write(&st.cfg_path, json.as_bytes()) {
        eprintln!("Could not save window settings: {error}");
        mark_dirty(st);
    }
}

fn mark_dirty(st: &AppState) {
    st.dirty.store(true, Ordering::SeqCst);
}

fn strip_unc(s: &str) -> String {
    s.strip_prefix(r"\\?\").unwrap_or(s).to_string()
}

// ---------------------------------------------------------------- ファイル

fn mtime_of(p: &Path) -> Result<String, String> {
    let bytes = fs::read(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    Ok(revision_of(&bytes))
}

fn revision_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_snapshot(p: &Path) -> Result<(String, String), String> {
    let bytes = fs::read(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    let revision = revision_of(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| format!("{}: UTF-8ではないため変更せずに停止しました", p.display()))?;
    Ok((text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text), revision))
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path.file_name().ok_or("ファイル名がありません")?.to_string_lossy();
    let temp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result.map_err(|e| format!("{}: {e}", path.display()))
}

fn read_text(p: &Path) -> Result<String, String> {
    read_snapshot(p).map(|(text, _)| text)
}

/// 先頭の `---` で囲まれた部分(区切り行を含む)と、残りの本文に分ける。frontmatterが無ければ ("", 全体)。
fn split_front(text: &str) -> (&str, &str) {
    let mut lines = text.split_inclusive('\n');
    match lines.next() {
        Some(l) if l.trim_end() == "---" => {}
        _ => return ("", text),
    }
    let mut pos = text.find('\n').map(|i| i + 1).unwrap_or(text.len());
    for line in lines {
        pos += line.len();
        if line.trim_end() == "---" {
            return (&text[..pos], &text[pos..]);
        }
    }
    ("", text) // 閉じていなければ、全部を本文として扱う
}

/// frontmatter(区切り行つきの生の文字)から、`key: 値` の値を取り出す。
fn front_value(front: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    front
        .lines()
        .find_map(|l| l.strip_prefix(&prefix))
        .map(|v| {
            let v = v.split(" #").next().unwrap_or(v).trim();
            v.trim_matches(|c| c == '"' || c == '\'').to_string()
        })
        .filter(|v| !v.is_empty())
}

/// 付箋の色の候補。画面のパレットと同じ。
const COLORS: [&str; 8] = ["yellow", "pink", "blue", "green", "purple", "orange", "white", "gray"];

/// 付箋のidの形式: 日時-4桁の16進。例: 20261110-103000-a3f9
fn make_id(salt: u32) -> String {
    let now = chrono::Local::now();
    format!(
        "{}-{:04x}",
        now.format("%Y%m%d-%H%M%S"),
        (now.timestamp_subsec_nanos().wrapping_add(salt.wrapping_mul(7919))) & 0xffff
    )
}

/// 付箋の全文の、frontmatterの `key` だけを書き換える。他のキーと本文は、元の文字のまま保つ。
/// frontmatterが無い付箋には、id と key を持つfrontmatterを新しく足す。
fn set_front_key(text: &str, key: &str, val: &str) -> String {
    let (front, body) = split_front(text);
    if front.is_empty() {
        return format!("---\nid: {}\n{key}: {val}\n---\n{text}", make_id(0));
    }
    let prefix = format!("{key}:");
    let mut lines: Vec<String> = front.split_inclusive('\n').map(str::to_owned).collect();
    let eol = |l: &str| if l.ends_with("\r\n") { "\r\n" } else { "\n" };
    if let Some(i) = lines.iter().position(|l| l.starts_with(&prefix)) {
        let e = eol(&lines[i]);
        lines[i] = format!("{key}: {val}{e}");
    } else {
        let last = lines.len() - 1; // 閉じの `---`
        let e = eol(&lines[last]);
        lines.insert(last, format!("{key}: {val}{e}"));
    }
    format!("{}{}", lines.concat(), body)
}

fn title_of(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.trim_start_matches('#').trim().chars().take(60).collect())
        .unwrap_or_else(|| "(空)".into())
}

fn is_md(p: &Path) -> bool {
    p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md")
}

/// 画面から渡された付箋のパスの検査。登録フォルダの直下の .md だけを受け付ける。
fn checked(st: &AppState, path: &str) -> Result<PathBuf, String> {
    if !Path::new(path).exists() {
        return Err("gone".into());
    }
    let p = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    let parent = p.parent().map(Path::to_path_buf);
    let folders = st.cfg.lock().unwrap().folders.clone();
    let inside = folders
        .iter()
        .filter_map(|f| PathBuf::from(&f.path).canonicalize().ok())
        .any(|d| Some(&d) == parent.as_ref());
    if !inside || p.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("登録した付箋フォルダの外、または .md ではありません".into());
    }
    Ok(p)
}

fn registered_dir(st: &AppState, folder: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(folder).canonicalize().map_err(|e| e.to_string())?;
    let ok = st
        .cfg
        .lock()
        .unwrap()
        .folders
        .iter()
        .any(|f| PathBuf::from(&f.path).canonicalize().ok().as_ref() == Some(&dir));
    if ok { Ok(dir) } else { Err("登録されていないフォルダです".into()) }
}

fn create_note_in(dir: &Path) -> Result<PathBuf, String> {
    let now = chrono::Local::now();
    for i in 0..20u32 {
        let id = make_id(i);
        let p = dir.join(format!("{id}.md"));
        match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                let text = format!("---\nid: {id}\ncreated: {}\n---\n", now.format("%Y-%m-%dT%H:%M"));
                f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                return p.canonicalize().map_err(|e| e.to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("付箋のファイル名を決められませんでした".into())
}

// ---------------------------------------------------------------- ウィンドウ

fn label_for(path: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    format!("note-{:x}", h.finish())
}

fn on_screen(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let (p, s) = (m.position(), m.size());
                x >= p.x - 50 && x < p.x + s.width as i32 - 50 && y >= p.y && y < p.y + s.height as i32 - 50
            })
        })
        .unwrap_or(true)
}

/// 付箋の窓を開く。focus=false なら、いま作業している窓からフォーカスを奪わない(起動時の自動復元用)。
fn open_window(app: &AppHandle, path: &Path, focus: bool) -> Result<(), String> {
    let st = app.state::<AppState>();
    let key = path.to_string_lossy().to_string();
    let label = label_for(&key);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        if focus {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    st.labels.lock().unwrap().insert(label.clone(), key.clone());
    let ns = st.cfg.lock().unwrap().notes.get(&key).cloned().unwrap_or_default();
    let open_count = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("note-"))
        .count() as i32;

    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("note.html".into()))
        .title("付箋")
        .inner_size(280.0, 240.0)
        .min_inner_size(160.0, 100.0)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(ns.pin)
        .focused(focus)
        .build()
        .map_err(|e| e.to_string())?;

    // 保存した位置・大きさを戻す。画面の外なら、右上から少しずつずらして置く
    match (ns.x, ns.y) {
        (Some(x), Some(y)) if on_screen(app, x, y) => {
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            if let Ok(Some(m)) = app.primary_monitor() {
                let sf = m.scale_factor();
                let n = open_count % 8;
                let x = m.position().x + m.size().width as i32 - (320.0 * sf) as i32 - n * 28;
                let y = m.position().y + (60.0 * sf) as i32 + n * 28;
                let _ = w.set_position(PhysicalPosition::new(x, y));
            }
        }
    }
    if let (Some(wd), Some(ht)) = (ns.w, ns.h) {
        let _ = w.set_size(PhysicalSize::new(wd, ht));
    }
    {
        let mut c = st.cfg.lock().unwrap();
        c.notes.entry(key).or_default().open = true;
    }
    mark_dirty(&st);
    Ok(())
}

/// 一覧窓を出す。focus=false なら、フォーカスを奪わない(起動時の自動表示用)。
fn show_list(app: &AppHandle, focus: bool) {
    if let Some(w) = app.get_webview_window("list") {
        let _ = w.show();
        let _ = w.unminimize();
        if focus {
            let _ = w.set_focus();
        }
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "list", WebviewUrl::App("index.html".into()))
        .title("付箋の一覧")
        .inner_size(460.0, 560.0)
        .min_inner_size(320.0, 240.0)
        .focused(focus)
        .build();
}

fn bring_all_front(app: &AppHandle) {
    let st = app.state::<AppState>();
    for (label, w) in app.webview_windows() {
        if !label.starts_with("note-") {
            continue;
        }
        let pin = st
            .labels
            .lock()
            .unwrap()
            .get(&label)
            .and_then(|p| st.cfg.lock().unwrap().notes.get(p).map(|n| n.pin))
            .unwrap_or(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_always_on_top(true); // 一度いちばん前に出して、固定していなければ戻す
        if !pin {
            let _ = w.set_always_on_top(false);
        }
    }
}

fn new_note_in_first_folder(app: &AppHandle) {
    let st = app.state::<AppState>();
    let first = st.cfg.lock().unwrap().folders.first().map(|f| f.path.clone());
    match first {
        Some(f) => {
            if let Ok(dir) = PathBuf::from(&f).canonicalize() {
                if let Ok(p) = create_note_in(&dir) {
                    let _ = open_window(app, &p, true);
                }
            }
        }
        None => show_list(app, true),
    }
}

// ---------------------------------------------------------------- コマンド: 一覧窓

#[derive(Serialize)]
struct FolderInfo {
    path: String,
    display: String,
    label: String,
    ok: bool,
}

#[derive(Serialize)]
struct NoteInfo {
    path: String,
    name: String,
    title: String,
    folder_label: String,
    folder_path: String,
    updated: u64,
    open: bool,
}

#[tauri::command]
fn get_folders(state: State<'_, AppState>) -> Vec<FolderInfo> {
    let cfg = state.cfg.lock().unwrap().clone();
    cfg.folders
        .iter()
        .map(|f| FolderInfo {
            ok: Path::new(&f.path).is_dir(),
            display: strip_unc(&f.path),
            path: f.path.clone(),
            label: f.label.clone(),
        })
        .collect()
}

#[tauri::command]
fn list_notes(state: State<'_, AppState>) -> Vec<NoteInfo> {
    let cfg = state.cfg.lock().unwrap().clone();
    let mut out = Vec::new();
    for f in &cfg.folders {
        let Ok(dir) = PathBuf::from(&f.path).canonicalize() else { continue };
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if !is_md(&p) {
                continue;
            }
            let Ok(text) = read_text(&p) else { continue };
            let (_, body) = split_front(&text);
            let updated = fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let key = p.to_string_lossy().to_string();
            out.push(NoteInfo {
                open: cfg.notes.get(&key).map(|n| n.open).unwrap_or(false),
                name: e.file_name().to_string_lossy().into_owned(),
                title: title_of(body),
                folder_label: f.label.clone(),
                folder_path: strip_unc(&f.path),
                updated,
                path: key,
            });
        }
    }
    out
}

#[tauri::command]
async fn open_note_window(app: AppHandle, path: String) -> Result<(), String> {
    let p = checked(&app.state::<AppState>(), &path)?;
    open_window(&app, &p, true)
}

#[tauri::command]
async fn new_note(app: AppHandle, folder: String) -> Result<String, String> {
    let dir = registered_dir(&app.state::<AppState>(), &folder)?;
    let p = create_note_in(&dir)?;
    open_window(&app, &p, true)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn add_folder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !dir.is_dir() {
        return Err("フォルダではありません".into());
    }
    let key = dir.to_string_lossy().to_string();
    {
        let mut c = state.cfg.lock().unwrap();
        if c.folders.iter().any(|f| f.path == key) {
            return Ok(());
        }
        let label = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| strip_unc(&key));
        c.folders.push(FolderCfg { path: key, label });
    }
    save_cfg(&state);
    Ok(())
}

#[tauri::command]
fn remove_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    let has_open_notes = state.labels.lock().unwrap().iter().any(|(label, p)| {
        Path::new(p).parent() == Some(dir.as_path()) && app.get_webview_window(label).is_some()
    });
    if has_open_notes {
        return Err("入力を保つため、このフォルダの付箋を保存して閉じてから外してください".into());
    }
    {
        let mut c = state.cfg.lock().unwrap();
        c.folders.retain(|f| f.path != path);
    }
    // そのフォルダの付箋のウィンドウは閉じる(ファイルは消さない)
    let dir = PathBuf::from(&path);
    let targets: Vec<String> = state
        .labels
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, p)| Path::new(p).parent() == Some(dir.as_path()))
        .map(|(l, _)| l.clone())
        .collect();
    for l in targets {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.destroy();
        }
    }
    save_cfg(&state);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

fn request_quit(app: &AppHandle) {
    app.state::<AppState>().quit_requested.store(true, Ordering::SeqCst);
    let notes: Vec<_> = app.webview_windows().into_iter().filter(|(label, _)| label.starts_with("note-")).collect();
    if notes.is_empty() { app.exit(0); }
    else {
        for (_, window) in notes {
            if let Err(error) = window.close() { eprintln!("Could not request note close: {error}"); }
        }
    }
}

// ---------------------------------------------------------------- コマンド: 付箋の窓

#[derive(Serialize)]
struct NoteInit {
    path: String,
    body: String,
    mtime: String,
    color: Option<String>,
    pin: bool,
}

fn path_of_window(st: &AppState, window: &WebviewWindow) -> Result<String, String> {
    st.labels
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .ok_or_else(|| "この窓の付箋が分かりません".to_string())
}

/// (本文, 更新時刻, 色)
fn load(p: &Path) -> Result<(String, String, Option<String>), String> {
    let (text, revision) = read_snapshot(p)?;
    let (front, body) = split_front(&text);
    let color = front_value(front, "color");
    Ok((body.to_owned(), revision, color))
}

#[tauri::command]
fn note_init(window: WebviewWindow, state: State<'_, AppState>) -> Result<NoteInit, String> {
    let path = path_of_window(&state, &window)?;
    let p = checked(&state, &path)?;
    let (body, mtime, color) = load(&p)?;
    let pin = state.cfg.lock().unwrap().notes.get(&path).map(|n| n.pin).unwrap_or(false);
    Ok(NoteInit { path, body, mtime, color, pin })
}

#[derive(Serialize)]
struct NoteData {
    body: String,
    mtime: String,
    color: Option<String>,
}

#[tauri::command]
fn read_note(state: State<'_, AppState>, path: String) -> Result<NoteData, String> {
    let (body, mtime, color) = load(&checked(&state, &path)?)?;
    Ok(NoteData { body, mtime, color })
}

/// 付箋の色を変える(frontmatterの `color:` だけを書き換える)。
/// 読み込み時からディスク上で変わっていたら、上書きせず "conflict" を返す。
#[tauri::command]
fn set_color(state: State<'_, AppState>, path: String, color: String, base_mtime: String) -> Result<String, String> {
    let _writer = state.writes.lock().unwrap();
    if !COLORS.contains(&color.as_str()) {
        return Err("使えない色です".into());
    }
    let p = checked(&state, &path)?;
    let (text, revision) = read_snapshot(&p)?;
    if revision != base_mtime {
        return Err("conflict".into());
    }
    let out = set_front_key(&text, "color", &color);
    if mtime_of(&p)? != revision { return Err("conflict".into()); }
    atomic_write(&p, out.as_bytes())?;
    Ok(revision_of(out.as_bytes()))
}

#[tauri::command]
fn note_mtime(state: State<'_, AppState>, path: String) -> Result<String, String> {
    mtime_of(&checked(&state, &path)?)
}

/// 本文を保存する。読み込み時からディスク上で変わっていたら、上書きせず "conflict" を返す。
#[tauri::command]
fn save_note(state: State<'_, AppState>, path: String, body: String, base_mtime: String) -> Result<String, String> {
    let _writer = state.writes.lock().unwrap();
    let p = checked(&state, &path)?;
    let (text, revision) = read_snapshot(&p)?;
    if revision != base_mtime {
        return Err("conflict".into());
    }
    let (front, _) = split_front(&text);
    let out = format!("{front}{body}");
    // 一時ファイルに書いてから置き換える(途中で止まっても、元のファイルを壊さない)
    if mtime_of(&p)? != revision { return Err("conflict".into()); }
    atomic_write(&p, out.as_bytes())?;
    Ok(revision_of(out.as_bytes()))
}

#[tauri::command]
fn set_pin(window: WebviewWindow, state: State<'_, AppState>, on: bool) -> Result<(), String> {
    let path = path_of_window(&state, &window)?;
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    state.cfg.lock().unwrap().notes.entry(path).or_default().pin = on;
    mark_dirty(&state);
    Ok(())
}

#[tauri::command]
fn close_note(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let path = path_of_window(&state, &window)?;
    state.cfg.lock().unwrap().notes.entry(path).or_default().open = state.quit_requested.load(Ordering::SeqCst);
    mark_dirty(&state);
    window.destroy().map_err(|e| e.to_string())?;
    state.labels.lock().unwrap().remove(window.label());
    if state.quit_requested.load(Ordering::SeqCst) && state.labels.lock().unwrap().is_empty() {
        window.app_handle().exit(0);
    }
    Ok(())
}

/// 付箋を片付ける。同じフォルダの .trash へ移す(完全には削除しない)。
#[tauri::command]
fn trash_note(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let path = path_of_window(&state, &window)?;
    let p = PathBuf::from(&path);
    if p.exists() {
        let p = checked(&state, &path)?;
        let trash = p.parent().ok_or("親フォルダがありません")?.join(".trash");
        fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dest = trash.join(format!("{}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), name));
        fs::rename(&p, &dest).map_err(|e| e.to_string())?;
    }
    state.cfg.lock().unwrap().notes.remove(&path);
    mark_dirty(&state);
    window.destroy().map_err(|e| e.to_string())?;
    state.labels.lock().unwrap().remove(window.label());
    if state.quit_requested.load(Ordering::SeqCst) && state.labels.lock().unwrap().is_empty() {
        window.app_handle().exit(0);
    }
    Ok(())
}

// ---------------------------------------------------------------- 起動

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // 二重起動の防止。試験が、動いている本番の付箋ツールと衝突しないよう、環境変数で外せる
    if env::var("STICKY_NO_SINGLE").is_err() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 2つ目を起動したら、既存のほうの一覧を出して終わる
            let app = app.clone();
            std::thread::spawn(move || show_list(&app, true));
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            if !label.starts_with("note-") {
                return;
            }
            let app = window.app_handle();
            let st = app.state::<AppState>();
            let Some(path) = st.labels.lock().unwrap().get(&label).cloned() else { return };
            match event {
                WindowEvent::Moved(p) if p.x > -30000 && p.y > -30000 => {
                    let mut c = st.cfg.lock().unwrap();
                    let e = c.notes.entry(path).or_default();
                    e.x = Some(p.x);
                    e.y = Some(p.y);
                    drop(c);
                    mark_dirty(&st);
                }
                WindowEvent::Resized(s) if s.width > 0 && s.height > 0 => {
                    let mut c = st.cfg.lock().unwrap();
                    let e = c.notes.entry(path).or_default();
                    e.w = Some(s.width);
                    e.h = Some(s.height);
                    drop(c);
                    mark_dirty(&st);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let cfg_path = config_path(app.handle());
            let mut cfg = load_cfg(&cfg_path);
            if cfg.folders.is_empty() {
                // 初回は、既定の付箋フォルダを1つ登録する
                let d = default_folder();
                let _ = fs::create_dir_all(&d);
                if let Ok(c) = d.canonicalize() {
                    let key = c.to_string_lossy().to_string();
                    let label = c
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| strip_unc(&key));
                    cfg.folders.push(FolderCfg { path: key, label });
                }
            }
            app.manage(AppState {
                cfg: Mutex::new(cfg),
                cfg_path,
                labels: Mutex::new(HashMap::new()),
                dirty: AtomicBool::new(true),
                writes: Mutex::new(()),
                config_writes: Mutex::new(()),
                quit_requested: AtomicBool::new(false),
            });

            // 設定の書き出し(動かしている間は、まとめて2秒おき)
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let st = h.state::<AppState>();
                if st.dirty.swap(false, Ordering::SeqCst) {
                    save_cfg(&st);
                }
            });

            // 前回開いていた付箋を戻す。無ければ一覧を出す
            let st = app.state::<AppState>();
            let to_open: Vec<String> = st
                .cfg
                .lock()
                .unwrap()
                .notes
                .iter()
                .filter(|(_, n)| n.open)
                .map(|(p, _)| p.clone())
                .collect();
            let mut opened = 0;
            for p in to_open {
                if let Ok(pp) = checked(&st, &p) {
                    if open_window(app.handle(), &pp, false).is_ok() {
                        opened += 1;
                    }
                }
            }
            if opened == 0 {
                show_list(app.handle(), false);
            }

            // タスクトレイ
            let m_new = MenuItem::with_id(app, "new", "新規付箋", true, None::<&str>)?;
            let m_list = MenuItem::with_id(app, "list", "一覧を開く", true, None::<&str>)?;
            let m_front = MenuItem::with_id(app, "front", "すべて前面へ", true, None::<&str>)?;
            let m_quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&m_new, &m_list, &m_front, &m_quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("付箋")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let app = app.clone();
                    match event.id().as_ref() {
                        "new" => {
                            std::thread::spawn(move || new_note_in_first_folder(&app));
                        }
                        "list" => {
                            std::thread::spawn(move || show_list(&app, true));
                        }
                        "front" => bring_all_front(&app),
                        "quit" => request_quit(&app),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle().clone();
                        std::thread::spawn(move || show_list(&app, true));
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_folders,
            list_notes,
            open_note_window,
            new_note,
            add_folder,
            remove_folder,
            quit_app,
            note_init,
            read_note,
            note_mtime,
            save_note,
            set_color,
            set_pin,
            close_note,
            trash_note
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // 窓を全部閉じても、トレイに残って動き続ける(終了はトレイ・一覧窓から)
            tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
            tauri::RunEvent::Exit => save_cfg(&app.state::<AppState>()),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, front_value, read_snapshot, revision_of, set_front_key, split_front, title_of};

    #[test]
    fn snapshot_token_matches_exact_file_bytes_and_invalid_utf8_is_rejected() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("snapshot-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("note.md");
        atomic_write(&file, b"first").unwrap();
        let (body, revision) = read_snapshot(&file).unwrap();
        assert_eq!(body, "first");
        assert_eq!(revision, revision_of(b"first"));
        atomic_write(&file, b"other").unwrap();
        assert_ne!(read_snapshot(&file).unwrap().1, revision);
        atomic_write(&file, &[0xff]).unwrap();
        assert!(read_snapshot(&file).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), vec![0xff]);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn front_value_reads() {
        let f = "---\nid: a\ncolor: pink\nx: \"q\"\ny: z # memo\n---\n";
        assert_eq!(front_value(f, "color").as_deref(), Some("pink"));
        assert_eq!(front_value(f, "x").as_deref(), Some("q"));
        assert_eq!(front_value(f, "y").as_deref(), Some("z"));
        assert_eq!(front_value(f, "none"), None);
    }

    #[test]
    fn set_key_replaces_existing() {
        let t = "---\nid: a\ncolor: yellow\nfoo: keep\n---\n本文\n";
        assert_eq!(set_front_key(t, "color", "blue"), "---\nid: a\ncolor: blue\nfoo: keep\n---\n本文\n");
    }

    #[test]
    fn set_key_inserts_before_closing() {
        let t = "---\nid: a\nfoo: keep\n---\n本文\n";
        assert_eq!(set_front_key(t, "color", "blue"), "---\nid: a\nfoo: keep\ncolor: blue\n---\n本文\n");
    }

    #[test]
    fn set_key_keeps_crlf() {
        let t = "---\r\nid: a\r\n---\r\n本文";
        assert_eq!(set_front_key(t, "color", "pink"), "---\r\nid: a\r\ncolor: pink\r\n---\r\n本文");
    }

    #[test]
    fn set_key_adds_front_when_none() {
        let out = set_front_key("本文だけ\n", "color", "green");
        assert!(out.starts_with("---\nid: "));
        assert!(out.ends_with("\ncolor: green\n---\n本文だけ\n"));
    }

    #[test]
    fn set_key_on_front_only_note() {
        assert_eq!(set_front_key("---\nid: a\n---\n", "color", "gray"), "---\nid: a\ncolor: gray\n---\n");
    }

    #[test]
    fn no_front() {
        assert_eq!(split_front("本文だけ\n2行目"), ("", "本文だけ\n2行目"));
        assert_eq!(split_front(""), ("", ""));
    }

    #[test]
    fn with_front_keeps_raw() {
        let t = "---\nid: a\nfoo: keep\n---\n本文\n";
        assert_eq!(split_front(t), ("---\nid: a\nfoo: keep\n---\n", "本文\n"));
    }

    #[test]
    fn crlf_front() {
        let t = "---\r\nid: a\r\n---\r\n本文";
        assert_eq!(split_front(t), ("---\r\nid: a\r\n---\r\n", "本文"));
    }

    #[test]
    fn unterminated_front_is_body() {
        let t = "---\nid: a\n本文";
        assert_eq!(split_front(t), ("", t));
    }

    #[test]
    fn front_only() {
        assert_eq!(split_front("---\nid: a\n---\n"), ("---\nid: a\n---\n", ""));
    }

    #[test]
    fn titles() {
        assert_eq!(title_of("\n\n# 見出し\n本文"), "見出し");
        assert_eq!(title_of(""), "(空)");
        assert_eq!(title_of("   \n"), "(空)");
    }
}
