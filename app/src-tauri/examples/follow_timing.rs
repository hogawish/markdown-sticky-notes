//! Measures Win32 positioning against a synthetic window with a paused message loop.
use std::{
    ptr::null_mut,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

fn main() {
    let (window_tx, window_rx) = mpsc::channel();
    let (pause_tx, pause_rx) = mpsc::channel();
    let owner = thread::spawn(move || unsafe {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let window = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_OVERLAPPEDWINDOW,
            0, 0, 120, 120, null_mut(), null_mut(), null_mut(), null_mut());
        assert!(!window.is_null());
        window_tx.send(window as usize).unwrap();
        while let Ok(paused) = pause_rx.recv() {
            let paused: mpsc::Sender<()> = paused;
            paused.send(()).unwrap();
            thread::sleep(Duration::from_millis(1200));
            let mut message = MSG::default();
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&message);
            }
        }
        DestroyWindow(window);
    });
    let window = window_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    for (label, flags) in [("synchronous", 0), ("asynchronous", SWP_ASYNCWINDOWPOS)] {
        let (ready, ready_rx) = mpsc::channel();
        pause_tx.send(ready).unwrap();
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let start = Instant::now();
        let ok = unsafe { SetWindowPos(window as _, null_mut(), 10, 10, 0, 0,
            flags | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE) };
        assert_ne!(ok, 0);
        println!("{label}: {} ms", start.elapsed().as_millis());
    }
    drop(pause_tx);
    owner.join().unwrap();
}
