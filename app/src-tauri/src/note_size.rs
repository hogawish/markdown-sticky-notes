use super::*;
use std::time::Instant;
use tauri::Window;

pub(super) const STANDARD_WIDTH: f64 = 280.0;
pub(super) const STANDARD_HEIGHT: f64 = 240.0;
pub(super) const MIN_WIDTH: f64 = 160.0;
pub(super) const MIN_HEIGHT: f64 = 100.0;
const RETRY_INTERVALS: [Duration; 3] = [
    Duration::from_millis(350), Duration::from_secs(1), Duration::from_secs(2),
];

struct Retry {
    next: Option<Instant>,
    attempts: usize,
}

impl Retry {
    fn new(now: Instant) -> Self {
        Self { next: Some(now + RETRY_INTERVALS[0]), attempts: 0 }
    }

    fn take_if_due(&mut self, now: Instant) -> bool {
        if !self.next.is_some_and(|deadline| deadline <= now) { return false; }
        self.attempts += 1;
        self.next = RETRY_INTERVALS.get(self.attempts).map(|interval| now + *interval);
        true
    }
}

#[derive(Default)]
pub(super) struct Recovery(Mutex<HashMap<String, Retry>>);

fn physical(logical: f64, scale: f64) -> u32 { (logical * scale).round() as u32 }

fn valid_axis(value: u32, minimum: f64, scale: f64) -> bool {
    value > 0 && value.saturating_add(1) >= physical(minimum, scale)
}

fn usable(size: PhysicalSize<u32>, scale: f64) -> bool {
    valid_axis(size.width, MIN_WIDTH, scale) && valid_axis(size.height, MIN_HEIGHT, scale)
}

fn saved_size(note: &NoteState, scale: f64) -> PhysicalSize<u32> {
    PhysicalSize::new(
        note.w.filter(|w| valid_axis(*w, MIN_WIDTH, scale)).unwrap_or_else(|| physical(STANDARD_WIDTH, scale)),
        note.h.filter(|h| valid_axis(*h, MIN_HEIGHT, scale)).unwrap_or_else(|| physical(STANDARD_HEIGHT, scale)),
    )
}

pub(super) fn restore_saved(window: &WebviewWindow, note: &NoteState) {
    if note.w.is_none() && note.h.is_none() { return; }
    if let Ok(scale) = window.scale_factor() {
        let _ = window.set_size(saved_size(note, scale));
    }
}

pub(super) fn schedule(window: &Window) {
    let recovery = window.app_handle().state::<Recovery>();
    // Repeated invalid resize notifications cannot restart the timer or retry loop.
    recovery.0.lock().unwrap().entry(window.label().to_owned()).or_insert_with(|| Retry::new(Instant::now()));
}

pub(super) fn resized(window: &Window, state: &AppState, path: String, size: PhysicalSize<u32>) {
    let app = window.app_handle();
    let recovery = app.state::<Recovery>();
    let Ok(scale) = window.scale_factor() else { return };
    if !usable(size, scale) {
        // Display changes can report a temporary invalid client area even with
        // the native minimum size set. Keep the last good dimensions on disk.
        schedule(window);
        return;
    }

    recovery.0.lock().unwrap().remove(window.label());
    let mut config = state.cfg.lock().unwrap();
    let note = config.notes.entry(path).or_default();
    note.w = Some(size.width);
    note.h = Some(size.height);
    mark_dirty(state);
}

pub(super) fn remove(app: &AppHandle, label: &str) {
    app.state::<Recovery>().0.lock().unwrap().remove(label);
}

pub(super) fn repair_existing(window: &WebviewWindow, state: &AppState, path: &str) -> tauri::Result<bool> {
    if window.is_minimized()? { return Ok(false); }
    let scale = window.scale_factor()?;
    if usable(window.inner_size()?, scale) { return Ok(true); }
    let recovered = {
        let config = state.cfg.lock().unwrap();
        config.notes.get(path).map(|note| saved_size(note, scale))
    };
    if let Some(recovered) = recovered { window.set_size(recovered)?; }
    // A successful set_size may still be ignored while the display is settling.
    Ok(false)
}

pub(super) fn recover_due(app: &AppHandle, state: &AppState) {
    let due = {
        let now = Instant::now();
        let recovery = app.state::<Recovery>();
        let mut schedule = recovery.0.lock().unwrap();
        schedule.iter_mut().filter_map(|(label, retry)| retry.take_if_due(now).then(|| label.clone())).collect::<Vec<_>>()
    };
    for label in due {
        let Some(window) = app.get_webview_window(&label) else { continue };
        let Ok(path) = path_of_window(state, &window) else { continue };
        match repair_existing(&window, state, &path) {
            Ok(true) => remove(app, &label),
            Ok(false) => {}
            Err(error) => eprintln!("Could not restore note size: {error}"),
        }
    }
}

#[tauri::command]
pub(super) fn reset_note_size(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    path_of_window(&state, &window)?;
    window.set_size(LogicalSize::new(STANDARD_WIDTH, STANDARD_HEIGHT)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_retries_are_bounded() {
        let now = Instant::now();
        let mut retry = Retry::new(now);
        assert!(!retry.take_if_due(now));
        let mut deadline = now;
        for interval in RETRY_INTERVALS {
            deadline += interval;
            assert!(retry.take_if_due(deadline));
            assert!(!retry.take_if_due(deadline));
        }
        assert!(!retry.take_if_due(deadline + Duration::from_secs(30)));
    }

    #[test]
    fn repairs_only_invalid_saved_axes_at_current_dpi() {
        let note = NoteState { w: Some(400), h: Some(16), ..Default::default() };
        assert_eq!(saved_size(&note, 1.25), PhysicalSize::new(400, 300));
        assert!(!usable(PhysicalSize::new(400, 16), 1.25));
        assert!(usable(PhysicalSize::new(199, 124), 1.25));
    }
}
