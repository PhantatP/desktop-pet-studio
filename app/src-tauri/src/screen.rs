//! Win32 queries: the cursor position and the rectangles of normal on-screen windows.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetCursorPos, GetWindowLongPtrW, GetWindowTextLengthW, IsIconic, IsWindowVisible,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// Cursor position in physical screen pixels.
pub fn cursor() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    (p.x, p.y)
}

struct Search {
    skip: isize,
    rects: Vec<[i32; 4]>,
}

/// [left, top, right, bottom] in physical pixels of visible, titled, non-tool windows, topmost first.
pub fn window_rects(skip: isize) -> Vec<[i32; 4]> {
    let mut search = Search { skip, rects: Vec::new() };
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    search.rects
}

unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
    let search = unsafe { &mut *(data as *mut Search) };
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if hwnd as isize == search.skip
            || IsWindowVisible(hwnd) == 0
            || IsIconic(hwnd) != 0
            || GetWindowTextLengthW(hwnd) == 0
            || ex_style & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW) != 0
        {
            return 1;
        }
        // cloaked = hidden by the shell, e.g. on another virtual desktop
        let mut cloaked: u32 = 0;
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut c_void, 4);
        if cloaked != 0 {
            return 1;
        }
        // the visible frame, without the invisible resize border GetWindowRect includes
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut r as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        search.rects.push([r.left, r.top, r.right, r.bottom]);
    }
    1
}
