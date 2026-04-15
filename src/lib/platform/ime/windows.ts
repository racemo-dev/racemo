import { Terminal, type IBuffer } from "@xterm/xterm";
import { IMEInterceptorBase } from "./base";
import { getDisplayWidth } from "../../utils/unicode";
import { getXTermCore } from "../../xtermInternal";

// ─────────────────────────────────────────────
// WindowsIMEInterceptor — Windows WebView2 전용 커스텀 IME 오버레이
//
// xterm.js 내장 IME 오버레이는 한글 조합 시 글자가 사라지는 버그가 있으므로,
// macOS와 동일하게 composition 이벤트를 가로채서 커스텀 오버레이로 렌더링한다.
//
// IME 세션 생명주기:
//   시작: 첫 compositionstart (sessionActive=false → true, onStart 호출)
//   유지: compositionend 후에도 sessionActive 유지 (다음 음절 대비)
//   종료: 비수정자 keydown(비조합 상태) 또는 blur → endSession → flushAll
//
// 오버레이 전략 (깜빡임 방지):
//   오버레이는 "확정된 음절(flushedText) + 현재 조합 중인 음절"을 compositionAnchorX부터 표시.
//   → PSReadLine erase+redraw 구간에 오버레이가 해당 영역을 덮어 blank 프레임 차단.
//
//   PTY 에코가 도착하면 onWriteParsed에서 커서 위치를 확인해 anchor를 보정하고
//   flushedText를 정리한다.
//
//   세션 종료(space 등) 시 clearOnNextKey 플래그로 다음 keydown 시점에 제거.
//   → 마지막 PTY 에코가 xterm에 반영된 후에 오버레이를 제거하여 깜빡임 방지.
// ─────────────────────────────────────────────

export class WindowsIMEInterceptor extends IMEInterceptorBase {
    private sessionActive = false;

    // endSession() 후 즉시 clearOverlay()하면 PTY 에코 전에 오버레이가 사라진다.
    // 다음 비-229 keydown에서 지우도록 지연한다.
    private clearOnNextKey = false;

    /** terminal.onWriteParsed 구독 핸들. 에코 보정용. */
    private renderDisposable: { dispose(): void } | null = null;
    /** 에코로 아직 확인되지 않은 디스플레이 폭 합계 */
    private unconfirmedEchoWidth = 0;
    /** 미확인 에코 구간의 시작 cursorX */
    private echoBaseCursorX = 0;
    /** 마지막 에코 도착 시 cursor */

    // PTY 에코에서 실제 셀 색상을 읽어 오버레이 색상을 동기화했는지 여부.
    private colorSyncedFromEcho = false;
    /**
     * OSC 133;C 수신 후 아직 133;B를 받지 못한 상태 = 명시적 앱 모드.
     * 초기값 false → 기본은 shell 모드 (터미널 시작/재연결 직후에도 올바른 위치 사용).
     */
    private explicitAppMode = false;

    constructor(terminal: Terminal, container: HTMLDivElement) {
        super(terminal, container, "Windows");
    }

    /** 뷰포트 아래→위 스캔하여 내용이 있는 마지막 행 반환 */
    private getLastContentRow(): number {
        const buf = this.terminal.buffer.active;
        for (let row = this.terminal.rows - 1; row >= 0; row--) {
            const line = buf.getLine(buf.baseY + row);
            if (!line) continue;
            for (let col = 0; col < this.terminal.cols; col++) {
                const cell = line.getCell(col);
                if (cell && cell.getChars().trim()) return row;
            }
        }
        return 0;
    }

    public override setPromptY(y: number): void {
        super.setPromptY(y);
        this.explicitAppMode = false;
    }

    public override clearPromptY(): void {
        super.clearPromptY();
        this.explicitAppMode = true;
    }

    protected override getOverlayPosition(): { x: number; y: number } {
        // OSC 133;B 수신 → 확정 shell 모드
        if (this.promptY !== null) {
            return { x: this.compositionAnchorX, y: this.promptY };
        }
        // OSC 133;C 수신 후 아직 133;B 없음 → 명시적 앱 모드
        if (this.explicitAppMode) {
            const lastRow = this.getLastContentRow();
            return { x: 0, y: Math.min(lastRow + 1, this.terminal.rows - 1) };
        }
        // 기본값: shell 모드 (초기 상태, 재연결 직후 등)
        return { x: this.compositionAnchorX, y: this.compositionAnchorY };
    }

