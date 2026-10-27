/**
 * 9단계 — 코드 전체에 걸린 불변식 중 소스를 직접 훑어야 하는 것들
 * (`IMPLEMENTATION_PLAN.md` §4.2).
 *
 * - T-2  본문을 자동으로 고치거나 적용하는 경로가 코드에 존재하지 않는다 (`CLAUDE.md` §1)
 * - T-26 코어·앱 계층에 `modelId` 로 분기하는 로직이 없다 (`CLAUDE.md` §5)
 *
 * 다른 곳에서 이미 지키는 불변식은 그 파일에 둔다.
 * 예: T-13(HWPX 쓰기 API 없음)은 `hwpx-readonly.test.ts`,
 * T-29(외부 전송 한 지점)와 T-11 은 `gemma.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/** 주석을 걷어 낸 코드. 설명 속 낱말까지 잡히면 오탐이다. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function rel(file: string): string {
  return relative(join(SRC, '..'), file).split(sep).join('/')
}

describe('대필 금지 — 본문을 대신 고치는 경로가 없다 (T-2)', () => {
  it('사용자 문서를 쓰는 파일 시스템 호출이 없다', () => {
    // 체크포인트는 원본을 **복사**할 뿐이고, 되살리기는 사용자가 고른 새 경로에 쓴다.
    // 그 두 곳(copyFile)만 허용하고, 원본을 여는 쓰기 호출은 어디에도 없어야 한다.
    const WRITES = [
      /\bwriteFileSync?\b/,
      /\bappendFileSync?\b/,
      /\btruncateSync?\b/,
      /\bcreateWriteStream\b/,
      /\bopenSync\s*\([^)]*['"][arw]\+?['"]/,
    ]
    const offenders = sourcesUnder(SRC)
      .filter((file) => WRITES.some((pattern) => pattern.test(code(file))))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('모델 응답을 문서에 적용하거나 본문을 대신 쓰는 이름의 함수가 없다', () => {
    const APPLY = [
      /\bapply(Fix|Edit|Patch|Suggestion|Correction)\b/i,
      /\b(rewrite|autoFix|autoCorrect|autoApply)\w*\s*\(/i,
      /\bwriteHwpx\b/i,
    ]
    const offenders = sourcesUnder(SRC)
      .filter((file) => APPLY.some((pattern) => pattern.test(code(file))))
      .map(rel)
    expect(offenders).toEqual([])
  })
})

describe('모델 교체 가능성 — 코어·앱은 어느 모델인지 모른다 (T-26)', () => {
  /** `modelId` 를 값으로 견주는 코드. 기록·전달은 괜찮고 **분기**가 문제다. */
  const BRANCH = [
    /modelId\s*[=!]==?\s*['"`]/,
    /['"`][^'"`]*['"`]\s*[=!]==?\s*\w*\.?modelId\b/,
    /\bmodelId\s*\.\s*(startsWith|includes|endsWith|match)\s*\(/,
    /\bcase\s+['"`][^'"`]*(gemma|claude|openrouter)[^'"`]*['"`]/i,
    /\bif\s*\([^)]*\b(gemma|claude)\b[^)]*\)/i,
  ]

  for (const layer of ['core', 'app', 'shared']) {
    it(`${layer} 에 모델 이름으로 갈라지는 코드가 없다`, () => {
      const offenders = sourcesUnder(join(SRC, layer))
        .filter((file) => BRANCH.some((pattern) => pattern.test(code(file))))
        .map(rel)
      expect(offenders).toEqual([])
    })
  }

  it('모델 이름 상수는 어댑터 안에만 있다', () => {
    const offenders = sourcesUnder(SRC)
      .filter((file) => /google\/gemma|GEMMA_MODEL_ID\s*=/.test(code(file)))
      .map(rel)
    expect(offenders).toEqual(['src/adapters/model/openrouter-gemma.ts'])
  })
})
