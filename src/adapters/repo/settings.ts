/**
 * 앱 설정 값 하나짜리 저장소 (7단계, [Q-30]).
 *
 * 담는 것은 **비밀이 아닌 작은 값**뿐이다. 지금은 사용자가 직접 지정한 Claude Code 경로 하나다.
 * API 키는 절대 여기 넣지 않는다. 키는 macOS 키체인에만 둔다 (`CLAUDE.md` §4, PRD 5절).
 */
import type Database from 'better-sqlite3'

/** 설정 이름. 문자열을 코드 곳곳에 흩뿌리지 않는다. */
export const SETTING_KEYS = {
  /** 사용자가 설정 화면에서 직접 지정한 Claude Code 실행 파일 절대 경로 */
  claudeCliPath: 'claude.cli-path',
} as const

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

export interface SettingsRepository {
  get(key: SettingKey): string | null
  set(key: SettingKey, value: string, now: string): void
  clear(key: SettingKey): void
}

export function createSettingsRepository(db: Database.Database): SettingsRepository {
  const read = db.prepare<[string], { value: string }>('SELECT value FROM app_settings WHERE key = ?')
  const write = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  const remove = db.prepare('DELETE FROM app_settings WHERE key = ?')

  return {
    get: (key) => read.get(key)?.value ?? null,
    set: (key, value, now) => {
      write.run(key, value, now)
    },
    clear: (key) => {
      remove.run(key)
    },
  }
}
