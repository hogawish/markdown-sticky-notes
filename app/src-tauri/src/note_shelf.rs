use super::*;

const PREFIX: &str = "minimized-notes-";
const CHANGED: &str = "sticky-minimized-notes";

#[derive(Clone)]
struct Screen {
    label: String,
    work: cli::Rect,
    scale: f64,
}

#[derive(Clone, Serialize)]
pub(super) struct Chip {
    label: String,
    title: String,
    color: String,
}

struct MinimizedNote {
    screen: Screen,
    chip: Chip,
}

// Session-only UI state. The note window and its saved geometry stay intact.
#[derive(Default)]
pub(super) struct Shelf(Mutex<Vec<MinimizedNote>>);

fn chips(app: &AppHandle, label: &str) -> Vec<Chip> {
    app.state::<Shelf>().0.lock().unwrap().iter()
        .filter(|note| note.screen.label == label)
        .map(|note| note.chip.clone())
        .collect()
}

fn refresh(app: &AppHandle, screen: &Screen) -> Result<(), String> {
    let Some(window) = app.get_webview_window(&screen.label) else { return Ok(()) };
    let chips = chips(app, &screen.label);
    let native = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    if chips.is_empty() {
        follow::hide(native);
        return Ok(());
    }

    let px = |value: usize| (value as f64 * screen.scale).round() as i32;
    let gap = px(8);
    let width = px(chips.len().saturating_mul(164) + 8).min((screen.work.w - gap * 2).max(1));
    let height = px(38);
    window.set_size(PhysicalSize::new(width as u32, height as u32)).map_err(|e| e.to_string())?;
    app.emit_to(&screen.label, CHANGED, chips).map_err(|e| e.to_string())?;
    follow::place_feedback(native, (screen.work.x + gap, screen.work.y + screen.work.h - height - gap));
    Ok(())
}

pub(super) fn remove(app: &AppHandle, label: &str) {
    let shelf = app.state::<Shelf>();
    let screen = {
        let mut notes = shelf.0.lock().unwrap();
        notes.iter().position(|note| note.chip.label == label)
            .map(|index| notes.remove(index).screen)
    };
    if let Some(screen) = screen {
        let app = app.clone();
        let dispatcher = app.clone();
        let _ = dispatcher.run_on_main_thread(move || {
            if let Err(error) = refresh(&app, &screen) { eprintln!("Could not update minimized notes: {error}"); }
        });
    }
}

#[tauri::command]
pub(super) async fn minimize_note(window: WebviewWindow, title: String, color: String) -> Result<(), String> {
    let app = window.app_handle().clone();
    path_of_window(&app.state::<AppState>(), &window)?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?
        .ok_or("付箋のあるモニターを取得できません")?;
    let screen = Screen {
        label: format!("{PREFIX}{}-{}", monitor.position().x, monitor.position().y),
        work: work_rect(&monitor),
        scale: monitor.scale_factor(),
    };
    let chip = Chip {
        label: window.label().into(),
        title: title.chars().take(256).collect(),
        color: if is_hex_color(&color) { color } else { "#fff3a3".into() },
    };

    // Serialize shelf changes with the native visibility update on the UI thread.
    let dispatcher = app.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    dispatcher.run_on_main_thread(move || {
        let result = (|| {
            if app.get_webview_window(&screen.label).is_none() {
                WebviewWindowBuilder::new(&app, &screen.label, WebviewUrl::App("minimized-notes.html".into()))
                    .title("最小化した付箋")
                    .inner_size(172.0, 38.0)
                    .decorations(false).resizable(false).transparent(true).shadow(false)
                    .skip_taskbar(true).always_on_top(true).visible(false).focused(false)
                    .build().map_err(|e| e.to_string())?;
            }
            if chips(&app, &screen.label).iter().any(|existing| existing.label == chip.label) {
                return Ok(());
            }
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
            follow::park_note(hwnd)?;
            app.state::<Shelf>().0.lock().unwrap().push(MinimizedNote { screen: screen.clone(), chip });
            if let Err(error) = refresh(&app, &screen) {
                follow::restore_parked_note(hwnd);
                remove(&app, window.label());
                return Err(error);
            }
            follow::wake();
            Ok(())
        })();
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv().map_err(|e| e.to_string())?)
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(super) fn minimized_notes(window: WebviewWindow) -> Result<Vec<Chip>, String> {
    if !window.label().starts_with(PREFIX) { return Err("最小化した付箋の画面から操作してください".into()); }
    Ok(chips(window.app_handle(), window.label()))
}

#[tauri::command]
pub(super) async fn restore_minimized_note(window: WebviewWindow, label: String) -> Result<(), String> {
    let app = window.app_handle();
    if !minimized_notes(window.clone())?.iter().any(|chip| chip.label == label) {
        return Err("付箋が見つかりません".into());
    }
    let note = app.get_webview_window(&label).ok_or("付箋が見つかりません")?;
    let state = app.state::<AppState>();
    let path = path_of_window(&state, &note)?;
    open_window(app, Path::new(&path), true)?;
    promote_note_window(&note, &state, &path)
}
