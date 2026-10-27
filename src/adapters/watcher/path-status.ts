/**
 * 감시 대상 경로의 상태 판정.
 *
 * PRD 5절
 * - "사용자가 직접 선택한 문서 경로만 사용하며 전체 디스크 접근 권한을 요청하지 않는다."
 * - "iCloud에 있는 문서는 로컬에 내려받은 경우에만 감시한다."
 * - "한컴오피스 한글 for Mac이 저장한 HWPX만 지원한다."
 *
 * 접근에 실패하면 권한을 새로 요구하지 않고 **사용자에게 재선택을 요청한다** (`CLAUDE.md` §4).
 * 여기서 만드는 문구는 그대로 사용자에게 보인다.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { icloudPlaceholderName, isHwpxFilename, toNfc } from './filename.js'

export type PathStatusKind =
  | 'ok'
  | 'missing'
  | 'icloud-not-downloaded'
  | 'permission-denied'
  | 'unsupported-format'
  | 'not-a-file'

export interface PathStatus {
  kind: PathStatusKind
  /** 사용자에게 그대로 보여 줄 한국어 안내 */
  message: string
  byteSize: number | null
}

const OK: (byteSize: number) => PathStatus = (byteSize) => ({
  kind: 'ok',
  message: '',
  byteSize,
})

function errnoOf(cause: unknown): string | null {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/**
 * 경로를 읽을 수 있는 HWPX 로 볼 수 있는지 판정한다. 파일을 열거나 고치지 않는다.
 */
export function classifyPath(absolutePath: string): PathStatus {
  const name = basename(absolutePath)

  if (!isHwpxFilename(name)) {
    return {
      kind: 'unsupported-format',
      message: `HWPX 파일만 다룰 수 있습니다. 선택한 파일: ${toNfc(name)}`,
      byteSize: null,
    }
  }

  try {
    const stats = statSync(absolutePath)
    if (!stats.isFile()) {
      return {
        kind: 'not-a-file',
        message: `파일이 아닙니다: ${toNfc(name)}`,
        byteSize: null,
      }
    }
    return OK(stats.size)
  } catch (cause) {
    const code = errnoOf(cause)

    if (code === 'EACCES' || code === 'EPERM') {
      return {
        kind: 'permission-denied',
        message:
          '이 파일을 읽을 권한이 없습니다. 파일 선택 창에서 문서를 다시 선택해 주세요. ' +
          '(전체 디스크 접근 권한은 요청하지 않습니다.)',
        byteSize: null,
      }
    }

    if (existsSync(join(dirname(absolutePath), icloudPlaceholderName(name)))) {
      return {
        kind: 'icloud-not-downloaded',
        message:
          'iCloud 에 있고 이 맥에는 아직 내려받지 않은 문서입니다. ' +
          'Finder 에서 문서를 내려받은 뒤 다시 선택해 주세요.',
        byteSize: null,
      }
    }

    return {
      kind: 'missing',
      message: `문서 경로를 찾을 수 없습니다: ${absolutePath}`,
      byteSize: null,
    }
  }
}
