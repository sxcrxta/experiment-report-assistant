/**
 * 문서 뼈대에서 **평가 지침 초안의 뼈대**를 세운다 ([Q-37]).
 *
 * 왜 있는가: 지금까지 사용자는 빈 항목에 제목·설명·중요도를 직접 써야 했다. PRD 4.1 은
 * "프로그램은 제목·목차·표·안내 문구 등을 읽어 지침 초안을 제안할 수 있다" 고 이미 허용한다.
 * 여기서 만든 초안은 **초안일 뿐이고**, 사용자가 읽고 고쳐 확정하기 전에는 어떤 AI 호출에도 쓰이지 않는다.
 *
 * 왜 결정론인가: 키가 없거나 오프라인이어도 초안이 나와야 한다. AI 는 이 뼈대를 **다듬는 데만**
 * 쓴다(`app/rubric-suggest.ts`). 여기서는 모델을 부르지 않는다 (`CLAUDE.md` §2).
 *
 * 부작용 없는 순수 함수다. 같은 뼈대에는 같은 초안이 나온다.
 */
import { REVIEW_PERSPECTIVES, type ReviewPerspective } from '../../shared/review.js'
import { RUBRIC_IMPORTANCE_DEFAULT, type RubricImportance } from '../../shared/rubric.js'
import type { RubricItemContent } from './model.js'
import type { DocumentOutline, OutlineEntry } from './outline.js'

/** 초안 항목 수 상한. 너무 많으면 읽고 고치는 것이 또 하나의 일이 된다. */
export const SKELETON_MAX_ITEMS = 8

/**
 * 실험보고서에서 흔히 쓰는 항목 이름과, 거기서 확인할 것.
 *
 * 제목을 이 표에 맞춰 보고, 맞으면 그 설명을 쓴다. 맞는 것이 없으면 제목만 쓰고 설명은 비운다
 * (사용자가 채운다). **없는 항목을 지어내지 않는다.**
 */
interface KnownSection {
  /** 제목에서 찾을 말 */
  keywords: readonly string[]
  description: string
  /** 기본 중요도. 보고서의 핵심일수록 높다 */
  importance: RubricImportance
}

const KNOWN_SECTIONS: readonly KnownSection[] = [
  { keywords: ['목적', '개요'], importance: 3,
    description: '무엇을 확인하려는 실험인지 분명히 적었는지 확인합니다.' },
  { keywords: ['이론', '배경', '원리'], importance: 3,
    description: '실험에 필요한 원리를 근거와 함께 적었는지, 출처를 밝혔는지 확인합니다.' },
  { keywords: ['기구', '재료', '시약', '장치'], importance: 2,
    description: '쓴 기구와 시약을 규격·양까지 적어 같은 실험을 재현할 수 있는지 확인합니다.' },
  { keywords: ['과정', '방법', '절차'], importance: 4,
    description: '다른 사람이 그대로 따라 할 수 있을 만큼 순서와 조건을 적었는지 확인합니다.' },
  { keywords: ['결과', '데이터', '측정'], importance: 5,
    description: '측정값을 단위와 함께 적었는지, 표·그림에 설명을 붙였는지 확인합니다.' },
  { keywords: ['고찰', '논의', '토의'], importance: 5,
    description: '결과에서 결론으로 가는 근거를 적었는지, 오차의 원인을 다뤘는지 확인합니다.' },
  { keywords: ['결론', '요약'], importance: 4,
    description: '목적에 대한 답을 결과에 근거해 적었는지 확인합니다.' },
  { keywords: ['참고', '출처', '문헌'], importance: 2,
    description: '인용한 자료의 출처를 찾아갈 수 있게 적었는지 확인합니다.' },
]

/**
 * 지침 항목 이름에서 **검토 관점**을 읽는다 ([Q-37]).
 *
 * 매 요청마다 관점 7개를 고르게 하지 않기 위해, 확정한 지침이 무엇을 보는지로 기본값을 정한다.
 * 이름에서 아무것도 읽지 못하면 빈 배열이고, 부르는 쪽이 기본 관점으로 내려간다.
 * 모델을 부르지 않는 순수 함수다.
 */
const TITLE_PERSPECTIVES: readonly { keywords: readonly string[]; perspectives: readonly ReviewPerspective[] }[] = [
  { keywords: ['양식', '형식', '서식', '분량'], perspectives: ['format'] },
  { keywords: ['표', '그림', '그래프', '자료', '사진'], perspectives: ['figures'] },
  { keywords: ['참고', '출처', '문헌', '인용'], perspectives: ['references'] },
  { keywords: ['이론', '배경', '원리', '정확', '과학'], perspectives: ['scientific_accuracy'] },
  { keywords: ['결과', '데이터', '측정', '오차'], perspectives: ['scientific_accuracy', 'logic'] },
  { keywords: ['고찰', '논의', '토의', '논리', '근거', '해석'], perspectives: ['logic'] },
  { keywords: ['결론', '목적', '개요', '구조', '순서'], perspectives: ['structure', 'logic'] },
  { keywords: ['과정', '방법', '절차'], perspectives: ['structure'] },
  { keywords: ['표현', '문장', '맞춤법', '용어', '단위'], perspectives: ['expression'] },
]

