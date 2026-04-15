/* ─── Provider Icons ─── */

export function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" stroke="url(#ailog-claude-grad)" strokeWidth="5" strokeLinecap="round" style={{ width: size, height: size, flexShrink: 0 }}>
      <defs>
        <linearGradient id="ailog-claude-grad" x1="6.4" y1="57.6" x2="57.6" y2="6.4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#E2735E" />
          <stop offset="100%" stopColor="#C85A48" />
        </linearGradient>
      </defs>
      <line x1="32" y1="32" x2="32" y2="6" /><line x1="32" y1="32" x2="50" y2="10" />
      <line x1="32" y1="32" x2="58" y2="22" /><line x1="32" y1="32" x2="58" y2="38" />
      <line x1="32" y1="32" x2="48" y2="52" /><line x1="32" y1="32" x2="32" y2="58" />
      <line x1="32" y1="32" x2="16" y2="54" /><line x1="32" y1="32" x2="6" y2="42" />
      <line x1="32" y1="32" x2="6" y2="26" /><line x1="32" y1="32" x2="14" y2="12" />
    </svg>
  );
}

export function CodexIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ width: size, height: size, flexShrink: 0 }}>
      <path d="M11.217 19.384a3.501 3.501 0 0 0 6.783 -1.217v-5.167l-6 -3.35" />
      <path d="M5.214 15.014a3.501 3.501 0 0 0 4.446 5.266l4.34 -2.534v-6.946" />
      <path d="M6 7.63c-1.391 -.236 -2.787 .395 -3.534 1.689a3.474 3.474 0 0 0 1.271 4.745l4.263 2.514l6 -3.348" />
      <path d="M12.783 4.616a3.501 3.501 0 0 0 -6.783 1.217v5.067l6 3.45" />
      <path d="M18.786 8.986a3.501 3.501 0 0 0 -4.446 -5.266l-4.34 2.534v6.946" />
      <path d="M18 16.302c1.391 .236 2.787 -.395 3.534 -1.689a3.474 3.474 0 0 0 -1.271 -4.745l-4.308 -2.514l-5.955 3.42" />
    </svg>
  );
}

export function GeminiIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="url(#ailog-gemini-grad)" style={{ width: size, height: size, flexShrink: 0, overflow: "visible" }}>
      <defs>
        <linearGradient id="ailog-gemini-grad" x1="10%" y1="90%" x2="90%" y2="10%">
          <stop offset="0%" stopColor="#1CA1FF" /><stop offset="40%" stopColor="#1C7DFF" /><stop offset="100%" stopColor="#AC6AFF" />
        </linearGradient>
      </defs>
      <path d="M12 1C12 7.07513 16.9249 12 23 12C16.9249 12 12 16.9249 12 23C12 16.9249 7.07513 12 1 12C7.07513 12 12 7.07513 12 1Z" style={{ transform: "scale(1.25)", transformOrigin: "center" }} />
    </svg>
  );
}

export function OpenCodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 40" fill="none" style={{ width: size, height: size, flexShrink: 0 }}>
      <g clipPath="url(#clip0_1311_94973)">
        <path d="M24 32H8V16H24V32Z" fill="currentColor" fillOpacity="0.4"/>
        <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="currentColor"/>
      </g>
      <defs>
        <clipPath id="clip0_1311_94973"><rect width="32" height="40" fill="white"/></clipPath>
      </defs>
    </svg>
  );
}
