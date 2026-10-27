/**
 * 저장 감지 테스트 — 한글 for Mac 의 저장 동작을 재현한다.
 *
 * 근거는 V-1 관찰이다 (`docs/V1-hwpx-저장동작.md`).
 * ```
 * <파일명>.BAK 생성 → 원본을 제자리에서 8,192바이트로 truncate → 약 20ms 뒤 재작성 → .BAK 삭제
 * ```
 * 이 테스트는 **한글 없이** 그 순서를 파일 조작으로 재현한다. 실제 한글로 하는 검증은
 * `tests/integration/v1-hangul-save.test.ts` 가 따로 맡는다 (수동 실행).
 *
 * T-14: 저장 도중(8KB 로 잘린 순간)에 읽기가 일어나지 않고, 저장 후 감시가 유지된다.
 *       `.BAK` 을 문서로 착각하지 않는다. 파일 이름을 NFD 로 받아도 대상 문서로 인식한다.
 * T-16: 경로를 잃으면 감시를 멈추고 알리며, 임의의 다른 파일을 추적하지 않는다.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyPath,
  createFileWatcher,
  icloudPlaceholderName,
  isHwpxFilename,
  sameFilename,
  WatchTargetError,
  type WatchEvent,
} from '../src/adapters/watcher/index.js'

import { makeHwpx, para } from './helpers/make-hwpx.js'

/** 관찰된 truncate 크기. */
const TRUNCATED_SIZE = 8192
/** 관찰된 truncate → 재작성 간격. */
const REWRITE_GAP_MS = 20

const FAST = {
  quietPeriodMs: 40,
  integrityRetries: 8,
  integrityRetryMs: 20,
  missingGraceMs: 120,
  safetyPollMs: 100,
}

const cleanups: (() => void)[] = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(): string {
  // /var -> /private/var 심볼릭 링크 때문에 realpath 로 맞춘다.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'watcher-')))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 8,192바이트보다 **큰** 합성 HWPX.
 * 저장 도중의 truncate 를 재현하려면 원본이 잘린 크기보다 커야 한다. 잘 압축되는 반복 문자열로는
 * 그 크기가 나오지 않아서 문단마다 다른 내용을 채운다.
 */
function hwpxBytes(bodyText: string): Uint8Array {
  const filler = Array.from({ length: 3000 }, (_, i) =>
    para(`채움 문단 ${i} ${((i * 2654435761) % 1000000007).toString(36)}`),
  ).join('')
  return makeHwpx({ sections: [para(bodyText) + filler] })
}

/** 파일을 만들고, 재현 조건(8,192바이트 초과)을 지키는지 확인한다. */
function writeHwpx(path: string, bodyText: string): Uint8Array {
  const bytes = hwpxBytes(bodyText)
  writeFileSync(path, bytes)
  expect(statSync(path).size).toBeGreaterThan(TRUNCATED_SIZE)
  return bytes
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  throw new Error('기다리던 조건이 시간 안에 일어나지 않았습니다')
}

interface Watched {
  events: WatchEvent[]
  stop: () => void
}

async function startWatching(path: string, options = FAST): Promise<Watched> {
  const events: WatchEvent[] = []
  const stop = await createFileWatcher(options).watch(path, (event) => events.push(event))
  cleanups.push(stop)
  return { events, stop }
}

/** V-1 에서 관찰한 저장 순서를 그대로 재현한다. */
async function simulateHangulSave(path: string, nextBytes: Uint8Array): Promise<void> {
  const backup = `${path.replace(/\.hwpx$/, '')}.BAK`
  copyFileSync(path, backup)
  truncateSync(path, TRUNCATED_SIZE)
  await delay(REWRITE_GAP_MS)
  writeFileSync(path, nextBytes)
  rmSync(backup)
}

describe('파일 이름 비교 (V-1 §2.4)', () => {
  const nfc = '결과보고서.hwpx'.normalize('NFC')
  const nfd = '결과보고서.hwpx'.normalize('NFD')

  it('NFD 와 NFC 는 === 로는 다르다', () => {
    expect(nfc === nfd).toBe(false)
  })

  it('정규화 후에는 같은 파일로 본다', () => {
    expect(sameFilename(nfd, nfc)).toBe(true)
    expect(sameFilename(nfc, nfc)).toBe(true)
  })

  it('.BAK 은 대상 파일이 아니다', () => {
    expect(sameFilename('결과보고서.BAK', nfc)).toBe(false)
    expect(sameFilename('결과보고서.hwpx.BAK', nfc)).toBe(false)
  })

  it('HWPX 만 지원 형식이다', () => {
    expect(isHwpxFilename('보고서.hwpx')).toBe(true)
    expect(isHwpxFilename('보고서.HWPX')).toBe(true)
    expect(isHwpxFilename('보고서.hwp')).toBe(false)
    expect(isHwpxFilename('보고서.docx')).toBe(false)
  })
})

describe('경로 상태 판정', () => {
  it('HWPX 가 아니면 안내하고 처리하지 않는다', () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwp')
    writeFileSync(path, 'not hwpx')

    const status = classifyPath(path)
    expect(status.kind).toBe('unsupported-format')
    expect(status.message).toContain('HWPX')
  })

  it('iCloud 에서 아직 내려받지 않은 문서를 알아본다', () => {
    const dir = tempDir()
    const name = '보고서.hwpx'
    writeFileSync(join(dir, icloudPlaceholderName(name)), 'placeholder')

    const status = classifyPath(join(dir, name))
    expect(status.kind).toBe('icloud-not-downloaded')
    expect(status.message).toContain('iCloud')
  })

  it('없는 경로는 missing 이다', () => {
    expect(classifyPath(join(tempDir(), '없는파일.hwpx')).kind).toBe('missing')
  })

  it('HWPX 가 아닌 파일은 감시하지 않는다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.docx')
    writeFileSync(path, 'x')

    await expect(createFileWatcher(FAST).watch(path, () => {})).rejects.toBeInstanceOf(
      WatchTargetError,
    )
  })
})

