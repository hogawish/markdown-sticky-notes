//! Isolated Win32 host for follow integration tests. Never drives a user's apps.
use std::{io::{self,BufRead,Write},sync::mpsc,time::Duration};
use windows_sys::Win32::{Foundation::*,UI::WindowsAndMessaging::*};
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
fn main(){
    unsafe { windows_sys::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    let class=wide("STATIC"); let title=wide("Sticky follow fixture");
    let other_title=wide("Sticky unrelated fixture");
    unsafe {
        let a=CreateWindowExW(0,class.as_ptr(),title.as_ptr(),WS_OVERLAPPEDWINDOW,100,100,900,650,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
        let b=CreateWindowExW(0,class.as_ptr(),other_title.as_ptr(),WS_OVERLAPPEDWINDOW,80,80,800,600,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());
        assert!(!a.is_null() && !b.is_null());
        if std::env::args().any(|a|a=="--show"){ShowWindow(a,SW_SHOWNOACTIVATE);}
        println!("{}",serde_json::json!({"a":a as usize,"b":b as usize})); io::stdout().flush().unwrap();
        let (tx,rx)=mpsc::channel();
        std::thread::spawn(move||{for line in io::stdin().lock().lines().map_while(Result::ok){if tx.send(line).is_err(){break}}});
        let mut saved_cursor=None;
        loop {
            let mut msg=MSG::default(); while PeekMessageW(&mut msg,std::ptr::null_mut(),0,0,PM_REMOVE)!=0 {TranslateMessage(&msg);DispatchMessageW(&msg);}
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(line)=>{
                    let v:serde_json::Value=serde_json::from_str(&line).unwrap();
                    let own=if v["target"]=="b" {b}else{a};
                    let action=v["action"].as_str().unwrap();
                    if action=="focus-test-app" {
                        let h=v["hwnd"].as_u64().unwrap() as HWND;let mut pid=0;
                        GetWindowThreadProcessId(h,&mut pid);
                        let mut text=[0u16;256];let len=GetWindowTextW(h,text.as_mut_ptr(),256);
                        let title=String::from_utf16_lossy(&text[..len.max(0) as usize]);
                        assert!(pid==v["pid"].as_u64().unwrap() as u32 && title.contains("Sticky "),"Only explicitly identified synthetic test windows may be focused");
                        ShowWindow(h,SW_RESTORE);let ok=SetForegroundWindow(h);
                        println!("{}",serde_json::json!({"ok":ok!=0,"foreground":GetForegroundWindow() as usize}));io::stdout().flush().unwrap();continue;
                    }
                    if action=="focus-own-note" || action=="click-own-note" {
                        use windows_sys::Win32::System::Threading::*;
                        let h=v["hwnd"].as_u64().unwrap() as HWND;let mut pid=0;GetWindowThreadProcessId(h,&mut pid);
                        assert_eq!(pid,v["pid"].as_u64().unwrap() as u32);
                        let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,pid);assert!(!process.is_null());
                        let mut path=[0u16;32768];let mut len=path.len() as u32;
                        let ok=QueryFullProcessImageNameW(process,0,path.as_mut_ptr(),&mut len);CloseHandle(process);assert_ne!(ok,0);
                        let actual=String::from_utf16_lossy(&path[..len as usize]).to_lowercase();
                        let executable=std::env::current_exe().unwrap();let expected=executable.parent().unwrap().parent().unwrap().join("app.exe").to_string_lossy().to_lowercase();
                        assert_eq!(actual,expected,"Only the companion test binary can be focused");
                        if action=="click-own-note" {
                            use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
                            let mut original=POINT::default();GetCursorPos(&mut original);
                            let mut rect=RECT::default();GetWindowRect(h,&mut rect);
                            let point=POINT{x:rect.right-35,y:rect.top+100};
                            assert_eq!(GetAncestor(WindowFromPoint(point),GA_ROOT),h,"Click point must belong to the companion test note");
                            SetCursorPos(point.x,point.y);
                            let mouse=|flags|INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dx:0,dy:0,mouseData:0,dwFlags:flags,time:0,dwExtraInfo:0}}};
                            let down=mouse(MOUSEEVENTF_LEFTDOWN);let up=mouse(MOUSEEVENTF_LEFTUP);
                            assert_eq!(SendInput(1,&down,std::mem::size_of::<INPUT>() as i32),1);
                            std::thread::sleep(Duration::from_millis(80));
                            let released=SendInput(1,&up,std::mem::size_of::<INPUT>() as i32);
                            saved_cursor.get_or_insert(original);assert_eq!(released,1);
                            println!("{}",serde_json::json!({"foreground":GetForegroundWindow() as usize}));io::stdout().flush().unwrap();continue;
                        }
                        let thread=GetCurrentThreadId();let foreground_thread=GetWindowThreadProcessId(GetForegroundWindow(),std::ptr::null_mut());
                        let attached=AttachThreadInput(thread,foreground_thread,1);
                        ShowWindow(h,SW_RESTORE);SetForegroundWindow(h);
                        if attached!=0{AttachThreadInput(thread,foreground_thread,0);}
                        println!("{}",serde_json::json!({"foreground":GetForegroundWindow() as usize}));io::stdout().flush().unwrap();continue;
                    }
                    if action=="place-test-app" || action=="close-test-app" {
                        let h=v["hwnd"].as_u64().unwrap() as HWND;let mut pid=0;GetWindowThreadProcessId(h,&mut pid);
                        assert_eq!(pid,v["pid"].as_u64().unwrap() as u32);
                        let mut text=[0u16;256];let n=GetWindowTextW(h,text.as_mut_ptr(),256);
                        let title=String::from_utf16_lossy(&text[..n.max(0) as usize]);
                        assert!(title.starts_with("Sticky target ") || title.starts_with("Sticky blocker "),"Only synthetic test windows can be placed or closed");
                        if action=="close-test-app"{PostMessageW(h,WM_CLOSE,0,0);}else{
                            SetWindowPos(h,std::ptr::null_mut(),v["x"].as_i64().unwrap() as i32,v["y"].as_i64().unwrap() as i32,v["w"].as_i64().unwrap() as i32,v["h"].as_i64().unwrap() as i32,SWP_NOZORDER|SWP_NOACTIVATE|SWP_SHOWWINDOW);
                        }
                        println!("{}",serde_json::json!({"ok":true}));io::stdout().flush().unwrap();continue;
                    }
                    if action=="is-above" {
                        let wanted=v["hwnd"].as_u64().unwrap() as HWND;
                        let mut current=GetWindow(v["other"].as_u64().unwrap() as HWND,GW_HWNDPREV);
                        let mut found=false;
                        while !current.is_null(){if current==wanted{found=true;break}current=GetWindow(current,GW_HWNDPREV);}
                        println!("{}",serde_json::json!({"above":found}));io::stdout().flush().unwrap();continue;
                    }
                    if action == "windows" {
                        unsafe extern "system" fn collect(h:HWND,p:LPARAM)->i32 {
                            let data=unsafe{&mut *(p as *mut (u32,Vec<usize>))}; let mut pid=0;
                            unsafe{GetWindowThreadProcessId(h,&mut pid);}
                            if pid==data.0 {data.1.push(h as usize);} 1
                        }
                        let mut data=(v["pid"].as_u64().unwrap() as u32,Vec::<usize>::new());
                        EnumWindows(Some(collect),&mut data as *mut _ as LPARAM);
                        println!("{}",serde_json::json!(data.1)); io::stdout().flush().unwrap(); continue;
                    }
                    match action {
                        "move"=>{SetWindowPos(own,std::ptr::null_mut(),v["x"].as_i64().unwrap() as i32,v["y"].as_i64().unwrap() as i32,v["w"].as_i64().unwrap() as i32,v["h"].as_i64().unwrap() as i32,SWP_NOZORDER|SWP_NOACTIVATE);},
                        "activate"=>{
                            // Explicit isolated-test focus, including when Windows denies a background console.
                            let thread=windows_sys::Win32::System::Threading::GetCurrentThreadId();
                            let foreground_thread=GetWindowThreadProcessId(GetForegroundWindow(),std::ptr::null_mut());
                            let attached=windows_sys::Win32::System::Threading::AttachThreadInput(thread,foreground_thread,1);
                            ShowWindow(own,SW_RESTORE);SetForegroundWindow(own);
                            if attached!=0{windows_sys::Win32::System::Threading::AttachThreadInput(thread,foreground_thread,0);}
                        },
                        "minimize"=>{ShowWindow(own,SW_MINIMIZE);},
                        "close"=>{DestroyWindow(own);},
                        "quit"=>break,
                        "inspect"=>{},
                        _=>panic!("unknown fixture action")
                    }
                    let h=v["hwnd"].as_u64().map(|h|h as HWND).unwrap_or(own);
                    let mut r=RECT::default(); GetWindowRect(h,&mut r);
                    let mut text=[0u16;256]; let len=GetWindowTextW(h,text.as_mut_ptr(),256);
                    println!("{}",serde_json::json!({"title":String::from_utf16_lossy(&text[..len.max(0) as usize]),"x":r.left,"y":r.top,"w":r.right-r.left,"h":r.bottom-r.top,"visible":IsWindowVisible(h)!=0,"minimized":IsIconic(h)!=0,"topmost":(GetWindowLongPtrW(h,GWL_EXSTYLE) as u32 & WS_EX_TOPMOST)!=0,"foreground":GetForegroundWindow() as usize}));
                    io::stdout().flush().unwrap();
                },
                Err(mpsc::RecvTimeoutError::Disconnected)=>break,
                Err(_)=>{}
            }
        }
        if let Some(p)=saved_cursor {SetCursorPos(p.x,p.y);}
        if IsWindow(a)!=0 {DestroyWindow(a);} if IsWindow(b)!=0 {DestroyWindow(b);}
    }
}
