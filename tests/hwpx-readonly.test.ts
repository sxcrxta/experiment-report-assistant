/**
 * HWPX 어댑터가 읽기 전용임을 코드 수준에서 못박는다 (T-13).
 *
 * PRD 4.5: "프로그램은 사용자의 HWPX를 읽기만 하며 어떤 경우에도 수정하지 않는다."
 * 실수로 쓰기 코드가 들어오면 이 테스트가 막는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ADAPTER_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'hwpx')

/**
 * 파일이나 아카이브에 쓰는 API 이름.
 * 식별자 경계로 찾는다. 부분 문자열로 찾으면 unzipSync 가 zipSync 로 잡히는 오탐이 난다.
 */
const WRITE_APIS = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'copyFile',
  'copyFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rmSync',
  'truncate',
  'truncateSync',
  'zip',
  'zipSync',
  'strToU8',
  'deflateSync',
]

/**
 * 주석과 문자열 리터럴을 걷어낸다.
 * 걷어내지 않으면 mimetype 문자열 'application/hwp+zip' 이 zip 으로 잡히는 오탐이 난다.
 */
export function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

export function usesWriteApiForTest(code: string, api: string): boolean {
  return usesWriteApi(code, api)
}

function usesWriteApi(code: string, api: string): boolean {
  return new RegExp(String.raw`\b${api}\b`).test(code)
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return entry.endsWith('.ts') ? [full] : []
  })
}

describe('HWPX 어댑터는 읽기 전용이다', () => {
  it('쓰기 API 를 하나도 쓰지 않는다', () => {
    const found: string[] = []
    for (const file of sourceFiles(ADAPTER_DIR)) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
      for (const api of WRITE_APIS) {
        if (usesWriteApi(code, api)) found.push(`${file}: ${api}`)
      }
    }
    expect(found).toEqual([])
  })

  it('검사기가 주석과 문자열은 무시하고 실제 호출만 잡는다', () => {
    const benign = stripCommentsAndStrings(
      "// zipSync 이야기\nconst MIME = 'application/hwp+zip'\nunzipSync(bytes)",
    )
    expect(usesWriteApiForTest(benign, 'zip')).toBe(false)
    expect(usesWriteApiForTest(benign, 'zipSync')).toBe(false)

    const bad = stripCommentsAndStrings('writeFileSync(path, bytes)')
    expect(usesWriteApiForTest(bad, 'writeFileSync')).toBe(true)
  })

  it('내보내는 이름에 write/save 가 없다', async () => {
    const module = (await import('../src/adapters/hwpx/index.js')) as Record<string, unknown>
    const suspicious = Object.keys(module).filter((name) => /write|save|insert|update/i.test(name))
    expect(suspicious).toEqual([])
  })
})
