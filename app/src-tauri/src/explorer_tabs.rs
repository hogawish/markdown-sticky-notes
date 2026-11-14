use crate::{follow, tab_context::{TabLink, TabRef}};
use windows::Win32::{
    Foundation::{HWND, POINT},
    System::{
        Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize, SAFEARRAY},
        Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
        Variant::{VARIANT, VT_I4},
    },
    UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationSelectionItemPattern,
        TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_SelectionItemPatternId,
        UIA_TabItemControlTypeId,
    },
};

pub const KEY: &str = "explorer";

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct RuntimeId(*mut SAFEARRAY);

impl Drop for RuntimeId {
    fn drop(&mut self) {
        let _ = unsafe { SafeArrayDestroy(self.0) };
    }
}

fn runtime_id(tab: &IUIAutomationElement) -> windows::core::Result<String> {
    let array = RuntimeId(unsafe { tab.GetRuntimeId()? });
    let first = unsafe { SafeArrayGetLBound(array.0, 1)? };
    let last = unsafe { SafeArrayGetUBound(array.0, 1)? };
    let mut parts = Vec::new();
    for index in first..=last {
        let mut value = 0i32;
        unsafe { SafeArrayGetElement(array.0, &index, (&mut value as *mut i32).cast())? };
        parts.push(value.to_string());
    }
    Ok(parts.join(","))
}

fn with_explorer<T>(
    target: &follow::Target,
    action: impl FnOnce(&IUIAutomation, &IUIAutomationElement) -> windows::core::Result<T>,
) -> Result<T, String> {
    if !follow::valid(target) || follow::application_name(target).as_deref() != Some("explorer.exe") {
        return Err("エクスプローラーのウィンドウが閉じられました".into());
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()
            .map_err(|error| error.to_string())?;
        let _apartment = ComApartment;
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        let window = automation.ElementFromHandle(HWND(target.hwnd as _))
            .map_err(|error| error.to_string())?;
        action(&automation, &window).map_err(|error| error.message())
    }
}

pub fn pick(target: follow::Target, (x, y): (i32, i32)) -> Result<TabLink, String> {
    let picked = with_explorer(&target, |automation, window| unsafe {
        let walker = automation.ControlViewWalker()?;
        let mut element = automation.ElementFromPoint(POINT { x, y })?;
        let mut tab = None;
        let mut in_tab_strip = false;
        while !automation.CompareElements(&element, window)?.as_bool() {
            if tab.is_none() && element.CurrentControlType()? == UIA_TabItemControlTypeId {
                tab = Some(element.clone());
            } else if tab.is_some() && element.CurrentAutomationId()?.to_string() == "TabListView" {
                in_tab_strip = true;
            }
            element = walker.GetParentElement(&element)?;
        }
        if !in_tab_strip {
            return Ok(None);
        }
        tab.map(|tab| Ok((runtime_id(&tab)?, tab.CurrentName()?.to_string())))
            .transpose()
    });
    let (id, label) = picked.ok().flatten()
        .ok_or("エクスプローラーのタブ名をクリックしてください")?;
    if id.is_empty() {
        return Err("タブを識別できませんでした".into());
    }
    Ok(TabLink { target, tab: TabRef { key: KEY.into(), id, label } })
}

pub fn activate(link: &TabLink) -> Result<(), String> {
    with_explorer(&link.target, |automation, window| unsafe {
        let mut value = VARIANT::default();
        let inner = &mut *value.Anonymous.Anonymous;
        inner.vt = VT_I4;
        inner.Anonymous.lVal = UIA_TabItemControlTypeId.0;
        let condition = automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &value)?;
        let tabs = window.FindAll(TreeScope_Descendants, &condition)?;
        for index in 0..tabs.Length()? {
            let tab = tabs.GetElement(index)?;
            if runtime_id(&tab).is_ok_and(|id| id == link.tab.id) {
                let selection: IUIAutomationSelectionItemPattern =
                    tab.GetCurrentPatternAs(UIA_SelectionItemPatternId)?;
                follow::activate(&link.target);
                selection.Select()?;
                return selection.CurrentIsSelected().map(|selected| selected.as_bool());
            }
        }
        Ok(false)
    })?
    .then_some(())
    .ok_or_else(|| "元のタブが見つかりません。リンクし直してください".into())
}