    private startSession() {
        this.sessionActive = true;
        this.inputBuffer = "";
        this.activeTextStart = 0;
        this.flushedText = "";
        this.flushedDisplayWidth = 0;
        this.unconfirmedEchoWidth = 0;
        this.colorSyncedFromEcho = false;

        const b = this.terminal.buffer.active;
        this.compositionAnchorX = b.cursorX;
        this.compositionAnchorY = b.cursorY;
        this.log("startSession", `anchor=(${b.cursorX}, ${b.cursorY}) promptY=${this.promptY}`);

        this.captureCompositionColors();
        this.setupRenderListener();
        this.onStart?.();
    }

    private sendToInput(text: string) {
        const w = getDisplayWidth(text);
        if (this.unconfirmedEchoWidth === 0) {
            this.echoBaseCursorX = this.terminal.buffer.active.cursorX;
        }
        this.unconfirmedEchoWidth += w;

        // 예측: anchor를 즉시 전진 (에코 도착 전에도 올바른 위치에 오버레이)
        this.compositionAnchorX += w;

        this.flushedText += text;
        this.flushedDisplayWidth += w;
        this.onInput?.(text);
    }

    // xterm 버퍼에서 특정 셀의 실제 fg CSS 색상을 읽는다.
    private readCellFgCss(b: IBuffer, x: number): string | null {
        try {
            const line = b.getLine(b.cursorY + b.baseY);
            if (!line) return null;
            const cell = line.getCell(x);
            if (!cell) return null;

            const colors = getXTermCore(this.terminal)?._colorManager?.colors;
            if (!colors) return null;

            const mode = cell.getFgColorMode(); // 0=default, 1=palette, 2=RGB
            const val = cell.getFgColor();

            if (mode === 1) {
                return colors.ansi?.[val]?.css ?? null;
            } else if (mode === 2) {
                const r = (val >> 16) & 0xFF;
                const g = (val >> 8) & 0xFF;
                const bl = val & 0xFF;
                return `rgb(${r},${g},${bl})`;
            } else {
                return colors.foreground?.css ?? null;
            }
        } catch {
            return null;
        }
    }

    /**
     * PTY 에코 감지 — onWriteParsed 사용.
     * onRender(RAF 기반)와 달리 write() 파싱 완료 직후 발생하므로
     * PSReadLine 등의 커서 이동이 모두 끝난 최종 위치를 정확히 읽을 수 있다.
     */
    private setupRenderListener() {
        this.renderDisposable?.dispose();
        this.renderDisposable = this.terminal.onWriteParsed(() => {
            if (!this.sessionActive) return;

            const b = this.terminal.buffer.active;
            const cursorX = b.cursorX;
            const cursorY = b.cursorY;

            if (this.unconfirmedEchoWidth === 0) return;

            const actualAdvance = cursorX - this.echoBaseCursorX;

            if (actualAdvance > 0) {
                // 첫 번째 에코 감지 시 실제 셀 색상으로 오버레이 색상 동기화
                if (!this.colorSyncedFromEcho) {
                    const fg = this.readCellFgCss(b, this.echoBaseCursorX);
                    if (fg && this.cachedCompositionColors) {
                        this.cachedCompositionColors = { ...this.cachedCompositionColors, fg };
                        this.log("onWriteParsed", `색상 동기화: fg="${fg}"`);
                    }
                    this.colorSyncedFromEcho = true;
                }

                // 에코 도착 확인 → anchor를 실제 커서 위치로 보정
                this.compositionAnchorX = cursorX;
                this.compositionAnchorY = cursorY;
                this.log("onWriteParsed", `echo → anchor=(${cursorX}, ${cursorY}) advance=${actualAdvance}`);

                this.unconfirmedEchoWidth = 0;
                this.flushedText = "";
                this.flushedDisplayWidth = 0;

                // 에코 소화 완료. 조합 중이면 현재 조합 글자로 오버레이 갱신.
                if (this.compositionActive && this.inputBuffer) {
                    this.updateOverlay(this.inputBuffer);
                }
            }
        });
    }

    // ─────────────────────────────────────────
    // Composition 이벤트 핸들러
    // ─────────────────────────────────────────

