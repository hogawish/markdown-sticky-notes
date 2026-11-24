use std::path::{Component, Path, PathBuf, Prefix};
use tauri::{Url, WebviewWindow};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::{
            Shell::{Common::ITEMIDLIST, ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems, ShellExecuteW},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
    core::{HSTRING, PCWSTR, w},
};

fn local_path(uri: &str) -> Result<PathBuf, String> {
    let invalid = || "Windowsのローカルファイルかフォルダのパスを指定してください".to_owned();
    if !uri.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:///"))
        || uri.contains(['\\', '\r', '\n', '\0'])
    {
        return Err(invalid());
    }
    let url = Url::parse(uri).map_err(|_| invalid())?;
    if url.scheme() != "file" || url.host_str().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(invalid());
    }
    let path = url.to_file_path().map_err(|_| invalid())?;
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        || !matches!(components.next(), Some(Component::RootDir))
        || !components.all(|component| match component {
            Component::Normal(name) => name.to_str().is_some_and(|text|
                !text.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c))),
            _ => false,
        })
    {
        return Err(invalid());
    }
    Ok(path)
}

struct ShellItem(*const ITEMIDLIST);

impl ShellItem {
    fn new(path: &Path) -> Result<Self, String> {
        let path = HSTRING::from(super::shell_path(path));
        let item = unsafe { ILCreateFromPathW(&path) };
        if item.is_null() {
            return Err("エクスプローラーでこの場所を見つけられません".into());
        }
        Ok(Self(item))
    }
}

impl Drop for ShellItem {
    fn drop(&mut self) {
        unsafe { ILFree(Some(self.0)) };
    }
}

fn show_path_in_explorer(path: &Path, origin: usize) -> Result<(), String> {
    let path = path.canonicalize().map_err(|error| format!("ファイルまたはフォルダを開けません: {error}"))?;
    if !matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return Err("ローカルドライブの場所を指定してください".into());
    }
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.map_err(|error| error.to_string())?;
    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) { unsafe { CoUninitialize() }; }
    }
    let _apartment = ComApartment;
    if metadata.is_dir() {
        let dir = HSTRING::from(super::shell_path(&path));
        let result = unsafe {
            ShellExecuteW(Some(HWND(origin as *mut _)), w!("explore"), &dir,
                PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        if result.0 as isize <= 32 {
            return Err("エクスプローラーでフォルダを開けません".into());
        }
        Ok(())
    } else if metadata.is_file() {
        let item = ShellItem::new(&path)?;
        unsafe { SHOpenFolderAndSelectItems(item.0, None, 0) }.map_err(|error| error.to_string())
    } else {
        Err("ファイルまたはフォルダを指定してください".into())
    }
}

#[tauri::command]
pub(super) async fn reveal_file_link(window: WebviewWindow, uri: String) -> Result<(), String> {
    if window.label() != "list" && !window.label().starts_with("note-") {
        return Err("付箋の本文からファイルリンクを開いてください".into());
    }
    let path = local_path(&uri)?;
    let origin = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || show_path_in_explorer(&path, origin))
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_links_decode_unicode_and_escaped_path_characters() {
        let path = local_path("file:///C:/%E8%B3%87%E6%96%99%20%28a%29/my%23note%25.md").unwrap();
        assert_eq!(path, PathBuf::from(r"C:\資料 (a)\my#note%.md"));
        assert_eq!(local_path("file:///D:/").unwrap(), PathBuf::from(r"D:\"));
    }

    #[test]
    fn rejects_nonlocal_urls_and_windows_special_paths() {
        for uri in [
            "https://example.com/file", "file://server/share/a.exe", "file:////server/share/a.exe",
            "file:///test.exe", "file:///C:/a.txt:stream", "file:///C:/a.txt%3Astream",
            "file:///C:/a.txt?query", "file:///C:/a.txt#fragment", "file:///C:/nul%00.md",
        ] {
            assert!(local_path(uri).is_err(), "{uri}");
        }
    }
}
