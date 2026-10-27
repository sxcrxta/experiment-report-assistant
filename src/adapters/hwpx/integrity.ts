/**
 * HWPX 온전성 확인 — **읽기 전용**.
 *
 * V-1 관찰(`docs/V1-hwpx-저장동작.md` §2.2): 한글 for Mac 은 저장할 때 원본을 제자리에서
 * 8,192바이트로 잘라낸 뒤 약 20ms 뒤에 다시 쓴다. 그 사이에 읽으면 **잘린 ZIP** 을 읽는다.
 * 그래서 감시자는 파일을 문단으로 파싱하기 전에 여기서 먼저 온전한지 본다.
 *
 * 전체를 압축 해제하지 않고 ZIP 목록과 `mimetype` 만 본다. 2MB 문서를 저장할 때마다
 * 통째로 푸는 비용을 치를 이유가 없다.
 */
import { readFileSync } from 'node:fs'

import { unzipSync } from 'fflate'

const MIMETYPE = 'application/hwp+zip'

export type IntegrityResult =
  | { ok: true; byteSize: number }
  | { ok: false; reason: string; byteSize: number | null }

const decoder = new TextDecoder('utf-8')

/**
 * 파일이 지금 온전한 HWPX 인지 본다.
 *
 * 실패는 "문서가 깨졌다"는 뜻이 아니다. 저장이 아직 끝나지 않았을 수 있다
 * (`CLAUDE.md` §3). 호출하는 쪽이 잠시 뒤 다시 물어봐야 한다.
 */
export function checkHwpxIntact(absolutePath: string): IntegrityResult {
  let bytes: Uint8Array
  try {
    bytes = readFileSync(absolutePath)
  } catch (cause) {
    return {
      ok: false,
      reason: `파일을 읽지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
      byteSize: null,
    }
  }

  const byteSize = bytes.byteLength
  if (byteSize === 0) return { ok: false, reason: '파일이 비어 있습니다', byteSize }

  let mimetype: Uint8Array | undefined
  try {
    mimetype = unzipSync(bytes, { filter: (file) => file.name === 'mimetype' })['mimetype']
  } catch (cause) {
    return {
      ok: false,
      reason: `ZIP 으로 열리지 않습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
      byteSize,
    }
  }

  if (mimetype === undefined) return { ok: false, reason: 'mimetype 항목이 없습니다', byteSize }

  const value = decoder.decode(mimetype).trim()
  if (value !== MIMETYPE) {
    return { ok: false, reason: `mimetype 이 "${value}" 입니다`, byteSize }
  }

  return { ok: true, byteSize }
}
