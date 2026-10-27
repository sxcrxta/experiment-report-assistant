/**
 * 글 다듬기의 메인 프로세스 쪽 처리 ([Q-43]).
 *
 * 렌더러에서 온 값의 형태를 여기서 확인하고, 판단은 `app/polish.ts` 가 한다.
 * electron 을 import 하지 않는다. 그래야 Electron 없이 테스트할 수 있다.
 */
import type { PolishInput, PolishOutcome } from '../app/polish.js'
import { SUBJECT_MAX_LENGTH, type PolishResult } from '../shared/ipc.js'
import { REVIEW_DEPTHS } from '../shared/review.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 형태가 틀리면 null. 길이 제한은 서비스가 사용자 문구와 함께 본다 */
export function parsePolishRequest(value: unknown): PolishInput | null {
  if (!isRecord(value)) return null
  const { draft, note, subject, depth, kind } = value
  if (typeof draft !== 'string' || typeof note !== 'string') return null
  if (subject !== null && (typeof subject !== 'string' || subject.length > SUBJECT_MAX_LENGTH)) return null
  if (typeof depth !== 'string' || !(REVIEW_DEPTHS as readonly string[]).includes(depth)) return null
  if (kind !== undefined && kind !== null && (typeof kind !== 'string' || kind.length > 80)) return null
  return { draft, note, subject, depth: depth as PolishInput['depth'], kind: typeof kind === 'string' ? kind : '' }
}

export function createPolishHandler(service: { polish(input: PolishInput): Promise<PolishOutcome> }) {
  return async (request: unknown): Promise<PolishResult> => {
    const parsed = parsePolishRequest(request)
    if (parsed === null) return { status: 'failed', message: '다듬기 요청을 읽지 못했습니다.' }
    const result = await service.polish(parsed)
    return result.ok
      ? { status: 'polished', text: result.text, modelId: result.modelId }
      : { status: 'failed', message: result.message }
  }
}
