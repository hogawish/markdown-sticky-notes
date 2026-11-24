use super::*;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc;
use std::time::Instant;
use tauri_plugin_dialog::DialogExt;

const PREFIX: &str = "minimized-notes-";
const RESTORE_MENU: &str = "restore-minimized:";
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
pub(super) struct Shelf {
    notes: Mutex<Vec<MinimizedNote>>,
    batch: Mutex<Option<MinimizeBatch>>,
    next_batch: AtomicU32,
}

struct MinimizeBatch {
    id: u32,
    pending: HashSet<String>,
    events: mpsc::Sender<(bool, String)>,
}

impl Shelf {
    fn record(&self, id: u32, label: &str, ok: bool, title: String) {
        let mut batch = self.batch.lock().unwrap();
        let Some(batch) = batch.as_mut().filter(|batch| batch.id == id) else { return };
        if batch.pending.remove(label) {
            let _ = batch.events.send((ok, title));
        }
    }
}

fn chips(app: &AppHandle, label: &str) -> Vec<Chip> {
    app.state::<Shelf>().notes.lock().unwrap().iter()
        .filter(|note| note.screen.label == label)
        .map(|note| note.chip.clone())
        .collect()
}

fn refresh(app: &AppHandle, screen: &Screen) -> Result<(), String> {
    let Some(window) = app.get_webview_window(&screen.label) else { return Ok(()) };
    let chips = chips(app, &screen.label);
    let native = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    if chips.is_empty() {
        app.emit_to(&screen.label, CHANGED, chips).map_err(|e| e.to_string())?;
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
        let mut notes = shelf.notes.lock().unwrap();
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
            app.state::<Shelf>().notes.lock().unwrap().push(MinimizedNote { screen: screen.clone(), chip });
            if let Err(error) = refresh(&app, &screen) {
                follow::restore_parked_note(hwnd);
                remove(&app, window.label());
                return Err(error);
            }
            forget_drag_member(&app, &app.state::<AppState>(), window.label());
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

fn restore_note(app: &AppHandle, label: &str, focus: bool) -> Result<WebviewWindow, String> {
    let note = app.get_webview_window(label).ok_or("付箋が見つかりません")?;
    let state = app.state::<AppState>();
    let path = path_of_window(&state, &note)?;
    open_window(app, Path::new(&path), focus)?;
    if let Err(error) = promote_note_window(&note, &state, &path) {
        eprintln!("Could not raise restored note: {error}");
    }
    Ok(note)
}

#[tauri::command]
pub(super) async fn restore_minimized_note(window: WebviewWindow, label: String) -> Result<(), String> {
    let app = window.app_handle();
    if !minimized_notes(window.clone())?.iter().any(|chip| chip.label == label) {
        return Err("付箋が見つかりません".into());
    }
    restore_note(app, &label, true).map(|_| ())
}

#[tauri::command]
pub(super) async fn open_minimized_menu(window: WebviewWindow) -> Result<(), String> {
    if minimized_notes(window.clone())?.len() < 2 { return Ok(()); }
    let restore = MenuItem::with_id(
        window.app_handle(), format!("{RESTORE_MENU}{}", window.label()),
        "この画面の付箋をすべて戻す", true, None::<&str>,
    ).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(window.app_handle(), &[&restore]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

pub(super) fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let Some(screen) = event.id().as_ref().strip_prefix(RESTORE_MENU) else { return };
    let notes = chips(app, screen);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = None;
        for chip in notes {
            match restore_note(&app, &chip.label, false) {
                Ok(note) => last = Some(note),
                Err(error) => eprintln!("Could not restore minimized note: {error}"),
            }
        }
        if let Some(note) = last { let _ = note.set_focus(); }
    });
}

#[tauri::command]
pub(super) async fn minimize_drag_selection(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let state = app.state::<AppState>();
    path_of_window(&state, &window)?;
    let members = state.drag_group.lock().unwrap().members.clone();
    if !members.iter().any(|label| label == window.label()) {
        return Err("最小化する付箋を選択してください".into());
    }
    let shelf = app.state::<Shelf>();
    let id = shelf.next_batch.fetch_add(1, Ordering::Relaxed);
    let (events, receive) = mpsc::channel();
    {
        let mut batch = shelf.batch.lock().unwrap();
        if batch.is_some() { return Err("一括最小化を処理中です".into()); }
        *batch = Some(MinimizeBatch { id, pending: members.iter().cloned().collect(), events });
    }
    for label in &members {
        // Each editor owns its unsaved text and reports the result after parking.
        if app.get_webview_window(label).is_none() || app.emit_to(label.as_str(), "sticky-minimize-selection", id).is_err() {
            shelf.record(id, label, false, String::new());
        }
    }

    let total = members.len();
    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        (0..total).map_while(|_| receive.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok())
            .collect::<Vec<_>>()
    }).await;
    *shelf.batch.lock().unwrap() = None;
    let outcomes = outcomes.map_err(|error| error.to_string())?;
    let minimized = outcomes.iter().filter(|(ok, _)| *ok).count();
    if minimized != total {
        let mut message = format!("{total}枚のうち{minimized}枚を最小化しました。残った付箋の保存状態を確認してください。");
        for (_, title) in outcomes.iter().filter(|(ok, title)| !ok && !title.is_empty()).take(8) {
            message.push_str(&format!("\n・{title}"));
        }
        if outcomes.len() < total {
            message.push_str(&format!("\n応答を確認できなかった付箋が{}枚あります。", total - outcomes.len()));
        }
        app.dialog().message(message).title("一括最小化").show(|_| {});
    }
    Ok(())
}

#[tauri::command]
pub(super) fn report_minimized_selection(window: WebviewWindow, id: u32, ok: bool, title: String) -> Result<(), String> {
    let app = window.app_handle();
    path_of_window(&app.state::<AppState>(), &window)?;
    let title = title.chars().filter(|c| !c.is_control()).take(80).collect();
    app.state::<Shelf>().record(id, window.label(), ok, title);
    Ok(())
}