describe('한글 for Mac 저장 재현', () => {
  it('저장 한 번에 saved 를 정확히 한 번 낸다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음 내용')

    const watched = await startWatching(path)
    const next = hwpxBytes('고친 내용')
    await simulateHangulSave(path, next)

    await waitFor(() => watched.events.length > 0)
    await delay(FAST.quietPeriodMs * 6)

    expect(watched.events).toHaveLength(1)
    const [event] = watched.events
    expect(event?.kind).toBe('saved')
    // 8,192바이트로 잘린 순간을 읽지 않았다 (T-14).
    expect(event?.kind === 'saved' ? event.byteSize : 0).toBe(next.byteLength)
    expect(event?.kind === 'saved' ? event.byteSize : 0).not.toBe(TRUNCATED_SIZE)
  })

  it('두 번 저장하면 두 번 알린다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')

    const watched = await startWatching(path)

    await simulateHangulSave(path, hwpxBytes('두 번째'))
    await waitFor(() => watched.events.length >= 1)

    await simulateHangulSave(path, hwpxBytes('세 번째'))
    await waitFor(() => watched.events.length >= 2)

    await delay(FAST.quietPeriodMs * 4)
    expect(watched.events.map((e) => e.kind)).toEqual(['saved', 'saved'])
  })

  it('.BAK 이 생겼다 사라지는 것만으로는 아무 일도 일어나지 않는다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')

    const watched = await startWatching(path)

    const backup = join(dir, '보고서.BAK')
    copyFileSync(path, backup)
    await delay(FAST.quietPeriodMs * 3)
    rmSync(backup)
    await delay(FAST.quietPeriodMs * 4)

    expect(watched.events).toEqual([])
  })

  it('저장이 끝나지 않아 계속 깨져 있으면 정직하게 알린다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')

    const watched = await startWatching(path)

    // 잘린 상태로 그대로 둔다. 한 번 실패했다고 바로 알리지 않고 재시도한 뒤에 알린다.
    truncateSync(path, TRUNCATED_SIZE)

    await waitFor(() => watched.events.length > 0, 8000)
    expect(watched.events[0]?.kind).toBe('unreadable')
  })

  it('NFD 이름으로 저장된 파일을 NFC 경로로 감시한다 (V-1 §2.4)', async () => {
    const dir = tempDir()
    const nfdPath = join(dir, '결과보고서.hwpx'.normalize('NFD'))
    const nfcPath = join(dir, '결과보고서.hwpx'.normalize('NFC'))
    writeFileSync(nfdPath, hwpxBytes('처음'))

    if (!existsSync(nfcPath)) {
      // APFS 는 이름을 정규화 없이 저장하되 조회는 정규화해서 한다. 그렇지 않은 파일 시스템이면
      // 이 확인은 의미가 없다. 이름 비교 자체는 위의 sameFilename 테스트가 못박는다.
      console.warn('[건너뜀] 이 파일 시스템은 NFC/NFD 조회를 같게 다루지 않습니다')
      return
    }

    const watched = await startWatching(nfcPath)
    await simulateHangulSave(nfdPath, hwpxBytes('고친 내용'))

    await waitFor(() => watched.events.length > 0)
    expect(watched.events[0]?.kind).toBe('saved')
  })
})

describe('경로 유실 (T-16)', () => {
  it('이름이 바뀌면 알리고 감시를 멈춘다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')

    const watched = await startWatching(path)
    renameSync(path, join(dir, '보고서-최종.hwpx'))

    await waitFor(() => watched.events.length > 0)
    const [event] = watched.events
    expect(event?.kind).toBe('path-lost')
    expect(event?.kind === 'path-lost' ? event.message : '').toContain('다시 선택')

    // 비슷한 다른 파일을 임의로 추적하지 않는다.
    writeFileSync(join(dir, '보고서-최종.hwpx'), hwpxBytes('다른 내용'))
    await delay(FAST.quietPeriodMs * 6)
    expect(watched.events).toHaveLength(1)
  })

  it('다른 폴더로 옮겨도 경로 유실이다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')
    const moved = join(dir, '하위')
    mkdirSync(moved)

    const watched = await startWatching(path)
    renameSync(path, join(moved, '보고서.hwpx'))

    await waitFor(() => watched.events.length > 0)
    expect(watched.events[0]?.kind).toBe('path-lost')
  })

  it('삭제되면 경로 유실이다', async () => {
    const dir = tempDir()
    const path = join(dir, '보고서.hwpx')
    writeHwpx(path, '처음')

    const watched = await startWatching(path)
    rmSync(path)

    await waitFor(() => watched.events.length > 0)
    expect(watched.events[0]?.kind).toBe('path-lost')
  })
})
