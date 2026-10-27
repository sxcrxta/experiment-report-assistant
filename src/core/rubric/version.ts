/**
 * 지침 내용 해시와 `rubricVersion` 계산.
 *
 * PRD 4.5: 지침 버전은 AI 결과 재사용(메모이제이션) 키의 일부다. 그래서 같은 입력이면 언제나 같은 값이
 * 나오는 순수 함수로 계산한다 (`CLAUDE.md` §2).
 *
 * 두 값을 나눠 쓴다.
 * - **내용 해시**: 항목(식별자·이름·설명·중요도)과 순서만으로 정한다. "바뀐 게 있는가"를 판단한다.
 * - **rubricVersion**: 문서·확정 순번·내용 해시로 정한다. 확정할 때마다(내용이 바뀐 경우) 새 값이 된다.
 *   예전 내용으로 되돌려 확정해도 순번이 달라 **새 버전**이 된다. 버전은 되감기지 않고 올라가기만 한다.
 */
import { sha256Hex } from '../document/sha256.js'

import type { RubricItem } from './model.js'

/** 입력을 이어 붙일 때 쓰는 구분자. 문서 식별자와 해시에는 나타날 수 없는 제어 문자다. */
const SEP = ''

/**
 * 지침 내용 해시. 항목 순서도 내용이다.
 * 중요도는 우선순위 점수의 입력이므로, 중요도만 바꿔도 다른 값이 나와야 한다.
 */
export function rubricContentHash(items: readonly RubricItem[]): string {
  const canonical = items.map((item) => [item.itemId, item.title, item.description, item.importance])
  return sha256Hex(JSON.stringify(canonical))
}

export interface RubricVersionInput {
  documentId: string
  /** 그 문서에서 몇 번째로 확정한 지침인가 (1부터) */
  ordinal: number
  contentHash: string
}

export function computeRubricVersion({ documentId, ordinal, contentHash }: RubricVersionInput): string {
  return sha256Hex(['rubric', documentId, String(ordinal), contentHash].join(SEP))
}
