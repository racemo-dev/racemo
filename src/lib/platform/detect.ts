// ─────────────────────────────────────────────
// Platform Detection
//
// 플랫폼별 기능 분기에 사용하는 공용 유틸.
// 새로운 플랫폼별 모듈(clipboard, keymap 등)을 추가할 때 여기서 가져다 쓴다.
// ─────────────────────────────────────────────

export function isMac(): boolean {
    return navigator.platform.toUpperCase().includes("MAC");
}

export function isWindows(): boolean {
    return navigator.platform.toUpperCase().includes("WIN");
}

export function isLinux(): boolean {
    // "LINUX"를 명시적으로 체크한다.
    // !isMac() && !isWindows() 방식은 향후 새 플랫폼(BSD, WebOS 등)이
    // 추가될 때 의도치 않게 Linux로 분류될 수 있다.
    return navigator.platform.toUpperCase().includes("LINUX");
}
