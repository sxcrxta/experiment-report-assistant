/**
 * 비밀 값 보관 — macOS 키체인.
 *
 * PRD 5절: "키는 macOS 키체인에 보관하고 프로그램 코드나 설정 파일에 넣지 않는다."
 * 구현은 `keychain.ts`.
 */

export interface SecretStore {
  /** 없거나 읽지 못하면 null */
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** 키체인에 넣는 항목 이름. 값은 여기에도 어디에도 적지 않는다. */
export const SECRET_KEYS = {
  /** 사용자가 등록한 OpenRouter API 키 ([Q-9]) */
  openRouter: 'openrouter-api-key',
} as const
