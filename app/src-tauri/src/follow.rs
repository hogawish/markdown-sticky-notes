//! Windows context: only window geometry/identity, never application contents.
use serde::{Deserialize, Serialize};
use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};

#[derive(Clone, Serialize, Deserialize)]
pub struct Target {
    pub hwnd: usize,
    pub pid: u32,
    pub born: String,
    pub title: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Binding {
    pub target: Target,
    pub right: i32,
    pub top: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect { pub left: i32, pub top: i32, pub right: i32, pub bottom: i32 }

fn process_birth(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return None; }
        let mut times = [FILETIME::default(); 4];
        let ok = GetProcessTimes(h, &mut times[0], &mut times[1], &mut times[2], &mut times[3]);
        CloseHandle(h);
        (ok != 0).then(|| (((times[0].dwHighDateTime as u64) << 32) | times[0].dwLowDateTime as u64).to_string())
    }
}

pub fn inspect(hwnd: usize) -> Option<Target> {
    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) == 0 { return None; }
        let mut pid = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == std::process::id() { return None; }
        let mut title = [0u16; 1024];
        let len = GetWindowTextW(h, title.as_mut_ptr(), title.len() as i32);
        Some(Target { hwnd, pid, born: process_birth(pid)?, title: String::from_utf16_lossy(&title[..len.max(0) as usize]) })
    }
}

pub fn valid(target: &Target) -> bool {
    inspect(target.hwnd).is_some_and(|now| now.pid == target.pid && now.born == target.born)
}

pub fn candidates() -> Vec<Target> {
    unsafe extern "system" fn each(h: HWND, data: LPARAM) -> i32 {
        let out = unsafe { &mut *(data as *mut Vec<Target>) };
        if unsafe { IsWindowVisible(h) != 0 && GetWindow(h, GW_OWNER).is_null() } {
            if let Some(t) = inspect(h as usize) {
                if !t.title.is_empty() { out.push(t); }
            }
        }
        1
    }
    let mut out = Vec::new();
    unsafe { EnumWindows(Some(each), &mut out as *mut _ as LPARAM); }
    out
}

pub fn rect(hwnd: usize) -> Option<Rect> {
    let mut r = RECT::default();
    (unsafe { GetWindowRect(hwnd as HWND, &mut r) } != 0).then_some(Rect { left:r.left, top:r.top, right:r.right, bottom:r.bottom })
}

pub fn foreground() -> usize { unsafe { GetAncestor(GetForegroundWindow(), GA_ROOTOWNER) as usize } }
pub fn available(hwnd: usize) -> bool { unsafe { IsWindowVisible(hwnd as HWND) != 0 && IsIconic(hwnd as HWND) == 0 } }

/// No activation/focus change, even when returning from another app.
pub fn present(hwnd: usize, position: Option<(i32,i32)>) {
    unsafe {
        if let Some((x,y)) = position {
            SetWindowPos(hwnd as HWND, HWND_TOPMOST, x,y,0,0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        } else if IsWindowVisible(hwnd as HWND) != 0 {
            ShowWindow(hwnd as HWND, SW_HIDE);
        }
    }
}

pub fn detach(hwnd: usize, pin: bool) {
    unsafe { SetWindowPos(hwnd as HWND, if pin { HWND_TOPMOST } else { HWND_NOTOPMOST },0,0,0,0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW); }
}

impl Binding {
    pub fn position(&self, rect: Rect, width: i32) -> (i32,i32) {
        (rect.right - width + self.right, rect.top + self.top)
    }
    pub fn reposition(&mut self, rect: Rect, width: i32, x: i32, y: i32) {
        self.right = x + width - rect.right;
        self.top = y - rect.top;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_right_edge_and_keeps_dragged_offset() {
        let mut b = Binding { target:Target { hwnd:0,pid:0,born:String::new(),title:String::new() },right:-16,top:50 };
        let r = Rect { left:100,top:200,right:1100,bottom:1000 };
        assert_eq!(b.position(r,280),(804,250));
        b.reposition(r,280,700,300);
        assert_eq!(b.position(Rect {right:1400,top:400,..r},280),(1000,500));
    }
}
