import { Terminal } from "@xterm/xterm";
import { IMEInterceptorBase } from "./base";

// ─────────────────────────────────────────────
// LinuxIMEInterceptor — 디버깅 모드 (로그만)
// ─────────────────────────────────────────────

export class LinuxIMEInterceptor extends IMEInterceptorBase {
    constructor(terminal: Terminal, container: HTMLDivElement) {
        super(terminal, container, "Linux");
    }

    protected handleCompositionStart(e: CompositionEvent) {
        this.log("compositionstart", `data="${e.data}"`);
    }

    protected handleCompositionUpdate(e: CompositionEvent) {
        this.log("compositionupdate", `data="${e.data}"`);
    }

    protected handleCompositionEnd(e: CompositionEvent) {
        this.log("compositionend", `data="${e.data}"`);
    }

    protected handleBeforeInput(e: InputEvent) {
        this.log("beforeinput", `inputType="${e.inputType}" data="${e.data}"`);
    }

    protected handleInput(e: Event) {
        const ie = e as InputEvent;
        this.log("input", `inputType="${ie.inputType}" data="${ie.data}"`);
    }

    protected handleKeyDown(e: KeyboardEvent) {
        this.log("keydown", `key="${e.key}" keyCode=${e.keyCode} isComposing=${e.isComposing}`);
    }

    protected handleBlur() {
        this.log("blur", "포커스 해제");
    }
}