    protected handleCompositionStart(e: CompositionEvent) {
        if (!this.interceptEnabled) return;
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        // 스크롤 직후(200ms 이내) 새 세션 시작이면 ConPTY/WebView2가 spurious하게
        // 트리거한 composition으로 간주해 무시한다.
        // 기존 세션 유지 중인 음절 연속 조합은 허용한다.
        if (!this.sessionActive && performance.now() - this.lastWheelTime < 200) {
            this.log("compositionstart", "스크롤 직후 spurious composition 무시");
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const startingNewSession = !this.sessionActive;
        this.compositionActive = true;
        this.imeActive = true;
        // 새 조합 시작 → 이전 세션의 pending clear 취소
        this.clearOnNextKey = false;
        this.checkSmartToggle();
        if (!this.interceptEnabled) return;

        if (startingNewSession) {
            this.startSession();
            this.log("compositionstart", `IME 시작 anchor=(${this.compositionAnchorX},${this.compositionAnchorY})`);
        } else {
            this.log("compositionstart", `다음 음절 anchor=${this.compositionAnchorX}`);
        }

        e.preventDefault();
        e.stopPropagation();
    }

    protected handleCompositionUpdate(e: CompositionEvent) {
        if (!this.interceptEnabled) return;
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        const data = e.data ?? "";
        this.inputBuffer = data;
        this.log("compositionupdate", `data="${data}"`);

        // 현재 조합 중인 음절만 표시.
        // flushedText는 PTY에 이미 전송된 텍스트이므로 오버레이에 포함하지 않는다.
        if (data) {
            this.updateOverlay(data);
        }

        e.preventDefault();
        e.stopPropagation();
    }

    protected handleCompositionEnd(e: CompositionEvent) {
        if (!this.interceptEnabled) return;
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        const data = e.data ?? "";
        this.log("compositionend", `data="${data}"`);

        if (data) {
            this.sendToInput(data);
        }

        this.compositionActive = false;
        this.inputBuffer = "";

        // 확정 후 오버레이 숨김 — PTY로 전송 완료된 텍스트는 표시하지 않음.
        // 다음 compositionupdate가 곧바로 새 조합 글자를 보여준다.
        this.clearOverlay();

        textarea.value = "";

        e.preventDefault();
        e.stopPropagation();
    }

    // ─────────────────────────────────────────
    // beforeinput / input / keydown / blur
    // ─────────────────────────────────────────

    protected handleBeforeInput(e: InputEvent) {
        if (!this.interceptEnabled) return;
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        this.log("beforeinput", `inputType="${e.inputType}" data="${e.data}"`);

        if (
            e.inputType === "insertCompositionText" ||
            e.inputType === "insertFromComposition" ||
            e.inputType === "insertReplacementText"
        ) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    protected handleInput(e: Event) {
        if (this.interceptEnabled && this.imeActive) {
            e.stopPropagation();
        }
    }

    protected handleKeyDown(e: KeyboardEvent) {
        // 이전 세션 종료 후 첫 비-229 keydown → PTY 에코가 이미 도착했을 시점이므로 overlay 제거
        if (this.clearOnNextKey && e.keyCode !== 229) {
            this.clearOnNextKey = false;
            this.clearOverlay();
        }

        const textarea = this.getTextArea();

        if (e.keyCode === 229) {
            if (this.interceptEnabled && textarea && e.target === textarea) {
                e.stopPropagation();
            }
        }


        if (this.imeActive && e.keyCode !== 229) {
            const isModifier = ["Shift", "Control", "Alt", "Meta"].includes(e.key);
            if (!isModifier) {
                this.log("keydown", "비수정자 비-229 키 → 세션 종료");
                this.endSession();
            }
        }

        this.checkSmartToggle();
        if (!this.interceptEnabled) return;
        if (!textarea || e.target !== textarea) return;

        this.log("keydown", `key="${e.key}" keyCode=${e.keyCode} isComposing=${e.isComposing}`);
    }

    protected handleBlur() {
        if (!this.interceptEnabled) return;
        this.log("blur");
        if (this.imeActive) {
            this.endSession();
        }
        // blur 시 포커스를 잃으므로 다음 keydown을 기다리지 않고 즉시 제거
        this.clearOnNextKey = false;
        this.clearOverlay();
    }

    // ─────────────────────────────────────────
    // 세션 종료 / flush
    // ─────────────────────────────────────────

    protected flushAll() {
        this.unconfirmedEchoWidth = 0;
        super.flushAll();
    }

    private endSession() {
        // 미완성 음절(compositionend 없이 종료) 잔재 전송
        if (this.inputBuffer) this.onInput?.(this.inputBuffer);

        this.renderDisposable?.dispose();
        this.renderDisposable = null;

        this.sessionActive = false;
        this.imeActive = false;
        this.compositionActive = false;
        this.inputBuffer = "";
        this.flushedText = "";
        this.flushedDisplayWidth = 0;
        this.onEnd?.();

        // clearOverlay()를 즉시 호출하지 않는다.
        // space 등의 키로 세션이 끝날 때 즉시 지우면 마지막 음절의 PTY 에코가
        // xterm에 반영되기 전에 오버레이가 사라져 깜빡임이 발생한다.
        // 다음 keydown 시점에는 PTY 에코가 이미 도착해 있으므로 그때 지운다.
        this.clearOnNextKey = true;

        const textarea = this.getTextArea();
        if (textarea) textarea.value = "";
    }
}
