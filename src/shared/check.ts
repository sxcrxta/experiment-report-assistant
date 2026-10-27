/**
 * 양식 점검의 결정론 계산 ([Q-49]). AI 는 조건마다 퍼센트만 준다. 구분과 전체 충족도는 여기서 정한다.
 *
 * 부작용 없는 순수 함수만 둔다. 앱·렌더러·테스트가 함께 쓴다.
 */
export type CheckLevel = 'met' | 'partial' | 'missing'

/** 퍼센트의 구분. 100 이어야 충족, 0 이면 미충족, 그 사이는 일부 충족 */
export function levelOf(score: number): CheckLevel {
  if (score >= 100) return 'met'
  if (score <= 0) return 'missing'
  return 'partial'
}

/** 전체 충족도: 조건별 퍼센트의 평균 (반올림). 조건이 없으면 null */
export function overallScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
}

/** 퍼센트가 없던 예전 점검 결과(1판: 있음/부족/없음)를 퍼센트로 옮긴다 */
export function scoreFromLegacyStatus(status: CheckLevel): number {
  return status === 'met' ? 100 : status === 'partial' ? 50 : 0
}

/** 목차 항목 하나의 글자 수. 프로그램이 센다 — 글자 수 조건을 AI 가 직접 세지 않게 한다 ([Q-50]) */
export interface SectionStat {
  title: string
  level: number
  /** 항목이 차지하는 문단 번호 범위 (1부터) */
  from: number
  to: number
  /** 제목 문단을 뺀 본문의 글자 수 (공백 포함) */
  chars: number
  /** 공백을 뺀 글자 수 */
  charsNoSpace: number
}

/**
 * 목차 항목마다 본문 글자 수를 센다. 제목 문단은 세지 않는다. 하위 항목의 글은 윗항목에도 들어간다.
 * 수식은 글자 수에 넣지 않는다 (한글 수식 스크립트는 사용자가 보는 글자 수와 다르다).
 */
export function sectionStats(
  nodes: readonly { title: string; level: number; paragraphIds: readonly string[]; children: readonly unknown[] }[],
  paragraphs: readonly { paragraphId: string; text: string }[],
): SectionStat[] {
  const position = new Map(paragraphs.map((p, index) => [p.paragraphId, index]))
  const out: SectionStat[] = []
  const walk = (list: typeof nodes): void => {
    for (const node of list) {
      const indexes = node.paragraphIds.map((id) => position.get(id)).filter((i): i is number => i !== undefined)
      if (indexes.length > 0) {
        const body = indexes.slice(1).map((i) => paragraphs[i]!.text).join('')
        out.push({ title: node.title, level: node.level, from: Math.min(...indexes) + 1, to: Math.max(...indexes) + 1,
          chars: body.length, charsNoSpace: body.replace(/\s/g, '').length })
      }
      walk(node.children as typeof nodes)
    }
  }
  walk(nodes)
  return out
}
