/// Windows 저수준 키보드 훅 — 특정 가상 키를 OS 레벨에서 차단한다.
///
/// WH_KEYBOARD_LL 은 후킹 스레드의 메시지 루프에서 콜백이 호출된다.
/// 별도 스레드를 띄워 메시지 루프를 돌리므로 메인 스레드를 차단하지 않는다.
#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetForegroundWindow,
        GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
        HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    };

    // VK_HANGUL = 0x15 (한/영 전환 키)
    const VK_HANGUL: u32 = 0x15;

    static BLOCK_HANGUL: AtomicBool = AtomicBool::new(false);
    // HHOOK.0 (*mut c_void) 를 usize 로 저장해 Send 제약 우회
    static HOOK_RAW: AtomicUsize = AtomicUsize::new(0);

    /// 현재 포커스 창이 이 프로세스 소유인지 확인.
    unsafe fn is_own_window_focused() -> bool {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        pid == GetCurrentProcessId()
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && BLOCK_HANGUL.load(Ordering::Relaxed) && is_own_window_focused() {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            if kb.vkCode == VK_HANGUL {
                return LRESULT(1); // 키 이벤트 삼킴
            }
        }
        let raw = HOOK_RAW.load(Ordering::Relaxed);
        let hook = HHOOK(raw as *mut std::ffi::c_void);
        CallNextHookEx(hook, code, wparam, lparam)
    }

    pub fn install() {
        std::thread::Builder::new()
            .name("keyboard-hook".into())
            .spawn(|| unsafe {
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0)
                    .expect("WH_KEYBOARD_LL 설치 실패");
                HOOK_RAW.store(hook.0 as usize, Ordering::Relaxed);

                // 메시지 루프 — 훅 콜백이 이 루프에서 dispatch 된다
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    DispatchMessageW(&msg);
                }
            })
            .expect("keyboard-hook 스레드 생성 실패");
    }

    pub fn set_block_hangul(enabled: bool) {
        BLOCK_HANGUL.store(enabled, Ordering::Relaxed);
    }
}

#[cfg(target_os = "windows")]
pub use imp::{install, set_block_hangul};

#[cfg(not(target_os = "windows"))]
pub fn install() {}

#[cfg(not(target_os = "windows"))]
pub fn set_block_hangul(_enabled: bool) {}
