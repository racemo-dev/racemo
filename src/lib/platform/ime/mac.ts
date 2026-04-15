import { Terminal } from "@xterm/xterm";
import { IMEInterceptorBase, KOREAN_REGEX } from "./base";
import {
    getDisplayWidth,
    isHangulVowelJamo,
    isHangulConsonantJamo,
    composeHangulSyllable,
    addJongseong,
} from "../../utils/unicode";

// ─────────────────────────────────────────────
// MacIMEInterceptor — macOS WKWebView 전용 IME 인터셉터
//
// WKWebView quirk:
//   한영 전환 직후 첫 자음이 compositionstart 없이 insertText로 직접 들어온다.
//   이 경우 OS는 해당 자음을 이미 확정(commit)한 것으로 보고, 이후 모음부터
//   별도 조합을 시작한다.  →  "ㅎㅏㄴ글" (올바른 결과: "한글")
//
//   해결: insertText로 들어온 자음(pendingLegacyJamo)을 PTY에 보내지 않고 보류한 뒤,
//   이후 OS 조합 결과(모음·자음)를 수동으로 한글 음절에 합성한다.
//   composeHangulSyllable / addJongseong (unicode.ts) 참조.
//
// IME 세션 생명주기:
//   시작: 첫 compositionstart 또는 WKWebView legacy insertText
//   유지: compositionend 후에도 sessionActive 유지 (다음 음절 대비)
//   종료: 비수정자 keydown(비조합·비한글 상태) 또는 blur → flushAll
//
// 오버레이 전략 (모드 분기):
//   셸 모드 (promptY !== null):
//     확정 시 compositionAnchorX를 getDisplayWidth 예측으로 즉시 전진.
//     terminal.onRender에서 실제 cursorX를 확인해 예측과 다르면 anchor 보정.
//   앱 모드 (promptY === null, 예: Claude Code):
//     확정 시 compositionAnchorX를 전진시키지 않음.
//     terminal.onRender에서 에코 도착 시 실제 cursorX로 anchor 설정.
// ─────────────────────────────────────────────

export class MacIMEInterceptor extends IMEInterceptorBase {
    private sessionActive = false;

    /** WKWebView legacy insertText로 들어온 보류 중 초성 자모 */
    private pendingLegacyJamo: string | null = null;
    /** 수동 한글 조합으로 빌드 중인 음절 (예: 하, 한) */
    private legacySyllable: string | null = null;

    /** terminal.onRender 구독 핸들. 에코 보정용. */
    private renderDisposable: { dispose(): void } | null = null;
    /** 에코로 아직 확인되지 않은 디스플레이 폭 합계 (셸 모드: 보정, 앱 모드: 감지) */
    private unconfirmedEchoWidth = 0;
    /** 미확인 에코 구간의 시작 cursorX */
    private echoBaseCursorX = 0;

    constructor(terminal: Terminal, container: HTMLDivElement) {
        super(terminal, container, "macOS");
    }

    /** 셸 프롬프트 모드인지 여부. promptY가 설정되면 셸, null이면 앱(Claude Code 등). */
    private isShellMode(): boolean {
        return this.promptY !== null;
    }

    private startSession() {
        this.sessionActive = true;
        this.inputBuffer = "";
        this.activeTextStart = 0;
        this.flushedText = "";
        this.flushedDisplayWidth = 0;
        this.unconfirmedEchoWidth = 0;

        const buffer = this.terminal.buffer.active;
        this.compositionAnchorX = buffer.cursorX;
        this.compositionAnchorY = buffer.cursorY;

        this.captureCompositionColors();
        this.setupRenderListener();
        this.onStart?.();
    }

    /** 수동 조합 음절이 종성까지 갖추었는지 확인 */
    private legacySyllableHasJongseong(): boolean {
        if (!this.legacySyllable) return false;
        const code = this.legacySyllable.charCodeAt(0);
        return code >= 0xAC00 && code <= 0xD7AF && (code - 0xAC00) % 28 !== 0;
    }

    /**
     * 텍스트를 PTY에 전송.
     * 셸 모드: anchor를 예측 전진 (onRender에서 보정)
     * 앱 모드: anchor 변경 없음 (onRender에서 에코 감지 후 설정)
     */
    private sendToInput(text: string) {
        const w = getDisplayWidth(text);
        if (this.unconfirmedEchoWidth === 0) {
            this.echoBaseCursorX = this.terminal.buffer.active.cursorX;
        }
        this.unconfirmedEchoWidth += w;

        if (this.isShellMode()) {
            // 셸 모드: 예측 기반 즉시 전진
            this.compositionAnchorX += w;
        }
        // 앱 모드: anchor 변경 없음

        this.flushedText += text;
        this.flushedDisplayWidth += w;
        this.onInput?.(text);
    }

