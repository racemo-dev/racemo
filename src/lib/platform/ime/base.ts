import { Terminal, type ITheme } from "@xterm/xterm";
import { getDisplayWidth, KOREAN_REGEX } from "../../utils/unicode";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getXTermCore } from "../../xtermInternal";
import { logger } from "../../logger";

export { KOREAN_REGEX };

export interface IMEHandlers {
    onInput: (data: string) => void;
    onStart?: () => void;
    onEnd?: () => void;
}

// ─────────────────────────────────────────────
// IMEInterceptorBase — 상태, 유틸리티, 오버레이만 담당
// 핸들러는 모두 abstract — 플랫폼별 파일에서 구현
// ─────────────────────────────────────────────

export abstract class IMEInterceptorBase {
    protected terminal: Terminal;
    protected container: HTMLDivElement;
    protected readonly platform: string;

    public imeActive: boolean = false;
    public interceptEnabled: boolean = false;
    protected compositionActive: boolean = false;
    protected inputBuffer: string = "";
    protected activeTextStart: number = 0;
    protected flushedText: string = "";
    protected compositionAnchorX: number = 0;
    protected compositionAnchorY: number = 0;
    protected flushedDisplayWidth: number = 0;
    // OSC 133;B 로 확인된 프롬프트 입력줄 Y. PSReadLine 목록 모드에서
    // 커서가 하단으로 이동해도 오버레이는 이 위치에 고정된다.
    // OSC 133 미지원 환경에서는 null → compositionAnchorY 폴백.
    protected promptY: number | null = null;
    /** 133;A 수신 후 다음 133;B를 받을 수 있는지 여부.
     *  초기값 true(첫 프롬프트 허용), 133;C에서 false, 133;A에서 true로 복원. */
    private promptStartAllowed = true;
    // 현재 패인의 쉘 타입. captureCompositionColors()에서 쉘별 색상 선택에 사용.
    protected shellType: string | null = null;
    private overlayEl: HTMLDivElement | null = null;
    protected cachedCompositionColors: { bg: string; fg: string } | null = null;
    protected onInput: ((data: string) => void) | null = null;
    protected onStart: (() => void) | null = null;
    protected onEnd: (() => void) | null = null;
    private boundListeners: Map<string, (e: Event) => void> = new Map();
    private wheelHandler: (() => void) | null = null;
    protected lastWheelTime: number = 0;
    private resizeImeTimer: ReturnType<typeof setTimeout> | null = null;
    private isDisposed: boolean = false;

    constructor(terminal: Terminal, container: HTMLDivElement, platform: string) {
        this.terminal = terminal;
        this.container = container;
        this.platform = platform;
        this.setupCaptureListeners();
    }

    public dispose() {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.log("dispose", "IME 인터셉터 해제");

        const d = document;
        this.boundListeners.forEach((listener, event) => {
            d.removeEventListener(event, listener, true);
        });
        this.boundListeners.clear();

        if (this.wheelHandler && this.container) {
            this.container.removeEventListener("wheel", this.wheelHandler, true);
            this.wheelHandler = null;
        }

        this.clearOverlay();
        if (this.overlayEl && this.overlayEl.parentElement) {
            this.overlayEl.parentElement.removeChild(this.overlayEl);
        }
        this.overlayEl = null;

        if (this.resizeImeTimer) {
            clearTimeout(this.resizeImeTimer);
            this.resizeImeTimer = null;
        }



        this.terminal = null!;
        this.container = null!;
        this.onInput = null;
        this.onStart = null;
        this.onEnd = null;
    }

    public setInterceptEnabled(running: boolean) {
        if (this.interceptEnabled === running) return;
        this.interceptEnabled = running;
        this.log("setInterceptEnabled", `커스텀 IME ${this.interceptEnabled ? "활성화" : "비활성화"}`);
        if (!this.interceptEnabled && this.imeActive) {
            this.flushAll();
        }
    }

    public setHandlers({ onInput, onStart, onEnd }: IMEHandlers) {
        this.onInput = onInput;
        this.onStart = onStart ?? null;
        this.onEnd = onEnd ?? null;
    }

