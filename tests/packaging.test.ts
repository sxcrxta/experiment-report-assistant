/**
 * 9단계 — 개인용 .app 묶기 설정 ([Q-31], `electron-builder.yml`).
 *
 * 여기서 지키는 것은 **직접 겪어 본 함정 세 가지**다. 설정 한 줄이 조용히 바뀌면 다시 빠진다.
 *
 * 1. **앱 이름은 ASCII 여야 한다.** 한글로 두면 실행 파일과 헬퍼 번들의 파일 이름까지 한글이 되고,
 *    그렇게 묶은 앱은 Apple Silicon 에서 켜자마자 죽는다 (SIGTRAP, 종료 코드 133, stderr 는 비어 있다).
 * 2. **데이터 폴더 이름이 앱 이름을 따라 바뀌면 안 된다.** 바뀌면 기존 기록을 못 찾는다.
 *    `docs/사용법.md` 2절이 약속한 경로이고, 키체인 항목 이름과도 같아야 한다.
 * 3. **마이그레이션 .sql 을 앱 안에 넣어야 한다.** 코드가 아니라 파일로 읽으므로 번들에서 빠지기 쉽다.
 * 4. **아이콘은 코드로 그린다.** 출처 모를 그림 파일을 저장소에 두지 않는다 (`build/icon.py`).
 *
 * 실제로 묶어 보지는 않는다 (몇 분 걸리고 Electron 을 내려받는다). 설정과 코드가 어긋나지 않는지만 본다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KEYCHAIN_SERVICE } from '../src/adapters/secret/keychain.js'

const ROOT = join(import.meta.dirname, '..')

const builderConfig = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
const mainSource = readFileSync(join(ROOT, 'src', 'main', 'index.ts'), 'utf8')

/** `키: 값` 한 줄을 읽는다. 값에 주석은 쓰지 않는다. */
function setting(key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(builderConfig)
  return match?.[1]?.trim() ?? null
}

describe('묶기 설정 ([Q-31])', () => {
  it('앱 이름이 ASCII 다 — 한글 이름으로 묶으면 켜자마자 죽는다', () => {
    const productName = setting('productName')
    expect(productName).not.toBeNull()
    expect(productName).toMatch(/^[\x20-\x7E]+$/)
  })

  it('데이터 폴더 이름이 앱 이름과 키체인 항목 이름과 모두 같다', () => {
    const pinned = /const DATA_DIR_NAME = '([^']+)'/.exec(mainSource)?.[1]
    expect(pinned).toBe(KEYCHAIN_SERVICE)
    expect(setting('productName')).toBe(pinned)
    // 앱 이름이 바뀌어도 데이터 위치가 따라가지 않도록 코드에서 못박는다.
    expect(mainSource).toContain("app.setPath('userData'")
  })

  it('Finder 에 보이는 이름만 한국어로 덮는다', () => {
    expect(builderConfig).toContain('CFBundleDisplayName: 실험보고서 학습 보조')
  })

  it('마이그레이션 .sql 을 앱 안에 넣는다', () => {
    expect(builderConfig).toContain('src/adapters/repo/migrations/*.sql')
    // 넣는 위치가 코드가 찾는 위치와 같아야 한다.
    expect(mainSource).toContain("join(app.getAppPath(), 'src', 'adapters', 'repo', 'migrations')")
  })

  it('네이티브 모듈을 asar 밖에 둔다 — 안에 있으면 .node 를 읽지 못한다', () => {
    expect(builderConfig).toContain('node_modules/better-sqlite3/**')
  })

  it('묶은 뒤 애드혹 서명을 붙인다 — 서명이 내용과 어긋나면 실행되지 않는다', () => {
    expect(builderConfig).toContain('afterPack: build/after-pack.cjs')
    const hook = readFileSync(join(ROOT, 'build', 'after-pack.cjs'), 'utf8')
    expect(hook).toContain("'--sign', '-'")
    // 서명이 실제로 유효한지 확인하고, 아니면 빌드를 멈춘다.
    expect(hook).toContain("'--verify'")
  })

  it('아이콘을 코드로 그려 번들에 넣는다', () => {
    expect(builderConfig).toContain('icon: build/icon.icns')
    expect(existsSync(join(ROOT, 'build', 'icon.icns'))).toBe(true)

    // 그림 파일만 덩그러니 두지 않는다. 어떻게 그렸는지가 저장소에 남아야 한다.
    const generator = readFileSync(join(ROOT, 'build', 'icon.py'), 'utf8')
    expect(generator).toContain('icon.icns')
    // 아이콘 색은 앱 화면의 강조색에서 온다. 둘이 따로 놀지 않게 묶어 둔다.
    const primary = /--primary:\s*#2e6f6a/.exec(
      readFileSync(join(ROOT, 'src', 'renderer', 'src', 'styles.css'), 'utf8'),
    )
    expect(primary).not.toBeNull()
    expect(generator).toContain('--primary: #2e6f6a')
  })

  it('배포하지 않는다 — 게시 대상도 공증도 없다 (PRD 5절, [Q-22]~[Q-24])', () => {
    expect(setting('publish')).toBe('null')
    expect(builderConfig).toContain('notarize: false')
    // DMG·ZIP 을 만들지 않는다. 건네줄 일이 없다.
    expect(builderConfig).not.toMatch(/target:\s*dmg|- dmg\b/)
  })
})