    /** 수동 조합 상태를 PTY로 전송하고 초기화 */
    private flushLegacyState() {
        if (this.legacySyllable) {
            const text = this.legacySyllable;
            this.log("flushLegacy", `syllable="${text}"`);
            this.sendToInput(text);
            this.legacySyllable = null;
        } else if (this.pendingLegacyJamo) {
            const text = this.pendingLegacyJamo;
            this.log("flushLegacy", `jamo="${text}"`);
            this.sendToInput(text);
            this.pendingLegacyJamo = null;
        }
    }

    /**
     * PTY 에코 감지.
     * 셸 모드: 예측과 실제 cursorX 차이만큼 anchor 보정.
     * 앱 모드: 에코 도착 시 실제 cursorX로 anchor 설정.
     */
    private setupRenderListener() {
        this.renderDisposable?.dispose();
        this.renderDisposable = this.terminal.onRender(() => {
            if (!this.sessionActive || this.unconfirmedEchoWidth === 0) return;

            const cursorX = this.terminal.buffer.active.cursorX;
            const actualAdvance = cursorX - this.echoBaseCursorX;

            // 커서가 전진했으면 에코가 도착한 것
            if (actualAdvance > 0) {
                if (this.isShellMode()) {
                    // 셸 모드: 예측 오차만큼 보정
                    const correction = actualAdvance - this.unconfirmedEchoWidth;
                    if (correction !== 0) {
                        this.compositionAnchorX += correction;
                        this.log("onRender", `shell echo correction: ${correction} anchor=${this.compositionAnchorX}`);
                    }
                } else {
                    // 앱 모드: 실제 cursorX로 anchor 설정
                    this.compositionAnchorX = cursorX;
                    this.log("onRender", `app echo arrived: anchor=${this.compositionAnchorX}`);
                }

                this.unconfirmedEchoWidth = 0;
                this.flushedText = "";
                this.flushedDisplayWidth = 0;

                // 보정된 위치로 오버레이 재배치
                const preview = this.getLegacyPreview() ?? this.inputBuffer;
                if (preview) this.updateOverlay(preview);
            }
        });
    }

    /** 현재 수동 조합 상태의 프리뷰 텍스트 (오버레이 갱신용) */
    private getLegacyPreview(): string | null {
        if (this.legacySyllable) return this.legacySyllable;
        if (this.pendingLegacyJamo) return this.pendingLegacyJamo;
        return null;
    }

    // ─────────────────────────────────────────
    // Composition 이벤트 핸들러
    // ─────────────────────────────────────────

    protected handleCompositionStart(e: CompositionEvent) {
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        // 종성까지 완성된 수동 조합 음절이 있으면 → 확정 전송
        if (this.legacySyllableHasJongseong()) {
            this.flushLegacyState();
        }

        const startingNewSession = !this.sessionActive;
        this.compositionActive = true;
        this.imeActive = true;

        if (startingNewSession) {
            this.startSession();
            this.log("compositionstart", `IME 시작 anchor=(${this.compositionAnchorX}, ${this.compositionAnchorY})`);
        } else {
            // 앱 모드: 에코가 아직 안 왔을 수 있으므로 cursorX 재확인
            if (!this.isShellMode()) {
                const cursorX = this.terminal.buffer.active.cursorX;
                if (cursorX > this.compositionAnchorX) {
                    this.compositionAnchorX = cursorX;
                }
            }
            this.log("compositionstart", `다음 음절 anchor=${this.compositionAnchorX}`);
        }

        e.preventDefault();
        e.stopPropagation();
    }

