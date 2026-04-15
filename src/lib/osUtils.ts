import { logger } from "./logger";

export function isMac(): boolean {
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes("mac") || ua.includes("darwin");
}

export function isWindows(): boolean {
    return navigator.platform?.toLowerCase().startsWith("win")
        || /windows nt/i.test(navigator.userAgent);
}

export function isLinux(): boolean {
    return !isMac() && !isWindows();
}

export function getModLabel(): string {
    return isMac() ? "Cmd" : "Ctrl";
}

export function isModKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
    if (isMac()) {
        return e.metaKey && !e.ctrlKey && !e.altKey;
    } else {
        return e.ctrlKey && !e.altKey && !e.metaKey;
    }
}

/** Canvas로 두 글자가 다르게 렌더되는지 확인. 같으면 토푸(□) = 폰트 없음. */
function glyphsDiffer(a: string, b: string): boolean {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 30; canvas.height = 30;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.font = '20px sans-serif';
        ctx.textBaseline = 'top';

        const draw = (ch: string) => {
            ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 30, 30);
            ctx.fillStyle = 'black'; ctx.fillText(ch, 2, 2);
            return ctx.getImageData(0, 0, 30, 30).data;
        };
        const d1 = draw(a), d2 = draw(b);
        for (let i = 0; i < d1.length; i += 4) {
            if (d1[i] !== d2[i]) return true;
        }
        return false;
    } catch { return false; }
}

const SAFE_URL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/** Open a URL safely — only allows https/http/mailto protocols. */
export function safeOpenUrl(url: string): void {
    try {
        const parsed = new URL(url);
        if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) {
            logger.warn(`[safeOpenUrl] blocked unsafe protocol: ${parsed.protocol}`);
            return;
        }
    } catch {
        logger.warn(`[safeOpenUrl] invalid URL: ${url}`);
        return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("plugin:opener|open_url", { url }).catch(() => {
            window.open(url, "_blank");
        });
    }).catch(() => {
        window.open(url, "_blank");
    });
}

let _canRenderCJK: boolean | null = null;
export function canRenderCJK(): boolean {
    if (_canRenderCJK === null) _canRenderCJK = glyphsDiffer('語', 'A');
    return _canRenderCJK;
}
