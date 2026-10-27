/**
 * 검토 문맥 범위 — AI 에 대상 문단과 함께 보낼 앞뒤 문단을 고른다.
 *
 * PRD 4.5(Myers Diff): "해당 부분과 필요한 앞뒤 문맥만 AI에 전달한다."
 * CLAUDE.md §4: 외부로 나가는 것은 그 요청에 필요한 최소 텍스트뿐이다.
 *
 * 판정 규칙 (전부 결정론)
 * - 대상 문단마다 앞쪽과 뒤쪽에서 각각 가장 가까운 문단을 `CONTEXT_RADIUS` 개까지 고른다.
 * - 대상 문단과 글이 없는 문단은 문맥으로 세지 않고 건너뛴다.
 *   그래서 이어진 대상 묶음은 묶음 전체의 앞뒤만 문맥으로 받는다.
 * - 결과는 문서 순서이고 겹치지 않는다.
 */
import type { Paragraph } from '../document/model.js'

/** 대상 문단 한쪽마다 붙일 문맥 문단 수. 상수를 여기 한 곳에만 두고 테스트로 고정한다. */
export const CONTEXT_RADIUS = 1

/**
 * @param paragraphs 한 버전의 문단 전체. 문서 순서여야 한다
 * @param targetIds 검토 대상 문단 uuid
 * @returns 문맥으로 보낼 문단. 대상 문단은 들어 있지 않다
 */
export function selectContext(
  paragraphs: readonly Paragraph[],
  targetIds: ReadonlySet<string>,
  radius: number = CONTEXT_RADIUS,
): Paragraph[] {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError(`문맥 범위는 0 이상의 정수여야 합니다: ${radius}`)
  }

  const chosen = new Set<number>()
  paragraphs.forEach((paragraph, position) => {
    if (!targetIds.has(paragraph.uuid)) return

    for (const step of [-1, 1]) {
      let found = 0
      for (let i = position + step; i >= 0 && i < paragraphs.length && found < radius; i += step) {
        const candidate = paragraphs[i]
        if (candidate === undefined) break
        if (targetIds.has(candidate.uuid) || candidate.text === '') continue
        chosen.add(i)
        found += 1
      }
    }
  })

  return [...chosen].sort((a, b) => a - b).flatMap((i) => {
    const paragraph = paragraphs[i]
    return paragraph === undefined ? [] : [paragraph]
  })
}
