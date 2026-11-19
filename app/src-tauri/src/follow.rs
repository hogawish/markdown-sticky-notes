//! Windows context: only window geometry/identity, never application contents.
use serde::{Deserialize, Serialize};
use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};
use windows_sys::Win32::UI::Accessibility::{HWINEVENTHOOK,SetWinEventHook,UnhookWinEvent};

static FOREGROUND_WAKE:std::sync::OnceLock<std::sync::mpsc::SyncSender<()>>=std::sync::OnceLock::new();
unsafe extern "system" fn foreground_changed(_:HWINEVENTHOOK,_:u32,_:HWND,_:i32,_:i32,_:u32,_:u32){
    if let Some(sender)=FOREGROUND_WAKE.get(){let _=sender.try_send(());}
}

/// Wake the existing geometry worker on app activation and move/resize end, without reading input
/// or application contents. The bounded channel coalesces rapid focus changes.
pub fn foreground_changes()->std::sync::mpsc::Receiver<()> {
    let (sender,receiver)=std::sync::mpsc::sync_channel(1);
    assert!(FOREGROUND_WAKE.set(sender).is_ok(),"foreground watcher starts once");
    std::thread::spawn(||unsafe{
        let hooks=[EVENT_SYSTEM_FOREGROUND,EVENT_SYSTEM_MOVESIZEEND].map(|event|
            SetWinEventHook(event,event,std::ptr::null_mut(),Some(foreground_changed),0,0,WINEVENT_OUTOFCONTEXT));
        if hooks.iter().all(|hook|hook.is_null()){eprintln!("Window notifications unavailable; geometry sampling remains active");return;}
        let mut message=MSG::default();
        while GetMessageW(&mut message,std::ptr::null_mut(),0,0)>0{TranslateMessage(&message);DispatchMessageW(&message);}
        for hook in hooks {if !hook.is_null(){UnhookWinEvent(hook);}}
    });
    receiver
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Target {
    pub hwnd: usize,
    pub pid: u32,
    pub born: String,
    pub title: String,
}

impl Target {
    pub fn same_window(&self, other: &Self) -> bool {
        self.hwnd == other.hwnd && self.pid == other.pid && self.born == other.born
    }
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
    inspect_window(hwnd,false)
}

fn inspect_window(hwnd: usize, allow_own: bool) -> Option<Target> {
    unsafe {
        let h = hwnd as HWND;
        if IsWindow(h) == 0 { return None; }
        let mut pid = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == std::process::id() && !allow_own { return None; }
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

pub fn display_app(target: &Target) -> String {
    let names = [
        ("chrome.exe", "Google Chrome"),
        ("msedge.exe", "Microsoft Edge"),
        ("firefox.exe", "Mozilla Firefox"),
        ("code.exe", "Visual Studio Code"),
        ("code - insiders.exe", "Visual Studio Code - Insiders"),
        ("explorer.exe", "エクスプローラー"),
        ("slack.exe", "Slack"),
        ("codex.exe", "Codex"),
        ("claude.exe", "Claude"),
        ("chatgpt.exe", "ChatGPT"),
    ];
    let executable = valid(target).then(|| application_name(target)).flatten();
    for (process, name) in names {
        if executable.as_deref() == Some(process) || target.title == name
            || target.title.strip_suffix(name).is_some_and(|prefix| prefix.ends_with(" - ") || prefix.ends_with(" — "))
        {
            return name.into();
        }
    }
    executable.and_then(|name| name.strip_suffix(".exe").map(str::to_owned))
        .unwrap_or_default()
}

static PICKING:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
pub fn is_picking()->bool {PICKING.load(std::sync::atomic::Ordering::SeqCst)}
static PICK_CANCEL:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
pub fn cancel_pick(){PICK_CANCEL.store(true,std::sync::atomic::Ordering::SeqCst);}

/// Transient picker: only mouse-button state and Escape, for at most 30 seconds.
/// No hook, cursor replacement, input logging or long-lived listener.
pub fn pick_next_window()->Result<Target,String> {
    pick_window_click().map(|(target, _)| target)
}

pub fn pick_window_click() -> Result<(Target, (i32, i32)), String> {
    pick_window_click_allowing(std::collections::HashSet::new())
}

pub fn pick_window_click_allowing(own_notes: std::collections::HashSet<usize>) -> Result<(Target,(i32,i32)),String> {
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
                    let hit=WindowFromPoint(point);let direct=GetAncestor(hit,GA_ROOT);
                    let root=if own_notes.contains(&(direct as usize)){direct}else{GetAncestor(hit,GA_ROOTOWNER)};
                    if !root.is_null() && root!=GetDesktopWindow() && root!=GetShellWindow() && IsWindowVisible(root)!=0 {
                        let mut class=[0u16;128];let n=GetClassNameW(root,class.as_mut_ptr(),class.len() as i32);
                        let name=String::from_utf16_lossy(&class[..n.max(0) as usize]);
                        if !["Progman","WorkerW","Shell_TrayWnd","Shell_SecondaryTrayWnd"].contains(&name.as_str()) {
                            selected=inspect_window(root as usize,own_notes.contains(&(root as usize))).filter(|t|!t.title.is_empty())
                                .map(|target| (target, (point.x, point.y)));
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

pub fn chrome_window(hwnd: usize) -> bool {
    let mut class = [0u16; 32];
    let length = unsafe { GetClassNameW(hwnd as HWND, class.as_mut_ptr(), class.len() as i32) };
    length > 0 && String::from_utf16_lossy(&class[..length as usize]) == "Chrome_WidgetWin_1"
}

pub fn logical_rect(hwnd: usize) -> Option<Rect> {
    use windows_sys::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_UNAWARE,
    };
    unsafe {
        let prior = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_UNAWARE);
        if prior.is_null() { return None; }
        let result = rect(hwnd);
        SetThreadDpiAwarenessContext(prior);
        result
    }
}

pub fn foreground() -> usize { unsafe { GetAncestor(GetForegroundWindow(), GA_ROOTOWNER) as usize } }
pub fn available(hwnd: usize) -> bool { unsafe { IsWindowVisible(hwnd as HWND) != 0 && IsIconic(hwnd as HWND) == 0 } }

pub fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    unsafe {
        let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        GetAsyncKeyState(button as i32) < 0
    }
}

pub fn window_under_cursor() -> usize {
    let mut point = POINT::default();
    unsafe {
        if GetCursorPos(&mut point) == 0 { return 0; }
        GetAncestor(WindowFromPoint(point), GA_ROOT) as usize
    }
}

pub fn arrange_note(hwnd: usize, x: i32, y: i32) {
    unsafe {
        SetWindowPos(hwnd as HWND, HWND_TOP, x, y, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
}

pub fn drag_together(leader: usize, followers: Vec<usize>) {
    let Some(origin) = rect(leader) else { return };
    let followers = followers.into_iter().filter_map(|hwnd| rect(hwnd).map(|r| (hwnd, r)))
        .collect::<Vec<_>>();
    std::thread::spawn(move || {
        let mut previous = (0, 0);
        loop {
            let pressed = primary_button_down();
            let Some(current) = rect(leader) else { break };
            let delta = (current.left - origin.left, current.top - origin.top);
            if delta != previous {
                for (hwnd, original) in &followers {
                    unsafe {
                        SetWindowPos(*hwnd as HWND, std::ptr::null_mut(),
                            original.left + delta.0, original.top + delta.1, 0, 0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS);
                    }
                }
                previous = delta;
            }
            if !pressed { break; }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    });
}

/// Only called by the user's explicit return-to-tab action.
pub fn activate(target:&Target) {
    if !valid(target){return;}
    unsafe {
        if IsIconic(target.hwnd as HWND)!=0 {ShowWindowAsync(target.hwnd as HWND,SW_RESTORE);}
        SetForegroundWindow(target.hwnd as HWND);
    }
}

/// Explicit note click raises the group without handing focus to the target.
fn own_stack_above(note:HWND,target:HWND)->bool {
    unsafe {
        let mut current=GetWindow(note,GW_HWNDNEXT);
        while !current.is_null(){
            if current==target{return true;}
            if IsWindowVisible(current)!=0 {
                let mut pid=0;GetWindowThreadProcessId(current,&mut pid);
                if pid!=std::process::id(){return false;}
            }
            current=GetWindow(current,GW_HWNDNEXT);
        }
        false
    }
}

pub fn raise_group(note:usize,target:&Target,pin:bool,restore_minimized:bool)->Result<(),String> {
    if !valid(target){return Ok(())}
    unsafe {
        let target_window=target.hwnd as HWND;
        if IsIconic(target_window) != 0 {
            // Windows can focus a note while minimizing its target. Only a
            // direct action on the note or list should restore the target.
            if !restore_minimized {
                return Ok(());
            }
            ShowWindowAsync(target_window, SW_SHOWNOACTIVATE);
        }
        // Clicking a parent/child already raises that note. If only our own
        // notes separate it from the app, raising the app again would put the
        // remaining relatives behind the app until the geometry worker runs.
        if own_stack_above(note as HWND,target_window){return Ok(());}
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
pub fn place_note(hwnd: usize, anchor: usize, target: usize, (x,y): (i32,i32), pin: bool) -> bool {
    unsafe {
        let note=hwnd as HWND;
        let flags=SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER;
        let topmost = |window| (GetWindowLongPtrW(window,GWL_EXSTYLE) as u32 & WS_EX_TOPMOST)!=0;
        let in_top_band = pin || topmost(target as HWND);
        let band_top = if in_top_band { HWND_TOPMOST } else { HWND_TOP };
        let note_topmost = topmost(note);
        let mut changed=false;
        if note_topmost != in_top_band {
            let band = if in_top_band { HWND_TOPMOST } else { HWND_NOTOPMOST };
            let show=if IsWindowVisible(note)==0{SWP_SHOWWINDOW}else{0};
            changed=SetWindowPos(note,band,x,y,0,0,flags|show)!=0;
        }
        let same_position=rect(hwnd).is_some_and(|r|r.left==x&&r.top==y);
        let hidden=IsWindowVisible(note)==0;
        let flags=flags|(if same_position{SWP_NOMOVE}else{0})|(if hidden{SWP_SHOWWINDOW}else{0});
        if anchor == 0 && pin {
            if same_position&&!hidden{return changed;}
            return SetWindowPos(note,std::ptr::null_mut(),x,y,0,0,flags|SWP_NOZORDER)!=0||changed;
        }
        let before = if anchor == 0 || anchor == HWND_TOPMOST as usize {
            std::ptr::null_mut()
        } else {
            GetWindow(anchor as HWND,GW_HWNDPREV)
        };
        if before == note {
            if same_position&&!hidden{return changed;}
            SetWindowPos(note,std::ptr::null_mut(),x,y,0,0,flags|SWP_NOZORDER)!=0||changed
        } else {
            let after = if before.is_null() || topmost(before) != in_top_band { band_top } else { before };
            let placed=SetWindowPos(note,after,x,y,0,0,flags)!=0;
            #[cfg(test)] if !placed {eprintln!("SetWindowPos failed: {}",GetLastError());}
            placed||changed
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
    fn native_descendants_stay_above_parent_and_inherit_its_topmost_band() {
        struct Windows(Vec<HWND>);
        impl Drop for Windows { fn drop(&mut self){for h in self.0.iter().rev(){unsafe{DestroyWindow(*h);}}} }
        unsafe {
            let class:Vec<u16>="STATIC\0".encode_utf16().collect();
            let title:Vec<u16>="Sticky layering fixture\0".encode_utf16().collect();
            let mut windows=Windows(Vec::new());
            for _ in 0..4 {
                let h=CreateWindowExW(0,class.as_ptr(),title.as_ptr(),WS_POPUP,-25000,-25000,80,80,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
                assert!(!h.is_null(),"fixture window creation");windows.0.push(h);
            }
            let [target,parent,child,grandchild]=windows.0.clone().try_into().unwrap();
            let place=||{
                [place_note(parent as usize,target as usize,target as usize,(-25000,-25000),false),
                place_note(child as usize,parent as usize,parent as usize,(-25000,-25000),false),
                place_note(grandchild as usize,child as usize,child as usize,(-25000,-25000),false)]
            };
            let above=|upper,lower|{
                let mut cursor=GetWindow(lower,GW_HWNDPREV);
                while !cursor.is_null(){if cursor==upper{return true;}cursor=GetWindow(cursor,GW_HWNDPREV);}
                false
            };
            place();assert!(above(parent,target)&&above(child,parent)&&above(grandchild,child));
            assert!(own_stack_above(grandchild,target));
            SetWindowPos(parent,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
            assert!(own_stack_above(parent,target));
            place();
            for _ in 0..100 {
                assert!(!place_note(parent as usize,target as usize,target as usize,(-25000,-25000),false));
                assert!(!place_note(child as usize,parent as usize,parent as usize,(-25000,-25000),false));
                assert!(!place_note(grandchild as usize,child as usize,child as usize,(-25000,-25000),false));
            }
            SetWindowPos(target,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
            let changed=place();assert!(above(child,target)&&above(grandchild,target),"native changed={changed:?}; parent/target={} child/parent={} grand/child={} child/target={} grand/target={}",above(parent,target),above(child,parent),above(grandchild,child),above(child,target),above(grandchild,target));
            detach(parent as usize,true);
            place_note(child as usize,parent as usize,parent as usize,(-25000,-25000),false);
            place_note(grandchild as usize,child as usize,child as usize,(-25000,-25000),false);
            for h in [child,grandchild]{assert_ne!(GetWindowLongPtrW(h,GWL_EXSTYLE) as u32 & WS_EX_TOPMOST,0);}
            detach(parent as usize,false);place();
            for h in [parent,child,grandchild]{assert_eq!(GetWindowLongPtrW(h,GWL_EXSTYLE) as u32 & WS_EX_TOPMOST,0);}
        }
    }
    #[test]
    fn follows_right_edge_and_keeps_dragged_offset() {
        let mut b = Binding { target:Target { hwnd:0,pid:0,born:String::new(),title:String::new() },right:-16,top:50 };
        let r = Rect { left:100,top:200,right:1100,bottom:1000 };
        assert_eq!(b.position(r,280),(804,250));
        b.reposition(r,280,700,300);
        assert_eq!(b.position(Rect {right:1400,top:400,..r},280),(1000,500));
    }
}