    private setupCaptureListeners() {
        const d = document;

        const events = {
            compositionstart: (e: Event) => this.handleCompositionStart(e as CompositionEvent),
            compositionupdate: (e: Event) => this.handleCompositionUpdate(e as CompositionEvent),
            compositionend: (e: Event) => this.handleCompositionEnd(e as CompositionEvent),
            beforeinput: (e: Event) => this.handleBeforeInput(e as InputEvent),
            input: (e: Event) => this.handleInput(e),
            keydown: (e: Event) => this.handleKeyDown(e as KeyboardEvent),
            blur: () => this.handleBlur(),
        };

        Object.entries(events).forEach(([event, handler]) => {
            const bound = handler.bind(this);
            this.boundListeners.set(event, bound);
            d.addEventListener(event, bound, true);
        });

        // 마지막 wheel 시각 기록 (spurious composition guard용)
        const wheelHandler = () => {
            if (this.isDisposed) return;
            this.lastWheelTime = performance.now();
        };
        this.wheelHandler = wheelHandler;
        this.container.addEventListener("wheel", wheelHandler, { passive: true, capture: true });

        // 터미널 리사이즈 시 xterm DOM 재구성으로 Windows IME가 활성화되는 문제 방지.
        // resize 동안 textarea의 inputmode를 none으로 설정해 IME 억제.
        this.terminal.onResize(() => {
            if (this.isDisposed || this.compositionActive) return;
            const textarea = this.getTextArea();
            if (!textarea) return;
            textarea.setAttribute("inputmode", "none");
            if (this.resizeImeTimer) clearTimeout(this.resizeImeTimer);
            this.resizeImeTimer = setTimeout(() => {
                if (!this.isDisposed) {
                    textarea.removeAttribute("inputmode");
                }
                this.resizeImeTimer = null;
            }, 300);
        });
    }

    protected getTextArea(): HTMLTextAreaElement | null {
        return this.container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    }

    protected abstract handleCompositionStart(e: CompositionEvent): void;
    protected abstract handleCompositionUpdate(e: CompositionEvent): void;
    protected abstract handleCompositionEnd(e: CompositionEvent): void;
    protected abstract handleBeforeInput(e: InputEvent): void;
    protected abstract handleInput(e: Event): void;
    protected abstract handleKeyDown(e: KeyboardEvent): void;
    protected abstract handleBlur(): void;

    // ─────────────────────────────────────────
    // Flush 유틸리티
    // ─────────────────────────────────────────

    /** OSC 133;A 수신 시 호출 — 새 프롬프트 시작, 다음 133;B 수신을 허용. */
    public notifyPromptStart(): void {
        this.promptStartAllowed = true;
    }

    /** OSC 133;B 수신 시 호출 — 프롬프트 입력줄 Y 고정.
     *  133;C 이후 133;A 없이 도착하면 ConPTY 재전송으로 간주해 무시. */
    public setPromptY(y: number): void {
        if (!this.promptStartAllowed) return;
        this.promptY = y;
        this.log("setPromptY", `promptY=${y}`);
    }

    /** OSC 133;C 수신 시 호출 — 커맨드 실행 중이므로 promptY 무효화. */
    public clearPromptY(): void {
        this.promptY = null;
        this.promptStartAllowed = false;
    }

    /** 패인의 쉘 타입 설정. 오버레이 초기 색상 선택에 사용. */
    public setShellType(type: string | null): void {
        this.shellType = type;
    }

    protected flushNewCommitted(newEnd: number) {
        const toSend = this.inputBuffer.slice(this.activeTextStart, newEnd);
        this.flushedDisplayWidth += getDisplayWidth(toSend);
        this.activeTextStart = newEnd;
        this.flushedText += toSend;
        this.log("flushNewCommitted", `"${toSend}" flushedWidth=${this.flushedDisplayWidth}`);
        this.onInput?.(toSend);
    }

    protected flushAll() {
        if (!this.imeActive) return;

        const remaining = this.inputBuffer.slice(this.activeTextStart);
        this.log("flushAll", `remaining="${remaining}"`);
        if (remaining) this.onInput?.(remaining);

        this.imeActive = false;
        this.compositionActive = false;
        this.inputBuffer = "";
        this.activeTextStart = 0;
        this.flushedText = "";
        this.flushedDisplayWidth = 0;
        this.compositionAnchorX = 0;
        this.compositionAnchorY = 0;
        this.promptY = null;
        this.cachedCompositionColors = null;

        this.onEnd?.();
        this.clearOverlay();

        const textarea = this.getTextArea();
        if (textarea) textarea.value = "";
    }

    // ─────────────────────────────────────────
    // 로깅 헬퍼
    // ─────────────────────────────────────────

    protected log(_handler: string, ..._args: unknown[]) {
        // no-op: debug removed
    }

    // ─────────────────────────────────────────
    // 오버레이
    // ─────────────────────────────────────────

