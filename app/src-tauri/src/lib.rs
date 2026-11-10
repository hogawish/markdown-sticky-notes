//! 付箋ツール(Tauri版) Phase 1。
//! - 付箋 = 登録した付箋フォルダ直下の1つの .md(先頭に任意のfrontmatter)。
//!   一覧属性だけを読み、frontmatterは元の文字のまま保つ(未知のキーを消さない)。
//! - 位置・大きさ・前面固定・開閉は、付箋ではなくこのPCのローカル設定(config.json)に持つ。
//! - 付箋1枚 = 1ウィンドウ。一覧窓とタスクトレイから開く。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use chrono::TimeZone;
use yaml_rust2::YamlLoader;
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
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

// ---------------------------------------------------------------- ローカル設定
mod follow;
mod tab_context;

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
    #[serde(default)]
    attachment: Option<follow::Binding>,
    #[serde(default)]
    tab_link: Option<tab_context::TabLink>,
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
        .inner_size(680.0, 640.0)
        .min_inner_size(380.0, 280.0)
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
    created: u64,
    tags: Vec<String>,
    status: String,
    body: String,
    metadata_error: Option<String>,
    revision: String,
    archived: bool,
    open: bool,
}

#[derive(Default, Debug)]
struct NoteMetadata {
    tags: Vec<String>,
    status: String,
    created: Option<u64>,
    error: Option<String>,
    archived: bool,
}

fn created_millis(value: &str) -> Option<u64> {
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return u64::try_from(date.timestamp_millis()).ok();
    }
    let local = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter().find_map(|format| chrono::NaiveDateTime::parse_from_str(value, format).ok())
        .or_else(|| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0));
    let date = chrono::Local.from_local_datetime(&local?).earliest()?;
    u64::try_from(date.timestamp_millis()).ok()
}

fn parse_frontmatter(front: &str) -> Result<yaml_rust2::Yaml, String> {
    if front.is_empty() { return Ok(yaml_rust2::Yaml::Null); }
    let lines: Vec<_> = front.lines().collect();
    let yaml = lines[1..lines.len().saturating_sub(1)].join("\n");
    let parsed = YamlLoader::load_from_str(&yaml).map_err(|error| error.to_string())?;
    let document = parsed.into_iter().next().unwrap_or(yaml_rust2::Yaml::Null);
    if !matches!(document, yaml_rust2::Yaml::Hash(_) | yaml_rust2::Yaml::Null) {
        return Err("frontmatterはキーと値の形式で指定してください".into());
    }
    Ok(document)
}

