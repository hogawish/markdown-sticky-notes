use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tauri::{State, WebviewWindow};

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
    let name = relative.strip_prefix("attachments/").filter(|name| NAME.is_match(name))
        .ok_or("attachments 内のPNG画像を指定してください")?;
    let path = checked(&state, &path_of_window(&state, &window)?)?;
    let dir = directory(parent(&path)?, false)?;
    read(&dir.join(name)).map(tauri::ipc::Response::new)
}
