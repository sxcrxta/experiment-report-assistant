/**
 * V-1 통합 테스트 — **실제 한컴오피스 한글 for Mac 으로 저장해서** 확인한다.
 *
 * 자동 테스트(`tests/watcher.test.ts`)는 관찰한 저장 순서를 파일 조작으로 재현할 뿐이다.
 * 그 재현이 실제와 같은지는 사람이 한글에서 ⌘S 를 눌러 확인해야 한다.
 * 그래서 이 테스트는 기본 `npm run check` 에 들어가지 않고 따로 돌린다.
 *
 * ## 실행 방법
 *
 * ```
 * # 1) 한글 for Mac 에서 실험보고서를 연다 (사본을 쓰는 것을 권한다)
 * # 2) 그 파일의 경로를 주고 실행한다
 * V1_HWPX="/Users/…/보고서.hwpx" npm run test:v1
 * # 3) 안내가 나오면 한글에서 내용을 조금 고치고 ⌘S 로 저장한다
 * ```
 *
 * 확인하는 것 (STAGE_TASKS 2단계 완료 조건)
 * - 저장 한 번에 `saved` 가 **정확히 한 번** 나온다
 * - 그때 읽은 파일이 온전하다 (8,192바이트로 잘린 순간을 읽지 않는다)
 * - 바뀐 문단만 추출된다
 * - 원본 HWPX 의 바이트가 프로그램 때문에 변하지 않는다
 */
import { readFileSync, existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { hwpxReader } from '../../src/adapters/hwpx/index.js'
import { createFileWatcher, type WatchEvent } from '../../src/adapters/watcher/index.js'
import { trackParagraphs } from '../../src/core/diff/track.js'

const target = process.env['V1_HWPX']
const ready = target !== undefined && target !== '' && existsSync(target)

if (!ready) {
  console.warn(
    '[건너뜀] V-1 통합 테스트는 실제 한글 저장이 필요합니다.\n' +
      '  V1_HWPX="/경로/보고서.hwpx" npm run test:v1 로 실행한 뒤,\n' +
      '  안내가 나오면 한글에서 문서를 고치고 ⌘S 로 저장하세요.',
  )
}

/** 사람이 한글로 저장하기를 기다리는 시간. */
const WAIT_MS = 120_000

describe.skipIf(!ready)('V-1 — 실제 한글 저장', () => {
  it(
    '저장 한 번에 saved 가 한 번 나오고 바뀐 문단만 추출된다',
    async () => {
      const path = target as string

      const before = hwpxReader.read(path)
      const beforeBytes = readFileSync(path)

      const events: WatchEvent[] = []
      const stop = await createFileWatcher().watch(path, (event) => events.push(event))

      console.warn(
        `\n👉 지금 한글에서 "${path}" 를 조금 고치고 ⌘S 로 저장하세요. ` +
          `(최대 ${WAIT_MS / 1000}초 기다립니다)\n`,
      )

      try {
        const deadline = Date.now() + WAIT_MS
        while (events.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200))
        }

        expect(events.length, '저장을 감지하지 못했습니다').toBeGreaterThan(0)
        expect(events[0]?.kind).toBe('saved')

        // 저장이 끝난 뒤 잠시 더 본다. 한 번의 저장이 두 번으로 새면 안 된다.
        await new Promise((resolve) => setTimeout(resolve, 3000))
        expect(events).toHaveLength(1)

        // 감지 직후의 바이트. 이 뒤로 우리가 파일을 건드리지 않았음을 마지막에 확인한다.
        const savedBytes = readFileSync(path)
        expect(savedBytes.equals(beforeBytes), '내용이 바뀌지 않았습니다').toBe(false)

        const after = hwpxReader.read(path)
        const tracked = trackParagraphs({
          previous: before.paragraphs.map((p) => ({ uuid: p.uuid, hash: p.hash, text: p.text })),
          current: after.paragraphs,
          versionKey: 'v1-integration',
        })

        console.warn(
          `\n[V-1] 문단 ${after.paragraphs.length}개 중 변경 ${tracked.changed.length}개 ` +
            `(그대로 ${tracked.unchangedCount}개, 삭제 ${tracked.removed.length}개)\n` +
            tracked.changed
              .map((c) => `  - [${c.change}] ${c.paragraph.text.slice(0, 40)}`)
              .join('\n'),
        )

        // 고쳤으니 변경이 있어야 하고, 문서 전체가 바뀐 것으로 나오면 추적이 깨진 것이다.
        expect(tracked.changed.length + tracked.removed.length).toBeGreaterThan(0)
        expect(tracked.unchangedCount).toBeGreaterThan(0)

        // 이 프로그램은 문서를 읽기만 한다. 감지 뒤로 바이트가 그대로다 (T-13).
        expect(readFileSync(path).equals(savedBytes)).toBe(true)
      } finally {
        stop()
      }
    },
    WAIT_MS + 30_000,
  )
})
