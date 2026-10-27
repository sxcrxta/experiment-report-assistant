import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  checkFile,
  extractImports,
  formatViolations,
  layerOf,
  resolveRelative,
} from '../tools/boundaries.js'

const ROOT = join(import.meta.dirname, '..')

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('계층 경계 — 실제 소스', () => {
  it('src 전체가 계층 규칙을 지킨다', () => {
    const files = collectSourceFiles(join(ROOT, 'src'))
    expect(files.length).toBeGreaterThan(0)

    const violations = files.flatMap((full) => {
      const rel = relative(ROOT, full).split(sep).join('/')
      return checkFile(rel, readFileSync(full, 'utf8'))
    })

    if (violations.length > 0) {
      throw new Error(`계층 경계 위반 ${violations.length}건:\n${formatViolations(violations)}`)
    }
    expect(violations).toEqual([])
  })
})

describe('계층 경계 — 검사기 자체', () => {
  it('경로에서 계층을 알아낸다', () => {
    expect(layerOf('src/core/diff/myers.ts')).toBe('core')
    expect(layerOf('src/adapters/hwpx/index.ts')).toBe('adapters')
    expect(layerOf('tools/boundaries.ts')).toBeNull()
    expect(layerOf('src/unknown/x.ts')).toBeNull()
  })

  it('상대 경로를 저장소 기준으로 정규화한다', () => {
    expect(resolveRelative('src/app/review.ts', '../core/diff')).toBe('src/core/diff')
    expect(resolveRelative('src/app/review.ts', './helper')).toBe('src/app/helper')
  })

  it('여러 형태의 import 를 모두 뽑는다', () => {
    const source = [
      "import a from 'one'",
      "import { b } from \"two\"",
      "export { c } from 'three'",
      "const d = await import('four')",
      "const e = require('five')",
      "import 'six'",
    ].join('\n')
    expect(extractImports(source)).toEqual(
      expect.arrayContaining(['one', 'two', 'three', 'four', 'five', 'six']),
    )
  })

  it('문장 경계를 넘어 매칭하지 않는다', () => {
    // export {} 뒤에 오는 import 의 from 절에 붙어 중복/오탐이 나던 회귀 케이스
    const source = ["export {}", "import { readFileSync } from 'node:fs'"].join('\n')
    expect(extractImports(source)).toEqual(['node:fs'])

    const two = ["import { a } from 'one'", "import { b } from 'two'"].join('\n')
    expect(extractImports(two)).toEqual(['one', 'two'])
  })

  it('같은 모듈을 여러 번 import 해도 한 번만 센다', () => {
    const source = ["import { a } from 'one'", "import { b } from 'one'"].join('\n')
    expect(extractImports(source)).toEqual(['one'])
  })

  it('주석 안의 import 는 무시한다', () => {
    expect(extractImports("// import x from 'nope'\n/* import y from 'nope2' */")).toEqual([])
  })

  it('core 가 Node 내장 모듈을 쓰면 잡는다', () => {
    const violations = checkFile('src/core/document.ts', "import { readFileSync } from 'node:fs'")
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toContain('Node 내장 모듈')
  })

  it('core 가 adapters 를 import 하면 잡는다', () => {
    const violations = checkFile('src/core/document.ts', "import { read } from '../adapters/hwpx'")
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toContain('adapters 계층을 import 할 수 없다')
  })

  it('renderer 가 electron 이나 core 를 직접 import 하면 잡는다', () => {
    expect(checkFile('src/renderer/src/main.ts', "import { ipcRenderer } from 'electron'")).toHaveLength(1)
    expect(checkFile('src/renderer/src/main.ts', "import { hash } from '../../core/hash'")).toHaveLength(1)
  })

  it('허용된 방향은 통과시킨다', () => {
    expect(checkFile('src/app/review.ts', "import { diff } from '../core/diff'")).toEqual([])
    expect(checkFile('src/adapters/repo/index.ts', "import Database from 'better-sqlite3'")).toEqual([])
    expect(checkFile('src/preload/index.ts', "import { contextBridge } from 'electron'")).toEqual([])
    expect(checkFile('src/renderer/src/main.ts', "import { CHANNELS } from '../../shared/ipc'")).toEqual([])
  })
})