export function perspectivesForRubricItem(title: string): ReviewPerspective[] {
  const clean = cleanTitle(title)
  const found = TITLE_PERSPECTIVES
    .filter(entry => entry.keywords.some(word => clean.includes(word)))
    .flatMap(entry => entry.perspectives)
  return [...new Set(found)]
}

/**
 * 확정한 지침 전체로 검토 관점을 정한다 ([Q-41]). 사용자는 관점을 고르지 않는다.
 *
 * - 모든 항목에서 읽은 관점을 합친다. 지침에 있는 것을 빼놓고 보지 않는다.
 * - 관점을 읽지 못한 항목이 하나라도 있거나 항목이 없으면 **모든 관점**이다. 그 항목에 대한 피드백이
 *   "요청하지 않은 관점" 으로 버려지지 않게 한다.
 * - 순서는 PRD 4.2 의 관점 순서다. 같은 지침이면 언제나 같은 결과다 (캐시 키가 흔들리지 않는다).
 */
export function perspectivesForRubric(items: readonly { title: string }[]): ReviewPerspective[] {
  const found = new Set<ReviewPerspective>()
  for (const item of items) {
    const perspectives = perspectivesForRubricItem(item.title)
    if (perspectives.length === 0) return [...REVIEW_PERSPECTIVES]
    perspectives.forEach(p => found.add(p))
  }
  if (found.size === 0) return [...REVIEW_PERSPECTIVES]
  return REVIEW_PERSPECTIVES.filter(p => found.has(p))
}

/** 제목을 읽지 못했을 때 쓸 항목 이름. */
const DEFAULT_TITLES: Readonly<Record<'목적' | '과정' | '결과' | '고찰', string>> = {
  목적: '실험 목적', 과정: '실험 과정', 결과: '실험 결과', 고찰: '고찰',
}

/** 제목에서 군더더기를 걷어 낸다. `1. 실험 목적` → `실험 목적` */
function cleanTitle(text: string): string {
  return text
    .replace(/^[\s•·▪◦-]*(?:[0-9]+|[가-힣]|[IVXivx]+)\s*[.)]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function known(title: string): KnownSection | null {
  return KNOWN_SECTIONS.find(section => section.keywords.some(word => title.includes(word))) ?? null
}

/** 제목 줄만, 가장 위 수준부터. 수준이 없으면 나온 순서대로. */
function topHeadings(outline: DocumentOutline): OutlineEntry[] {
  const headings = outline.entries.filter(entry => entry.kind === 'heading')
  if (headings.length === 0) return []
  const levels = headings.map(entry => entry.level).filter((level): level is number => level !== null)
  if (levels.length === 0) return headings
  const top = Math.min(...levels)
  // 가장 바깥 수준이 한 줄뿐이면(보고서 제목 하나) 그 아래 수준을 항목으로 본다.
  const outer = headings.filter(entry => entry.level === top)
  return outer.length > 1 ? outer : headings.filter(entry => entry.level !== null && entry.level <= top + 1)
}

/**
 * 문서 뼈대에서 지침 초안을 만든다.
 *
 * - 제목이 있으면 **그 제목을 항목으로** 쓴다. 문서에 있는 구조를 그대로 따른다.
 * - 제목이 없으면 표·수식이 있는지만 보고 최소한의 항목을 준다.
 * - 어느 쪽이든 **사용자가 고칠 초안**이다. 확정은 사용자가 한다.
 */
export function rubricSkeleton(outline: DocumentOutline): RubricItemContent[] {
  const items: RubricItemContent[] = []
  const seen = new Set<string>()

  const headings = topHeadings(outline)
  // 제목을 하나도 읽지 못한 문서. 실제 보고서가 전체를 표 하나로 만들면 이렇게 된다 ([Q-27]).
  // 빈 초안이나 항목 하나를 주는 대신, 실험보고서에서 흔히 보는 항목으로 시작점을 준다.
  if (headings.length === 0) {
    for (const keyword of ['목적', '과정', '결과', '고찰'] as const) {
      const section = KNOWN_SECTIONS.find(entry => entry.keywords.includes(keyword))!
      items.push({ title: DEFAULT_TITLES[keyword], description: section.description, importance: section.importance })
    }
  }

  for (const entry of headings) {
    const title = cleanTitle(entry.text)
    if (title === '' || seen.has(title)) continue
    seen.add(title)
    const match = known(title)
    items.push({
      title,
      description: match?.description ?? '',
      importance: match?.importance ?? RUBRIC_IMPORTANCE_DEFAULT,
    })
    if (items.length >= SKELETON_MAX_ITEMS) break
  }

  // 표·그림이 있는데 그것을 다루는 항목이 없으면 하나 보탠다. 설명 빠짐은 가장 흔한 지적이다.
  const hasTableItem = items.some(item => /표|그림|자료/.test(item.title))
  if (outline.tableCount > 0 && !hasTableItem && items.length < SKELETON_MAX_ITEMS) {
    items.push({
      title: '표·그림 설명',
      description: '표와 그림마다 번호와 설명을 붙였는지, 본문에서 가리키는지 확인합니다.',
      importance: 3,
    })
  }

  return items
}
