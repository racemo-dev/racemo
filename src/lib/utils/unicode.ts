// ─────────────────────────────────────────────
// Unicode 유틸리티
//
// 터미널 컬럼 폭 계산과 한글/CJK 판별 등
// 유니코드 관련 공용 로직을 모아둔다.
// ─────────────────────────────────────────────

/**
 * 한글 및 CJK 문자 판별 정규식.
 *
 * 커버 범위:
 *   \uAC00-\uD7AF  한글 음절 (가~힣)
 *   \u1100-\u11FF  한글 자모
 *   \u3130-\u318F  한글 호환 자모
 *
 * 주의: getDisplayWidth의 2컬럼 범위(CJK 한자, 전각 등)보다 좁다.
 * IME 조합 감지용(입력 중인 문자가 한글인지 확인)으로만 사용한다.
 */
export const KOREAN_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

/**
 * 문자열의 터미널 컬럼 폭을 반환한다.
 * Hangul·CJK 계열은 2컬럼, 그 외는 1컬럼.
 *
 * 오버레이 위치 계산과 flush 폭 추적에 사용된다.
 */
// ─────────────────────────────────────────────
// 한글 자모 조합 유틸리티
//
// WKWebView legacy path에서 초성이 insertText로 먼저 빠져나올 때,
// 이후 OS 조합 결과(모음, 자음)를 수동으로 음절에 합성하기 위한 함수들.
// ─────────────────────────────────────────────

// 호환 자모(0x3131~0x314E) → 초성 인덱스 (0~18). -1 = 초성 불가.
const CHOSEONG_IDX = [
//  ㄱ  ㄲ  ㄳ  ㄴ  ㄵ  ㄶ  ㄷ  ㄸ  ㄹ  ㄺ  ㄻ  ㄼ  ㄽ  ㄾ  ㄿ  ㅀ
    0,  1, -1,  2, -1, -1,  3,  4,  5, -1, -1, -1, -1, -1, -1, -1,
//  ㅁ  ㅂ  ㅃ  ㅄ  ㅅ  ㅆ  ㅇ  ㅈ  ㅉ  ㅊ  ㅋ  ㅌ  ㅍ  ㅎ
    6,  7,  8, -1,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
];

// 호환 자모(0x3131~0x314E) → 종성 인덱스 (1~27). -1 = 종성 불가.
const JONGSEONG_IDX = [
//  ㄱ  ㄲ  ㄳ  ㄴ  ㄵ  ㄶ  ㄷ  ㄸ  ㄹ  ㄺ  ㄻ  ㄼ  ㄽ  ㄾ  ㄿ  ㅀ
    1,  2,  3,  4,  5,  6,  7, -1,  8,  9, 10, 11, 12, 13, 14, 15,
//  ㅁ  ㅂ  ㅃ  ㅄ  ㅅ  ㅆ  ㅇ  ㅈ  ㅉ  ㅊ  ㅋ  ㅌ  ㅍ  ㅎ
   16, 17, -1, 18, 19, 20, 21, 22, -1, 23, 24, 25, 26, 27,
];

/** 호환 자모 모음 여부 (ㅏ~ㅣ, 0x314F~0x3163) */
export function isHangulVowelJamo(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return c >= 0x314F && c <= 0x3163;
}

/** 호환 자모 자음 여부 (ㄱ~ㅎ, 0x3131~0x314E) */
export function isHangulConsonantJamo(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return c >= 0x3131 && c <= 0x314E;
}

/** 초성(자음) + 중성(모음) → 한글 음절. 합성 불가 시 null. */
export function composeHangulSyllable(initial: string, medial: string): string | null {
    const i = CHOSEONG_IDX[initial.charCodeAt(0) - 0x3131];
    const m = medial.charCodeAt(0) - 0x314F;
    if (i == null || i < 0 || m < 0 || m > 20) return null;
    return String.fromCharCode(0xAC00 + i * 21 * 28 + m * 28);
}

/** 한글 음절에 종성(받침) 추가. 이미 종성이 있거나 추가 불가 시 null. */
export function addJongseong(syllable: string, final: string): string | null {
    const code = syllable.charCodeAt(0);
    if (code < 0xAC00 || code > 0xD7AF) return null;
    if ((code - 0xAC00) % 28 !== 0) return null; // 이미 종성 있음
    const j = JONGSEONG_IDX[final.charCodeAt(0) - 0x3131];
    if (j == null || j <= 0) return null;
    return String.fromCharCode(code + j);
}

export function getDisplayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (
            (cp >= 0xAC00 && cp <= 0xD7AF) || // 한글 음절 (가~힣)
            (cp >= 0x1100 && cp <= 0x11FF) || // 한글 자모
            (cp >= 0x3130 && cp <= 0x318F) || // 한글 호환 자모
            (cp >= 0xA960 && cp <= 0xA97F) || // 한글 자모 확장-A
            (cp >= 0xD7B0 && cp <= 0xD7FF) || // 한글 자모 확장-B
            (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK 통합 한자
            (cp >= 0x3400 && cp <= 0x4DBF) || // CJK 확장 A
            (cp >= 0x3000 && cp <= 0x303F) || // CJK 기호 및 구두점
            (cp >= 0xFF01 && cp <= 0xFF60) || // 전각 라틴/기호
            (cp >= 0xFFE0 && cp <= 0xFFE6)    // 전각 기호
        ) {
            width += 2;
        } else {
            width += 1;
        }
    }
    return width;
}
