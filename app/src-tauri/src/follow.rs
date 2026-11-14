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

pub fn process_birth(pid: u32) -> Option<String> {
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

pub fn application_name(target:&Target)->Option<String> {
    unsafe {
        let h=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,target.pid);
        if h.is_null(){return None;}
        let mut buffer=[0u16;32768];let mut size=buffer.len() as u32;
        let ok=QueryFullProcessImageNameW(h,0,buffer.as_mut_ptr(),&mut size);CloseHandle(h);
        if ok==0{return None;}
        Some(String::from_utf16_lossy(&buffer[..size as usize]).rsplit('\\').next()?.to_lowercase())
    }
}

static PICKING:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
pub fn is_picking()->bool {PICKING.load(std::sync::atomic::Ordering::SeqCst)}
static PICK_CANCEL:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
pub fn cancel_pick(){PICK_CANCEL.store(true,std::sync::atomic::Ordering::SeqCst);}

/// Transient picker: only mouse-button state and Escape, for at most 30 seconds.
/// No hook, cursor replacement, input logging or long-lived listener.
pub fn pick_next_window()->Result<Target,String> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState,VK_LBUTTON,VK_RBUTTON,VK_ESCAPE};
    if PICKING.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("別の付箋でウィンドウを選択中です。Escで中止できます".into())}
    struct Reset;impl Drop for Reset{fn drop(&mut self){PICKING.store(false,Ordering::SeqCst);}}
    let _reset=Reset;
    PICK_CANCEL.store(false,Ordering::SeqCst);
    let button=unsafe{if GetSystemMetrics(SM_SWAPBUTTON)!=0{VK_RBUTTON}else{VK_LBUTTON}} as i32;
    let started=std::time::Instant::now();
    let mut was_down=true; // Ignore the click that started the picker until it is released.
    let mut selected=None;
    while started.elapsed()<std::time::Duration::from_secs(30) {
        unsafe {
            if PICK_CANCEL.load(Ordering::SeqCst) || GetAsyncKeyState(VK_ESCAPE as i32)<0{return Err("cancelled".into())}
            let down=GetAsyncKeyState(button)<0;
            if !down {
                if let Some(target)=selected.take(){return Ok(target)}
            } else if !was_down {
                let mut point=POINT::default();
                if GetCursorPos(&mut point)!=0 {
                    let hit=WindowFromPoint(point);let root=GetAncestor(hit,GA_ROOTOWNER);
                    if !root.is_null() && root!=GetDesktopWindow() && root!=GetShellWindow() && IsWindowVisible(root)!=0 {
                        let mut class=[0u16;128];let n=GetClassNameW(root,class.as_mut_ptr(),class.len() as i32);
                        let name=String::from_utf16_lossy(&class[..n.max(0) as usize]);
                        if !["Progman","WorkerW","Shell_TrayWnd","Shell_SecondaryTrayWnd"].contains(&name.as_str()) {
                            selected=inspect(root as usize).filter(|t|!t.title.is_empty());
                        }
                    }
                }
            }
            was_down=down;
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
    Err("選択を終了しました。もう一度🔗を押して、貼付先をクリックしてください".into())
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

/// Only called by the user's explicit return-to-tab action.
pub fn activate(target:&Target) {
    if !valid(target){return;}
    unsafe {
        if IsIconic(target.hwnd as HWND)!=0 {ShowWindowAsync(target.hwnd as HWND,SW_RESTORE);}
        SetForegroundWindow(target.hwnd as HWND);
    }
}

/// Explicit note click raises the group without handing focus to the target.
pub fn raise_group(note:usize,target:&Target,pin:bool)->Result<(),String> {
    if !valid(target){return Ok(())}
    unsafe {
        let target_window=target.hwnd as HWND;
        if IsIconic(target_window)!=0 {ShowWindowAsync(target_window,SW_SHOWNOACTIVATE);}
        if SetWindowPos(target_window,if pin{HWND_TOP}else{note as HWND},0,0,0,0,
            SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER|SWP_ASYNCWINDOWPOS)==0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if let Some(r)=rect(note){
            place_note(note, if pin { HWND_TOPMOST as usize } else { 0 }, target.hwnd, (r.left,r.top), pin);
        }
    }
    Ok(())
}

/// No activation/focus change, even when returning from another app.
pub fn hide(hwnd: usize) {
    unsafe {
        if IsWindowVisible(hwnd as HWND) != 0 { ShowWindow(hwnd as HWND, SW_HIDE); }
    }
}

/// Place immediately above the next window in the stack, without activating either.
pub fn place_note(hwnd: usize, anchor: usize, target: usize, (x,y): (i32,i32), pin: bool) {
    unsafe {
        let note=hwnd as HWND;
        let flags=SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW|SWP_NOOWNERZORDER;
        let topmost = |window| (GetWindowLongPtrW(window,GWL_EXSTYLE) as u32 & WS_EX_TOPMOST)!=0;
        let in_top_band = pin || topmost(target as HWND);
        let band_top = if in_top_band { HWND_TOPMOST } else { HWND_TOP };
        let note_topmost = topmost(note);
        if note_topmost != in_top_band {
            let band = if in_top_band { HWND_TOPMOST } else { HWND_NOTOPMOST };
            SetWindowPos(note,band,0,0,0,0,flags|SWP_NOMOVE);
        }
        if anchor == 0 && pin {
            SetWindowPos(note,std::ptr::null_mut(),x,y,0,0,flags|SWP_NOZORDER);
            return;
        }
        let before = if anchor == 0 || anchor == HWND_TOPMOST as usize {
            std::ptr::null_mut()
        } else {
            GetWindow(anchor as HWND,GW_HWNDPREV)
        };
        if before == note {
            SetWindowPos(note,std::ptr::null_mut(),x,y,0,0,flags|SWP_NOZORDER);
        } else {
            let after = if before.is_null() || topmost(before) != in_top_band { band_top } else { before };
            SetWindowPos(note,after,x,y,0,0,flags);
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
