use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use super::{AppState, checked, path_of_window, revision_of};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const DIRECTORY: &str = "attachments";
static LINKS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[[^\r\n\]]*\]\((attachments/[A-Za-z0-9_-]+\.png)\)").unwrap()
});
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A[A-Za-z0-9_-]+\.png\z").unwrap());

fn directory(parent: &Path, create: bool) -> Result<PathBuf, String> {
    let dir = parent.join(DIRECTORY);
    if create {
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if dir.canonicalize().map_err(|error| error.to_string())? != dir || !dir.is_dir() {
        return Err("attachments フォルダの場所を確認してください".into());
    }
    Ok(dir)
}

fn png(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    if path.canonicalize().map_err(|error| error.to_string())? != path || !path.is_file() {
        return Err("画像ファイルの場所を確認してください".into());
    }
    let mut bytes = Vec::new();
    File::open(path).and_then(|file| file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES || !png(&bytes) {
        return Err("16 MiB以下のPNG画像を使ってください".into());
    }
    Ok(bytes)
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return if read(path)? == bytes { Ok(()) }
                else { Err("移動先に内容が異なる同名画像があります".into()) };
        }
        Err(error) => return Err(error.to_string()),
    };
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

fn parent(path: &Path) -> Result<&Path, String> {
    path.parent().ok_or_else(|| "付箋の親フォルダがありません".into())
}

pub(super) fn copy_linked(source: &Path, destination: &Path, body: &str) -> Result<(), String> {
    let mut links = LINKS.captures_iter(body).map(|capture| capture.get(1).unwrap().as_str()).peekable();
    if links.peek().is_none() { return Ok(()); }
    let from = directory(parent(source)?, false)?;
    let to = directory(destination, true)?;
    let mut seen = std::collections::HashSet::new();
    for link in links.filter(|link| seen.insert(*link)) {
        let name = &link[DIRECTORY.len() + 1..];
        let bytes = read(&from.join(name)).map_err(|error| format!("{name}: {error}"))?;
        write(&to.join(name), &bytes).map_err(|error| format!("{name}: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(super) fn save_image(window: WebviewWindow, state: State<'_, AppState>, data: String) -> Result<String, String> {
    if data.len() > MAX_BYTES.div_ceil(3) * 4 { return Err("画像は16 MiBまでです".into()); }
    let bytes = STANDARD.decode(data).map_err(|_| "画像を読み取れませんでした")?;
    if bytes.len() > MAX_BYTES || !png(&bytes) { return Err("16 MiB以下のPNG画像を使ってください".into()); }
    let _writer = state.writes.lock().unwrap();
    let path = checked(&state, &path_of_window(&state, &window)?)?;
    let filename = format!("{}.png", revision_of(&bytes));
    write(&directory(parent(&path)?, true)?.join(&filename), &bytes)?;
    Ok(format!("{DIRECTORY}/{filename}"))
}

#[tauri::command]
pub(super) fn read_image(window: WebviewWindow, state: State<'_, AppState>, relative: String) -> Result<tauri::ipc::Response, String> {
    note_image(&window, &state, &relative).map(tauri::ipc::Response::new)
}

fn note_image(window: &WebviewWindow, state: &AppState, relative: &str) -> Result<Vec<u8>, String> {
    let name = relative.strip_prefix("attachments/").filter(|name| NAME.is_match(name))
        .ok_or("attachments 内のPNG画像を指定してください")?;
    let path = checked(state, &path_of_window(state, window)?)?;
    let dir = directory(parent(&path)?, false)?;
    read(&dir.join(name))
}

#[derive(Default)]
pub(super) struct ImageViewers(std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>);

#[tauri::command]
pub(super) async fn open_image_viewer(window: WebviewWindow, state: State<'_, AppState>, relative: String) -> Result<(), String> {
    let bytes = note_image(&window, &state, &relative)?;
    let app = window.app_handle();
    let label = format!("image-{}", super::TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    app.state::<ImageViewers>().0.lock().unwrap().insert(label.clone(), bytes);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("image-viewer.html".into()))
        .title("添付画像")
        .center()
        .min_inner_size(280.0, 200.0)
        .resizable(true)
        .visible(false);
    let size = window.current_monitor().ok().flatten().map(|monitor| {
        let area = monitor.work_area().size;
        let scale = monitor.scale_factor();
        ((area.width as f64 / scale * 0.8).min(1100.0), (area.height as f64 / scale * 0.8).min(800.0))
    }).unwrap_or((900.0, 680.0));
    let viewer = match builder.inner_size(size.0, size.1).build() {
        Ok(viewer) => viewer,
        Err(error) => {
            app.state::<ImageViewers>().0.lock().unwrap().remove(&label);
            return Err(error.to_string());
        }
    };
    let app = app.clone();
    viewer.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            app.state::<ImageViewers>().0.lock().unwrap().remove(&label);
        }
    });
    viewer.show().and_then(|()| viewer.set_focus()).map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn read_viewer_image(window: WebviewWindow, viewers: State<'_, ImageViewers>) -> Result<tauri::ipc::Response, String> {
    viewers.0.lock().unwrap().get(window.label()).cloned()
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "画像を開けませんでした".into())
}

#[derive(serde::Serialize)]
pub(super) struct UnusedImage {
    folder: String,
    name: String,
}

fn unused_in_folder(folder: &Path) -> Result<Vec<String>, String> {
    let images = folder.join(DIRECTORY);
    if !images.try_exists().map_err(|error| error.to_string())? { return Ok(Vec::new()); }
    let images = directory(folder, false)?;
    let mut names = std::collections::HashSet::new();
    for entry in fs::read_dir(images).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let managed = name.strip_suffix(".png").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        });
        if managed && entry.file_type().map_err(|error| error.to_string())?.is_file() {
            names.insert(name);
        }
    }
    if names.is_empty() { return Ok(Vec::new()); }

    let note_trash = folder.join(".trash");
    for location in [folder, note_trash.as_path()] {
        if !location.try_exists().map_err(|error| error.to_string())? { continue; }
        if location.canonicalize().map_err(|error| error.to_string())? != location {
            return Err("付箋のゴミ箱の場所を確認してください".into());
        }
        for entry in fs::read_dir(location).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) { continue; }
            if entry.file_type().map_err(|error| error.to_string())?.is_dir() { continue; }
            if path.canonicalize().map_err(|error| error.to_string())? != path {
                return Err("添付画像を確認できない付箋があります".into());
            }
            let (text, _) = super::read_snapshot(&path)?;
            let text = text.to_ascii_lowercase();
            // A filename mention also protects reference-style links and Markdown edited elsewhere.
            names.retain(|name| !text.contains(name));
        }
    }
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort_unstable();
    Ok(names)
}

