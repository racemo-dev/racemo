// ─────────────────────────────────────────────
// Platform-specific modules
//
// 플랫폼별로 동작이 달라지는 기능을 여기서 관리한다.
// 새 기능을 추가할 때:
//   1. src/lib/platform/{feature}/ 디렉토리 생성
//   2. base.ts / windows.ts / mac.ts / linux.ts 작성
//   3. index.ts에서 detect.ts를 이용해 팩토리 함수 작성
//   4. 이 파일에 re-export 추가
//
// 현재 모듈:
//   - ime : IME 입력 처리 (한글/CJK 조합 입력, 오버레이)
// ─────────────────────────────────────────────

export { createIMEInterceptor, type IMEInterceptor, type IMEHandlers } from "./ime";
export { isMac, isWindows, isLinux } from "./detect";
