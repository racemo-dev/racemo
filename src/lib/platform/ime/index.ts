import { Terminal } from "@xterm/xterm";
import { isMac, isWindows } from "../detect";
import { IMEInterceptorBase } from "./base";
import { WindowsIMEInterceptor } from "./windows";
import { MacIMEInterceptor } from "./mac";
import { LinuxIMEInterceptor } from "./linux";
import { logger } from "../../logger";

export type { IMEHandlers } from "./base";

// ─────────────────────────────────────────────
// Public Type
//
// 외부에서는 구체 클래스 대신 이 타입만 사용한다.
// ─────────────────────────────────────────────

export type IMEInterceptor = IMEInterceptorBase;

// ─────────────────────────────────────────────
// Factory
//
// 플랫폼별 동작 차이 요약
// ┌──────────────────────────────────┬─────────┬───────┬───────┐
// │ 동작                             │ Windows │ macOS │ Linux │
// ├──────────────────────────────────┼─────────┼───────┼───────┤
// │ 음절 경계 flush                  │   ✅    │  ❌   │  ❌   │
// │  compositionupdate에서 buffer가  │         │       │       │
// │  2자 이상이면 앞 글자를 즉시     │         │       │       │
// │  flush한다.                      │         │       │       │
// ├──────────────────────────────────┼─────────┼───────┼───────┤
// │ keyCode 229 (Process Key) 차단   │   ✅    │  ❌   │  ❌   │
// │  WebView2가 IME 처리 키를 229로  │         │       │       │
// │  전달하므로 xterm 전파를 막는다. │         │       │       │
// ├──────────────────────────────────┼─────────┼───────┼───────┤
// │ WKWebView Korean legacy path     │   ❌    │  ✅   │  ❌   │
// │  compositionstart 없이 한글이    │         │       │       │
// │  insertText로 직접 오는 경우를   │         │       │       │
// │  beforeinput에서 가로챈다.       │         │       │       │
// └──────────────────────────────────┴─────────┴───────┴───────┘
//
// 로그 확인: DevTools Console → "[IME]" 로 필터링
// ─────────────────────────────────────────────

export function createIMEInterceptor(terminal: Terminal, container: HTMLDivElement): IMEInterceptor {
    if (isMac()) {
        logger.debug("[IME] Platform: macOS → MacIMEInterceptor");
        return new MacIMEInterceptor(terminal, container);
    }
    if (isWindows()) {
        logger.debug("[IME] Platform: Windows → WindowsIMEInterceptor");
        return new WindowsIMEInterceptor(terminal, container);
    }
    logger.debug("[IME] Platform: Linux → LinuxIMEInterceptor");
    return new LinuxIMEInterceptor(terminal, container);
}