#[tauri::command]
pub(super) fn unused_images(state: State<'_, AppState>) -> Result<Vec<UnusedImage>, String> {
    let folders = state.cfg.lock().unwrap().folders.clone();
    let mut unused = Vec::new();
    for folder in folders {
        if !Path::new(&folder.path).is_dir() { continue; }
        let directory = super::registered_dir(&state, &folder.path)?;
        for name in unused_in_folder(&directory)? {
            unused.push(UnusedImage { folder: folder.path.clone(), name });
        }
    }
    Ok(unused)
}

#[tauri::command]
pub(super) fn trash_unused_images(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    images: std::collections::BTreeMap<String, Vec<String>>,
) -> Result<usize, String> {
    let _writer = state.writes.lock().unwrap();
    let mut moves = Vec::new();
    for (folder, selected) in images {
        let directory = super::registered_dir(&state, &folder)?;
        let open = state.labels.lock().unwrap().iter().any(|(label, path)| {
            Path::new(path).parent() == Some(directory.as_path()) && app.get_webview_window(label).is_some()
        });
        if open {
            return Err(format!("{} の付箋を保存して閉じてから、もう一度確認してください", super::strip_unc(&folder)));
        }
        let current = unused_in_folder(&directory)?;
        let source = directory.join(DIRECTORY);
        moves.extend(current.into_iter().filter(|name| selected.contains(name))
            .map(|name| (source.clone(), name)));
    }
    let mut moved = 0;
    for (source, name) in moves {
        let result = (|| -> Result<(), String> {
            let trash = source.join(".trash");
            match fs::create_dir(&trash) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
            if trash.canonicalize().map_err(|error| error.to_string())? != trash {
                return Err("画像のゴミ箱の場所を確認してください".into());
            }
            let original = source.join(&name);
            let bytes = read(&original)?;
            write(&trash.join(&name), &bytes)?;
            if read(&original)? != bytes { return Err("画像が変更されました".into()); }
            fs::remove_file(original).map_err(|error| error.to_string())
        })();
        result.map_err(|error| format!("{moved}件を移動しました。残りの処理を中断しました（{name}: {error}）"))?;
        moved += 1;
    }
    Ok(moved)
}