    private ensureOverlay(): HTMLDivElement {
        if (this.overlayEl) return this.overlayEl;

        this.overlayEl = document.createElement("div");
        this.overlayEl.className = "xterm-ime-overlay";
        this.overlayEl.style.cssText = `
            position: absolute;
            left: 0;
            top: 0;
            pointer-events: none;
            z-index: 1000;
            white-space: pre;
            display: none;
            padding: 0;
            margin: 0;
            border: none;
            box-shadow: none;
            background: transparent;
        `;
        this.applyThemeStyles();

        // container에 붙여서 .xterm-screen의 overflow:hidden 클리핑을 회피
        if (!this.container.style.position || this.container.style.position === "static") {
            this.container.style.position = "relative";
        }
        this.container.appendChild(this.overlayEl);

        return this.overlayEl;
    }

    protected getOverlayPosition(): { x: number; y: number } {
        return {
            x: this.compositionAnchorX,
            y: this.compositionAnchorY,
        };
    }

    private setCursorLayerVisible(visible: boolean) {
        const cursorLayer = this.container.querySelector(".xterm-cursor-layer") as HTMLElement | null;
        if (cursorLayer) cursorLayer.style.visibility = visible ? "" : "hidden";
    }

    public updateOverlay(text: string) {
        const el = this.ensureOverlay();
        const t = performance.now().toFixed(1);
        if (!text) {
            this.log("overlay", `[${t}ms] HIDE (text empty)`);
            el.style.display = "none";
            this.setCursorLayerVisible(true);

            return;
        }

        const prev = el.style.display;
        const { x, y } = this.getOverlayPosition();
        this.log("overlay", `[${t}ms] SHOW text="${text}" anchor=(${x},${y}) (prev=${prev})`);
        el.style.display = "block";
        this.setCursorLayerVisible(false);

        const core = getXTermCore(this.terminal);
        const dimensions = core?._renderService?.dimensions?.css?.cell;

        el.style.fontSize = `${this.terminal.options.fontSize}px`;
        el.style.fontFamily = this.terminal.options.fontFamily ?? "Inter, Roboto, sans-serif, monospace";
        el.style.fontWeight = String(this.terminal.options.fontWeight ?? "normal");
        el.style.letterSpacing = "0px";

        el.innerHTML = "";
        for (const char of text) {
            const span = document.createElement("span");
            span.textContent = char;
            span.style.display = "inline-block";
            span.style.letterSpacing = "0px";
            if (dimensions) {
                span.style.width = `${getDisplayWidth(char) * dimensions.width}px`;
            }
            el.appendChild(span);
        }

        if (dimensions) {
            // 오버레이가 container에 붙어있으므로 screenEl 오프셋 보정
            const screenEl = this.container.querySelector(".xterm-screen") as HTMLElement | null;
            const offsetLeft = screenEl?.offsetLeft ?? 0;
            const offsetTop = screenEl?.offsetTop ?? 0;
            el.style.left = `${offsetLeft + x * dimensions.width}px`;
            el.style.top = `${offsetTop + y * dimensions.height}px`;
            el.style.lineHeight = `${dimensions.height}px`;
        }

        this.applyThemeStyles();
    }

    /**
     * 현재 커서 위치의 색상을 기반으로 구문 타입(명령어 vs 인자)을 추측합니다.
     */
    public getCursorSyntaxType(): "command" | "argument" | "default" {
        if (this.isDisposed || !this.terminal) return "default";
        try {
            const b = this.terminal.buffer.active;
            const line = b.getLine(b.cursorY + b.baseY);
            if (!line) return "default";

            let foundSpaceAfterContent = false;
            let foundPrompt = false;

            for (let x = b.cursorX - 1; x >= 0; x--) {
                const cell = line.getCell(x);
                if (!cell) break;
                const chars = cell.getChars();

                if (chars === ">" || chars === "$" || chars === "#" || chars === "%" || chars === "❯" || chars === "➜" || chars === "»" || chars === "§") {
                    foundPrompt = true;
                    break;
                }

                if (chars === " ") {
                    let foundWordToLeft = false;
                    let isPromptSpace = false;

                    for (let x2 = x - 1; x2 >= 0; x2--) {
                        const cell2 = line.getCell(x2);
                        if (!cell2) break;
                        const char2 = cell2.getChars();

                        if (char2 === ">" || char2 === "$" || char2 === "#" || char2 === "%" || char2 === "❯" || char2 === "➜" || char2 === "»" || char2 === "§") {
                            isPromptSpace = true;
                            foundPrompt = true;
                            break;
                        }

                        if (char2.trim()) {
                            foundWordToLeft = true;
                            break;
                        }
                    }

                    if (foundWordToLeft && !isPromptSpace) {
                        foundSpaceAfterContent = true;
                        break;
                    }

                    if (isPromptSpace) {
                        break;
                    }
                }
            }

            if (foundSpaceAfterContent) return "argument";
            if (!foundPrompt) return "default";
            return "command";
        } catch (e) {
            logger.error(`[SmartIME] Error:`, e);
            return "default";
        }
    }