    protected handleCompositionUpdate(e: CompositionEvent) {
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        this.imeActive = true;
        const data = e.data ?? "";
        this.inputBuffer = data;

        this.log("compositionupdate", `data="${data}"`);

        // 수동 조합 프리뷰: 보류 중인 초성/음절과 현재 조합 데이터를 합성하여 오버레이 표시
        if (data.length === 1) {
            if (this.pendingLegacyJamo && isHangulVowelJamo(data)) {
                const combined = composeHangulSyllable(this.pendingLegacyJamo, data);
                if (combined) {
                    this.updateOverlay(combined);
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }
            if (this.legacySyllable && isHangulConsonantJamo(data)) {
                const combined = addJongseong(this.legacySyllable, data);
                if (combined) {
                    this.updateOverlay(combined);
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }
        }

        this.updateOverlay(data);
        e.preventDefault();
        e.stopPropagation();
    }

    protected handleCompositionEnd(e: CompositionEvent) {
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        this.compositionActive = false;
        const data = e.data ?? "";

        this.log("compositionend", `data="${data}"`);

        if (data) {
            // ── Case 1: 보류 중인 초성 자모가 있을 때 ──
            if (this.pendingLegacyJamo) {
                if (data.length === 1 && isHangulVowelJamo(data)) {
                    // 초성 + 모음 → 음절 (종성 대기)
                    const combined = composeHangulSyllable(this.pendingLegacyJamo, data);
                    if (combined) {
                        this.legacySyllable = combined;
                        this.pendingLegacyJamo = null;
                        this.log("compositionend", `legacy compose: ${combined}`);
                        this.inputBuffer = "";
                        if (textarea) textarea.value = "";
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                }
                // 모음이 아니거나 합성 불가 → 초성을 그대로 flush
                this.flushLegacyState();
            }

            // ── Case 2: 수동 조합 중인 음절이 있을 때 ──
            if (this.legacySyllable) {
                if (data.length === 1 && isHangulConsonantJamo(data)) {
                    // 자음 → 종성 시도
                    const combined = addJongseong(this.legacySyllable, data);
                    if (combined) {
                        this.legacySyllable = combined;
                        this.log("compositionend", `legacy jongseong: ${combined}`);
                        this.inputBuffer = "";
                        if (textarea) textarea.value = "";
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                }
                // 종성 불가 → 음절 flush 후 data 정상 처리
                this.flushLegacyState();
            }

            // ── Case 3: 정상 경로 ──
            this.sendToInput(data);
        }

        this.inputBuffer = "";
        if (textarea) textarea.value = "";

        e.preventDefault();
        e.stopPropagation();
    }

    // ─────────────────────────────────────────
    // beforeinput / input / keydown / blur
    // ─────────────────────────────────────────

    protected handleBeforeInput(e: InputEvent) {
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        const { inputType, data } = e;
        const isKorean = KOREAN_REGEX.test(data ?? "");

        this.log("beforeinput", `inputType="${inputType}" data="${data}" isKorean=${isKorean}`);

        if (inputType === "insertText" && isKorean) {
            e.preventDefault();
            e.stopPropagation();
            this.imeActive = true;

            const text = data ?? "";
            if (!this.compositionActive) {
                // WKWebView legacy path: compositionstart 없이 한글 문자가 바로 들어옴
                if (!this.sessionActive) {
                    this.startSession();
                }
                this.pendingLegacyJamo = text;
                this.log("beforeinput", `WKWebView legacy path → pending="${text}"`);
                this.updateOverlay(text);
            } else {
                this.inputBuffer = text;
                this.updateOverlay(text);
            }
            return;
        }

        if (
            this.imeActive &&
            (inputType === "insertCompositionText" ||
                inputType === "insertFromComposition" ||
                inputType === "insertReplacementText")
        ) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    protected handleInput(e: Event) {
        if (this.imeActive) {
            e.stopPropagation();
        }
    }

    protected handleKeyDown(e: KeyboardEvent) {
        const textarea = this.getTextArea();
        if (!textarea || e.target !== textarea) return;

        // IME 활성 중 xterm 키 가로채기 차단
        if (this.imeActive) {
            e.stopPropagation();
        }

        this.log("keydown", `key="${e.key}" imeActive=${this.imeActive} compositionActive=${this.compositionActive}`);

        if (this.imeActive && !this.compositionActive) {
            const isModifier = ["Shift", "Control", "Alt", "Meta"].includes(e.key);
            const isKoreanKey = KOREAN_REGEX.test(e.key);
            const isIMEControl = e.key === "CapsLock" || e.key === "Unidentified";

            if (!isModifier && !isKoreanKey && !isIMEControl) {
                this.log("keydown", "비수정자 키 (비조합·비한글 상태) → 세션 종료");
                this.endSession();
            }
        }
    }

    protected handleBlur() {
        if (this.imeActive) {
            this.log("blur", "포커스 해제 → 세션 종료");
            this.endSession();
        }
    }

    // ─────────────────────────────────────────
    // 세션 종료 / flush
    // ─────────────────────────────────────────

    protected flushAll() {
        // 수동 조합 상태를 먼저 PTY로 전송 (base.flushAll이 상태 초기화하기 전에)
        this.flushLegacyState();
        this.unconfirmedEchoWidth = 0;
        super.flushAll();
    }

    private endSession() {
        // 수동 조합 상태 flush
        this.flushLegacyState();

        // compositionend 없이 세션이 끊길 때 미완성 음절 잔재 전송
        if (this.inputBuffer) {
            this.onInput?.(this.inputBuffer);
            this.inputBuffer = "";
        }

        this.renderDisposable?.dispose();
        this.renderDisposable = null;

        this.sessionActive = false;
        this.flushAll();
    }
}