fn note_metadata(front: &str) -> NoteMetadata {
    let document = match parse_frontmatter(front) {
        Ok(document) => document,
        Err(error) => return NoteMetadata { error: Some(error), ..Default::default() },
    };
    let mut metadata = NoteMetadata::default();
    if let Some(archived) = document["archived"].as_bool() { metadata.archived = archived; }
    else if !matches!(document["archived"], yaml_rust2::Yaml::BadValue | yaml_rust2::Yaml::Null) {
        metadata.error = Some("archivedはtrueまたはfalseで指定してください".into());
    }
    match &document["tags"] {
        yaml_rust2::Yaml::Array(tags) => {
            for tag in tags {
                if let Some(value) = tag.as_str() { if !value.is_empty() && !metadata.tags.iter().any(|tag| tag == value) { metadata.tags.push(value.to_owned()); } }
                else { metadata.error = Some("tagsは文字列または文字列の配列で指定してください".into()); }
            }
        }
        yaml_rust2::Yaml::String(value) => { if !value.is_empty() { metadata.tags.push(value.to_owned()); } },
        yaml_rust2::Yaml::Null | yaml_rust2::Yaml::BadValue => {},
        _ => metadata.error = Some("tagsは文字列または文字列の配列で指定してください".into()),
    }
    if let Some(status) = document["status"].as_str() { metadata.status = status.to_owned(); }
    else if !matches!(document["status"], yaml_rust2::Yaml::BadValue | yaml_rust2::Yaml::Null) {
        metadata.error = Some("statusは文字列で指定してください".into());
    }
    if let Some(created) = document["created"].as_str() {
        metadata.created = created_millis(created);
        if metadata.created.is_none() { metadata.error = Some("createdの日付を解釈できないため、ファイルの作成日時を使用します".into()); }
    }
    metadata
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
            let Ok((text, revision)) = read_snapshot(&p) else { continue };
            let (front, body) = split_front(&text);
            let metadata = note_metadata(front);
            let file_metadata = fs::metadata(&p).ok();
            let updated = file_metadata.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let created = metadata.created.or_else(|| file_metadata.as_ref().and_then(|m| m.created().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64))
                .unwrap_or(updated);
            let key = p.to_string_lossy().to_string();
            out.push(NoteInfo {
                open: cfg.notes.get(&key).map(|n| n.open).unwrap_or(false),
                name: e.file_name().to_string_lossy().into_owned(),
                title: title_of(body),
                folder_label: f.label.clone(),
                folder_path: strip_unc(&f.path),
                updated,
                created,
                tags: metadata.tags,
                status: metadata.status,
                body: body.to_owned(),
                metadata_error: metadata.error,
                revision,
                archived: metadata.archived,
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
    archived: bool,
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
fn load(p: &Path) -> Result<(String, String, Option<String>, bool), String> {
    let (text, revision) = read_snapshot(p)?;
    let (front, body) = split_front(&text);
    let color = front_value(front, "color");
    Ok((body.to_owned(), revision, color, note_metadata(front).archived))
}

#[tauri::command]
fn note_init(window: WebviewWindow, state: State<'_, AppState>) -> Result<NoteInit, String> {
    let path = path_of_window(&state, &window)?;
    let p = checked(&state, &path)?;
    let (body, mtime, color, archived) = load(&p)?;
    let pin = state.cfg.lock().unwrap().notes.get(&path).map(|n| n.pin).unwrap_or(false);
    Ok(NoteInit { path, body, mtime, color, pin, archived })
}

#[derive(Serialize)]
struct NoteData {
    body: String,
    mtime: String,
    color: Option<String>,
    archived: bool,
}

#[tauri::command]
fn read_note(state: State<'_, AppState>, path: String) -> Result<NoteData, String> {
    let (body, mtime, color, archived) = load(&checked(&state, &path)?)?;
    Ok(NoteData { body, mtime, color, archived })
}

fn archive_text(text: &str, archived: bool) -> Result<String, String> {
    let (front, _) = split_front(text);
    parse_frontmatter(front).map_err(|error| format!("frontmatterの構文を確認してください。元ファイルは変更していません: {error}"))?;
    // Preserve raw unknown keys, comments and body. Recognize quoted scalar keys too.
    let mut out = String::new();
    let mut replaced = false;
    let value = if archived { "true" } else { "false" };
    for line in front.split_inclusive('\n') {
        let is_key = !line.starts_with(char::is_whitespace)
            && line.split_once(':').map(|(key, _)| key.trim().trim_matches(['\'', '"']) == "archived").unwrap_or(false);
        if is_key {
            out.push_str(&format!("archived: {value}{}", if line.ends_with("\r\n") { "\r\n" } else { "\n" }));
            replaced = true;
        } else { out.push_str(line); }
    }
    let out = if replaced { format!("{}{}", out, split_front(text).1) }
        else { set_front_key(text, "archived", value) };
    if parse_frontmatter(split_front(&out).0).ok().and_then(|doc| doc["archived"].as_bool()) != Some(archived) {
        return Err("archived属性は単独の行にtrue/falseで指定してください。元ファイルは変更していません".into());
    }
    Ok(out)
}

fn write_archive(st: &AppState, path: &str, archived: bool, base_revision: &str) -> Result<String, String> {
    let _writer = st.writes.lock().unwrap();
    let file = checked(st, path)?;
    let (text, revision) = read_snapshot(&file)?;
    if revision != base_revision { return Err("他で変更されました。一覧を更新してからやり直してください".into()); }
    let out = archive_text(&text, archived)?;
    if mtime_of(&file)? != revision { return Err("他で変更されました。元ファイルは変更していません".into()); }
    atomic_write(&file, out.as_bytes())?;
    Ok(revision_of(out.as_bytes()))
}

#[tauri::command]
fn archive_note(window: WebviewWindow, state: State<'_, AppState>, archived: bool, base_mtime: String) -> Result<String, String> {
    let path = path_of_window(&state, &window)?;
    write_archive(&state, &path, archived, &base_mtime)
}

#[tauri::command]
fn archive_from_list(app: AppHandle, state: State<'_, AppState>, path: String, archived: bool, base_mtime: String) -> Result<(), String> {
    let file = checked(&state, &path)?;
    let key = file.to_string_lossy().to_string();
    let label = label_for(&key);
    if app.get_webview_window(&label).is_some() {
        // Only that note window receives the request and saves any current edits first.
        app.emit_to(label.as_str(), "sticky-archive-request", archived).map_err(|e| e.to_string())?;
    } else { write_archive(&state, &key, archived, &base_mtime)?; }
    Ok(())
}

#[derive(Serialize)]
struct MoveResult { path: String, mtime: String }

fn move_file_preserving_bytes(source: &Path, destination: &Path, base_revision: &str) -> Result<String, String> {
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let revision = revision_of(&bytes);
    if revision != base_revision { return Err("他で変更されました。一覧を更新してからやり直してください".into()); }
    let metadata = fs::metadata(source).map_err(|e| e.to_string())?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(destination)
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists {
            "移動先に同名ファイルがあります。上書きはしていません".into()
        } else { e.to_string() })?;
    let result = (|| -> Result<(), String> {
        target.write_all(&bytes).map_err(|e| e.to_string())?;
        target.sync_all().map_err(|e| e.to_string())?;
        if let Ok(modified) = metadata.modified() {
            target.set_times(fs::FileTimes::new().set_modified(modified)).map_err(|e| e.to_string())?;
        }
        drop(target);
        if fs::read(source).map_err(|e| e.to_string())? != bytes {
            return Err("コピー中に元の付箋が変わりました。元ファイルは残しています".into());
        }
        if fs::read(destination).map_err(|e| e.to_string())? != bytes {
            return Err("移動先で内容が変わりました。両方のファイルを残しています".into());
        }
        fs::remove_file(source).map_err(|e| format!("元ファイルを片付けられません: {e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        // Remove only our unchanged copy; never overwrite/delete somebody else's edits.
        if fs::read(destination).ok().as_deref() == Some(bytes.as_slice()) { let _ = fs::remove_file(destination); }
        return Err(error);
    }
    Ok(revision)
}

fn move_note_file(st: &AppState, path: &str, folder: &str, base_revision: &str) -> Result<MoveResult, String> {
    let _writer = st.writes.lock().unwrap();
    let source = checked(st, path)?;
    let directory = registered_dir(st, folder)?;
    let destination = directory.join(source.file_name().ok_or("ファイル名がありません")?);
    if destination == source { return Ok(MoveResult {path:source.to_string_lossy().to_string(),mtime:mtime_of(&source)?}); }
    let revision = move_file_preserving_bytes(&source, &destination, base_revision)?;
    let previous = source.to_string_lossy().to_string();
    let next = destination.to_string_lossy().to_string();
    {
        let mut config = st.cfg.lock().unwrap();
        if let Some(mut position) = config.notes.remove(&previous) {
            position.open = false;
            config.notes.insert(next.clone(), position);
        }
    }
    for target in st.labels.lock().unwrap().values_mut() { if *target == previous { *target = next.clone(); } }
    save_cfg(st);
    Ok(MoveResult {path:next,mtime:revision})
}

#[tauri::command]
fn move_note(window: WebviewWindow, state: State<'_, AppState>, folder: String, base_mtime: String) -> Result<MoveResult, String> {
    move_note_file(&state, &path_of_window(&state,&window)?, &folder, &base_mtime)
}

#[tauri::command]
fn move_from_list(app: AppHandle, state: State<'_, AppState>, path: String, folder: String, base_mtime: String) -> Result<(), String> {
    let source = checked(&state, &path)?;
    registered_dir(&state, &folder)?;
    let key = source.to_string_lossy().to_string();
    let label = label_for(&key);
    if app.get_webview_window(&label).is_some() {
        app.emit_to(label.as_str(), "sticky-move-request", folder).map_err(|e| e.to_string())?;
    } else { move_note_file(&state, &key, &folder, &base_mtime)?; }
    Ok(())
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

#[tauri::command]
fn attachment_targets() -> Vec<follow::Target> { follow::candidates() }

#[tauri::command]
fn get_attachment(window: WebviewWindow, state: State<'_, AppState>) -> Result<Option<follow::Binding>, String> {
    let path = path_of_window(&state, &window)?;
    Ok(state.cfg.lock().unwrap().notes.get(&path).and_then(|n| n.attachment.clone()))
}

#[tauri::command]
fn attach_window(window: WebviewWindow, state: State<'_, AppState>, target: follow::Target) -> Result<(), String> {
    let path = path_of_window(&state, &window)?;
    if !follow::valid(&target) { return Err("貼付先が閉じられました。一覧を更新して選び直してください".into()); }
    state.cfg.lock().unwrap().notes.entry(path).or_default().attachment = Some(follow::Binding { target, right:-16, top:56 });
    mark_dirty(&state);
    Ok(())
}

#[tauri::command]
fn attachment_tabs(state: State<'_, AppState>,target:follow::Target)->Vec<tab_context::TabRef>{
    tab_context::choices(&tab_context::root(&state.cfg_path),&target)
}

#[tauri::command]
fn get_tab_link(window: WebviewWindow, state: State<'_, AppState>) -> Result<Option<tab_context::TabLink>, String> {
    let path=path_of_window(&state,&window)?;
    Ok(state.cfg.lock().unwrap().notes.get(&path).and_then(|n|n.tab_link.clone()))
}
#[tauri::command]
fn set_tab_link(window: WebviewWindow, state: State<'_, AppState>, link:Option<tab_context::TabLink>) -> Result<(),String> {
    let path=path_of_window(&state,&window)?;
    if let Some(link)=&link {
        if !tab_context::is_current(&tab_context::root(&state.cfg_path),&link.target,&link.tab) {
            return Err("タブが変わりました。一覧を更新して選び直してください".into());
        }
    }
    state.cfg.lock().unwrap().notes.entry(path).or_default().tab_link=link;
    mark_dirty(&state);Ok(())
}
#[tauri::command]
async fn activate_tab_link(window: WebviewWindow, state: State<'_, AppState>) -> Result<(),String> {
    let path=path_of_window(&state,&window)?;
    let link=state.cfg.lock().unwrap().notes.get(&path).and_then(|n|n.tab_link.clone()).ok_or("タブのリンクがありません")?;
    let root=tab_context::root(&state.cfg_path);
    tauri::async_runtime::spawn_blocking(move ||tab_context::activate(&root,&link)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
fn detach_window(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let path = path_of_window(&state, &window)?;
    let pin = {
        let mut cfg = state.cfg.lock().unwrap();
        let n = cfg.notes.entry(path).or_default(); n.attachment = None; n.pin
    };
    follow::detach(window.hwnd().map_err(|e| e.to_string())?.0 as usize,pin);
    mark_dirty(&state);
    Ok(())
}

fn start_following(app: AppHandle) {
    std::thread::spawn(move || {
        // Native geometry sampling; no agent calls, screenshots, or content reading.
        let mut previous: HashMap<String,(usize,follow::Rect,(i32,i32))> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(120));
            let st = app.state::<AppState>();
            let labels = st.labels.lock().unwrap().clone();
            previous.retain(|label,_| labels.contains_key(label));
            let bindings: Vec<_> = {
                let cfg = st.cfg.lock().unwrap();
                labels.iter().filter_map(|(label,path)| cfg.notes.get(path).and_then(|n|
                    n.attachment.clone().map(|b| (label.clone(),path.clone(),b,n.pin)))).collect()
            };
            let fg = follow::foreground();
            let active_target = bindings.iter().find_map(|(label,_,b,_)|
                app.get_webview_window(label).and_then(|w| w.hwnd().ok())
                    .filter(|h| h.0 as usize == fg).map(|_| b.target.hwnd)).unwrap_or(fg);
            for (label,path,mut b,pin) in bindings {
                let Some(w) = app.get_webview_window(&label) else { continue };
                let Ok(h) = w.hwnd() else { continue };
                if !follow::valid(&b.target) {
                    st.cfg.lock().unwrap().notes.entry(path).or_default().attachment = None;
                    mark_dirty(&st); previous.remove(&label);
                    follow::detach(h.0 as usize,pin);
                    let _ = w.emit("attachment-ended",());
                    continue;
                }
                if !follow::available(b.target.hwnd) || active_target != b.target.hwnd {
                    follow::present(h.0 as usize,None);
                    continue;
                }
                let Some(r) = follow::rect(b.target.hwnd) else { continue };
                let Some(note_rect) = follow::rect(h.0 as usize) else { continue };
                let width = note_rect.right - note_rect.left;
                if let Some((old_target,old_rect,last_position)) = previous.get(&label) {
                    if *old_target == b.target.hwnd && (note_rect.left,note_rect.top) != *last_position {
                        b.reposition(*old_rect,width,note_rect.left,note_rect.top);
                        if let Some(current) = st.cfg.lock().unwrap().notes.get_mut(&path).and_then(|n| n.attachment.as_mut()) {
                            if current.target.hwnd == b.target.hwnd && current.target.born == b.target.born {
                                current.right = b.right; current.top = b.top; mark_dirty(&st);
                            }
                        }
                    }
                }
                let position = b.position(r,width);
                follow::present(h.0 as usize,Some(position));
                previous.insert(label,(b.target.hwnd,r,position));
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args:Vec<_>=env::args().collect();
    let source=if args.iter().any(|a|a.starts_with("chrome-extension://")){Some("chrome")}
        else if args.get(1).is_some_and(|a|a=="--tab-host"){args.get(2).map(String::as_str)}else{None};
    if let Some(source)=source {
        if !["chrome","vscode"].contains(&source) && !(cfg!(debug_assertions)&&source=="fixture"){return;}
        let root=env::var("STICKY_CONFIG_DIR").ok().filter(|s|!s.is_empty()).map(PathBuf::from)
            .or_else(||env::var("APPDATA").ok().map(|d|PathBuf::from(d).join("io.github.hogawish.stickynotes")));
        if let Some(root)=root{tab_context::run_host(source,root);}
        return;
    }
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
            start_following(app.handle().clone());
            if let Ok(executable)=env::current_exe(){
                let location=app.state::<AppState>().cfg_path.with_file_name("tab-host.json");
                if let Some(parent)=location.parent(){let _=fs::create_dir_all(parent);}
                if let Ok(bytes)=serde_json::to_vec(&serde_json::json!({"executable":executable})) {
                    if let Err(error)=atomic_write(&location,&bytes){eprintln!("Could not write tab host location: {error}");}
                }
            }
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
            trash_note,
            archive_note,
            archive_from_list,
            move_note,
            move_from_list,
            attachment_targets, attachment_tabs, get_attachment, attach_window, detach_window, get_tab_link, set_tab_link, activate_tab_link
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
    fn metadata_reads_real_yaml_without_changing_the_source() {
        let text = "---\ntags:\n  - 'maya, dg'\n  - 'look #1'\nstatus: 'review #2'\ncreated: '2026-11-10T10:30:00+09:00'\nunknown: {keep: true}\n---\nBody\n";
        let (front, _) = split_front(text);
        let metadata = super::note_metadata(front);
        assert_eq!(metadata.tags, vec!["maya, dg", "look #1"]);
        assert_eq!(metadata.status, "review #2");
        assert_eq!(metadata.created, super::created_millis("2026-11-10T01:30:00Z"));
        assert!(metadata.error.is_none());
        assert!(text.contains("unknown: {keep: true}"));
    }

    #[test]
    fn missing_and_invalid_metadata_do_not_stop_plain_notes() {
        let metadata = super::note_metadata("");
        assert!(metadata.tags.is_empty());
        assert!(metadata.status.is_empty());
        assert!(metadata.created.is_none());
        assert!(super::note_metadata("---\ntags: [broken\n---\n").error.is_some());
        let metadata = super::note_metadata("---\ntags: [work, work]\nstatus: custom-state\n---\n");
        assert_eq!(metadata.tags, vec!["work"]);
        assert_eq!(metadata.status, "custom-state");
    }

    #[test]
    fn archive_roundtrip_preserves_status_body_unknown_keys_and_file_id() {
        let text = "---\nid: keep-id\nstatus: review\ntags: [look]\nunknown: {keep: true}\n---\nHuman draft\n";
        let archived = super::archive_text(text, true).unwrap();
        assert!(super::note_metadata(split_front(&archived).0).archived);
        let restored = super::archive_text(&archived, false).unwrap();
        assert!(!super::note_metadata(split_front(&restored).0).archived);
        for expected in ["id: keep-id", "status: review", "unknown: {keep: true}", "Human draft\n"] {
            assert!(archived.contains(expected)); assert!(restored.contains(expected));
        }
        let quoted = super::archive_text("---\n'archived': true\ncreated: not-a-date\n---\nBody", false).unwrap();
        assert!(!super::note_metadata(split_front(&quoted).0).archived);
        assert_eq!(quoted.matches("archived:").count(), 1);
        assert!(super::archive_text("---\ntags: [invalid\n---\nBody", true).is_err());
    }

    #[test]
    fn move_keeps_exact_bytes_and_refuses_collisions_or_changed_sources() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("move-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.md"); let destination = root.join("destination.md");
        let bytes = b"---\nid: stable\nstatus: review\n---\nDraft\n";
        std::fs::write(&source,bytes).unwrap();
        std::fs::write(&destination,b"other person's note").unwrap();
        assert!(super::move_file_preserving_bytes(&source,&destination,&revision_of(bytes)).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(),b"other person's note");
        std::fs::remove_file(&destination).unwrap();
        assert!(super::move_file_preserving_bytes(&source,&destination,"stale revision").is_err());
        assert!(!destination.exists());
        let revision = super::move_file_preserving_bytes(&source,&destination,&revision_of(bytes)).unwrap();
        assert_eq!(revision,revision_of(bytes));
        assert!(!source.exists()); assert_eq!(std::fs::read(&destination).unwrap(),bytes);
        std::fs::remove_file(&destination).unwrap(); std::fs::remove_dir(&root).unwrap();
    }

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