    public checkSmartToggle() {
        if (this.isDisposed || !this.terminal) return;
        const settings = useSettingsStore.getState();
        if (settings?.smartImeEnabled) {
            if (this.imeActive || this.compositionActive) {
                if (!this.interceptEnabled) {
                    this.setInterceptEnabled(true);
                }
                return;
            }

            const shouldIntercept = settings.imeInterceptEnabled;
            if (this.interceptEnabled !== shouldIntercept) {
                logger.debug(`[SmartIME] toggle: ${this.interceptEnabled} -> ${shouldIntercept}`);
                this.setInterceptEnabled(shouldIntercept);
            }
        }
    }

    private applyThemeStyles() {
        if (!this.overlayEl) return;
        const { bg, fg } = this.getCellColors();

        this.overlayEl.style.backgroundColor = bg;
        this.overlayEl.style.color = fg;
        this.overlayEl.style.border = "none";
        this.overlayEl.style.boxShadow = "none";
        this.overlayEl.style.borderRadius = "0";

        this.overlayEl.style.textShadow = "none";
        this.overlayEl.style.borderBottom = `2px solid ${fg}`;
    }

    protected captureCompositionColors() {
        const colors = getXTermCore(this.terminal)?._colorManager?.colors;
        const theme = this.terminal.options.theme ?? {};
        const bg = colors?.background?.css || theme.background || "#000000";
        const defaultFg = colors?.foreground?.css || theme.foreground || "#ffffff";

        const isPowerShell = this.shellType === "PowerShell";
        let fg: string;

        if (isPowerShell) {
            // shell 모드에서는 syntaxType에 따라 command 색상 적용
            // 앱 모드(promptY=null, explicitAppMode)에서는 노멀 색상만 사용
            const isShell = this.promptY !== null;
            const syntaxType = isShell ? this.getCursorSyntaxType() : "default";
            if (syntaxType === "command") {
                fg = colors?.ansi?.[11]?.css ?? this.resolveAnsiColor(11, theme) ?? theme.brightYellow ?? theme.yellow ?? "#e6b450";
            } else {
                fg = colors?.ansi?.[7]?.css ?? this.resolveAnsiColor(7, theme) ?? theme.white ?? defaultFg;
            }
        } else {
            fg = defaultFg;
        }

        this.cachedCompositionColors = { bg, fg };
    }

    private getCellColors(): { bg: string; fg: string } {
        if (this.cachedCompositionColors) return this.cachedCompositionColors;

        const colors = getXTermCore(this.terminal)?._colorManager?.colors;
        const theme = this.terminal.options.theme ?? {};
        const bg = colors?.background?.css || theme.background || "#000000";
        const fg = colors?.foreground?.css || theme.foreground || "#ffffff";

        // shell 모드에서만 command 색상 적용
        if (this.promptY !== null) {
            const syntaxType = this.getCursorSyntaxType();
            if (syntaxType === "command") {
                const commandFg = colors?.ansi?.[3]?.css || theme.yellow || "#e6b450";
                return { bg, fg: commandFg };
            }
        }
        return { bg, fg };
    }

    private resolveAnsiColor(idx: number, theme: ITheme): string | null {
        const map: (string | undefined)[] = [
            theme.black,       theme.red,           theme.green,       theme.yellow,
            theme.blue,        theme.magenta,        theme.cyan,        theme.white,
            theme.brightBlack, theme.brightRed,      theme.brightGreen, theme.brightYellow,
            theme.brightBlue,  theme.brightMagenta,  theme.brightCyan,  theme.brightWhite,
        ];
        return map[idx] ?? null;
    }

    public refresh() {
        this.cachedCompositionColors = null;
        this.applyThemeStyles();
        this.updateOverlay(this.flushedText + this.inputBuffer.slice(this.activeTextStart));
    }

    public clearOverlay() {
        if (this.overlayEl) {
            const t = performance.now().toFixed(1);
            this.log("overlay", `[${t}ms] CLEAR (display was ${this.overlayEl.style.display})`);
            this.overlayEl.style.display = "none";
            this.overlayEl.textContent = "";
        }
        this.setCursorLayerVisible(true);
    }
}
