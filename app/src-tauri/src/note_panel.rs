use super::*;

pub(super) fn label(note: &str) -> String { format!("panel-{note}") }

#[tauri::command]
pub(super) fn show_note_panel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    x: i32, y: i32, width: i32, height: i32, focus: bool,
) -> Result<(), String> {
    path_of_window(&state, &window)?;
    let app = window.app_handle();
    let panel = app.get_webview_window(&label(window.label())).ok_or("メニューの窓が見つかりません")?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let source_scale = window.scale_factor().map_err(|e| e.to_string())?;
    let anchor = (
        origin.x.saturating_add((x as f64 * source_scale).round() as i32),
        origin.y.saturating_add((y as f64 * source_scale).round() as i32),
    );
    let monitor = app.monitor_from_point(anchor.0 as f64, anchor.1 as f64)
        .map_err(|e| e.to_string())?.or(window.current_monitor().map_err(|e| e.to_string())?)
        .ok_or("メニューを置く画面が見つかりません")?;
    let area = work_rect(&monitor);
    let scale = monitor.scale_factor();
    let pixels = |value: i32| (value as f64 * scale).round() as i32;
    let width = pixels(width.clamp(160, 480)).min(area.w).max(1);
    let height = pixels(height.clamp(24, 1000)).min(area.h).max(1);
    let x = anchor.0.clamp(area.x, area.x + area.w.saturating_sub(width).max(0));
    let top = if anchor.1 + height <= area.y + area.h { anchor.1 } else { anchor.1 - height };
    let y = top.clamp(area.y, area.y + area.h.saturating_sub(height).max(0));
    panel.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    panel.set_size(PhysicalSize::new(width as u32, height as u32)).map_err(|e| e.to_string())?;
    if focus {
        panel.show().map_err(|e| e.to_string())?;
        panel.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(super) fn hide_note_panel(window: WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("note-") { return Err("付箋から操作してください".into()); }
    if let Some(panel) = window.app_handle().get_webview_window(&label(window.label())) {
        panel.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
