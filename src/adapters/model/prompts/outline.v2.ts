/**
 * 목차 나누기 2판 ([Q-48]). 1판에 **문서 종류 짐작**을 더했다.
 *
 * 같은 호출에서 함께 묻는다 — 따로 부르면 문서를 한 번 더 보내야 한다. 나가는 내용은 1판과 같다
 * (글이 있는 문단의 번호와 앞 60자, 과목). 종류는 검토·다듬기에 참고로만 쓰고, 사용자가 고칠 수 있다.
 */
import { OUTLINE_MAX_ITEMS, OUTLINE_MAX_LEVEL } from '../../../shared/outline.js'

import { renderOutlinePrompt as renderV1, type OutlinePayload } from './outline.v1.js'

export const OUTLINE_PROMPT_VERSION = 'outline.v2'

/** 문서 종류 한 줄의 최대 길이 */
export const DOCUMENT_KIND_LIMIT = 80

export function renderOutlinePrompt(payload: OutlinePayload): string {
  const v1 = renderV1(payload)
  return v1.replace(
    '정확히 다음 JSON만 반환하세요.\n{"items":[{"n":12,"level":1,"title":"2. 이론적 배경"}]}',
    [
      '또 이 문서가 어떤 문서인지 한 줄로 kind 에 적으세요. 종류와 주제를 함께 (예: "실험 보고서 — 기체의 몰질량 측정",',
      '"대회 참가 신청서 — 과학 탐구 대회", "독서 감상문 — 『코스모스』"). 평가하지 마세요. 40자 안팎.',
      '정확히 다음 JSON만 반환하세요.',
      '{"kind":"실험 보고서 — …","items":[{"n":12,"level":1,"title":"2. 이론적 배경"}]}',
    ].join('\n'),
  )
}

export const OUTLINE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', maxLength: DOCUMENT_KIND_LIMIT },
    items: {
      type: 'array',
      maxItems: OUTLINE_MAX_ITEMS,
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', minimum: 1 },
          level: { type: 'integer', minimum: 1, maximum: OUTLINE_MAX_LEVEL },
          title: { type: 'string', maxLength: 80 },
        },
        required: ['n', 'level', 'title'],
      },
    },
  },
  required: ['kind', 'items'],
} as const

/** 모델이 짐작한 문서 종류. 없거나 형식이 틀리면 빈 문자열 (목차는 그대로 쓴다) */
export function parseDocumentKind(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return ''
  try {
    const kind = (JSON.parse(text.slice(start, end + 1)) as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_KIND_LIMIT) : ''
  } catch {
    return ''
  }
}
