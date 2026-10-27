/**
 * 보고서 항목 경계 추정 (PRD 4.2).
 *
 * "보고서 항목의 경계는 제목 스타일과 지침 항목으로 추정하고 사용자가 수정한다."
 *
 * 그래서 이 모듈은 **추정만** 한다. 추정 결과는 언제나 사용자가 고칠 수 있고, 사용자가 고친 값이 있으면
 * 그 값이 이긴다. AI 는 여기에 관여하지 않는다 (`CLAUDE.md` §2).
 *
 * 추정 순서
 * 1. 제목 스타일(`role === 'heading'`)이 있으면 제목 문단이 항목의 시작이다.
 *    개요 수준이 섞여 있으면 **가장 얕은 수준**만 항목 경계로 본다. (개요 1 이 항목, 개요 2 는 그 안의 소제목)
 * 2. 제목이 없으면 확정 지침 항목의 이름과 **같은 문단**을 시작으로 본다.
 *    "3. 결론" 처럼 번호가 붙거나 끝에 쉼표·콜론이 붙은 형태까지만 같은 것으로 본다.
 *    본문 문장이 우연히 지침 이름을 품는 경우까지 항목 시작으로 삼지 않는다.
 * 3. 둘 다 없으면 문서 전체가 항목 하나다.
 * 4. 첫 시작보다 앞에 있는 문단은 앞선 항목이 없으므로 "문서 앞부분" 으로 따로 묶는다.
 *
 * 사용자가 고친 경계는 문단 UUID 로 저장한다. 저장이 위치(번호)가 아니라 UUID 를 쓰는 이유는
 * 다음 저장에서 문단이 밀려도 경계가 그대로 따라오게 하기 위해서다. 가리키던 문단이 사라지면
 * 임의로 다른 문단에 붙이지 않고 추정으로 되돌린 뒤 그 사실을 알린다.
 */
import type { SectionBoundary, SectionOverride, SectionSource } from '../../shared/feedback.js'
import type { Paragraph } from '../document/model.js'
import { normalizeText } from '../document/normalize.js'

export type { SectionBoundary, SectionOverride, SectionSource }

/** 경계 추정에 필요한 것만. 실제 `Paragraph` 를 그대로 넣을 수 있다. */
export type SectionParagraph = Pick<Paragraph, 'uuid' | 'index' | 'role' | 'headingLevel' | 'text'>

/** 문서 앞부분(첫 제목보다 앞)에 붙이는 이름. */
export const LEAD_SECTION_TITLE = '문서 앞부분'
/** 경계를 추정할 근거가 없을 때 쓰는 이름. */
export const WHOLE_DOCUMENT_TITLE = '전체 문서'

/** 항목 이름 비교용 정규화. 번호 접두사와 끝의 구두점을 걷어 낸다. */
function canonical(text: string): string {
  return normalizeText(text)
    .replace(/^[[(<]?\s*(?:\d+|[IVXLCivxlc]+|[가-힣])\s*[.)\]>]\s*/u, '')
    .replace(/[.:：,·\s]+$/u, '')
    .trim()
}

/** 제목 스타일로 항목이 시작하는 문단을 고른다. */
function headingStarts(paragraphs: readonly SectionParagraph[]): number[] {
  const headings = paragraphs
    .map((paragraph, position) => ({ paragraph, position }))
    .filter(({ paragraph }) => paragraph.role === 'heading' && paragraph.text !== '')
  if (headings.length === 0) return []

  const levels = headings
    .map(({ paragraph }) => paragraph.headingLevel)
    .filter((level): level is number => level !== null)
  if (levels.length === 0) return headings.map(({ position }) => position)

  const shallowest = Math.min(...levels)
  return headings
    .filter(({ paragraph }) => paragraph.headingLevel === shallowest)
    .map(({ position }) => position)
}

/** 지침 항목 이름과 같은 문단을 고른다. */
function rubricStarts(paragraphs: readonly SectionParagraph[], rubricTitles: readonly string[]): number[] {
  const wanted = new Map<string, string>()
  for (const title of rubricTitles) {
    const key = canonical(title)
    if (key !== '' && !wanted.has(key)) wanted.set(key, title)
  }
  if (wanted.size === 0) return []

  const starts: number[] = []
  paragraphs.forEach((paragraph, position) => {
    if (paragraph.text === '') return
    if (wanted.has(canonical(paragraph.text))) starts.push(position)
  })
  return starts
}

function build(
  paragraphs: readonly SectionParagraph[],
  start: number,
  end: number,
  title: string,
  source: SectionSource,
  ordinal: number,
): SectionBoundary | null {
  const first = paragraphs[start]
  const last = paragraphs[end]
  if (first === undefined || last === undefined) return null
  return {
    ordinal,
    title,
    startIndex: start,
    endIndex: end,
    startParagraphUuid: first.uuid,
    endParagraphUuid: last.uuid,
    source,
  }
}

/**
 * 항목 경계를 추정한다.
 *
 * @param paragraphs 한 버전의 문단 전체. 문서 순서여야 한다
 * @param rubricTitles 확정 지침 항목의 이름. 제목 스타일이 없을 때만 쓴다
 */
export function estimateSectionBoundaries(
  paragraphs: readonly SectionParagraph[],
  rubricTitles: readonly string[] = [],
): SectionBoundary[] {
  if (paragraphs.length === 0) return []

  const fromHeadings = headingStarts(paragraphs)
  const starts = fromHeadings.length > 0 ? fromHeadings : rubricStarts(paragraphs, rubricTitles)
  const source: SectionSource = fromHeadings.length > 0 ? 'heading' : 'rubric'

  if (starts.length === 0) {
    const whole = build(paragraphs, 0, paragraphs.length - 1, WHOLE_DOCUMENT_TITLE, 'fallback', 1)
    return whole === null ? [] : [whole]
  }

  const sections: SectionBoundary[] = []
  const first = starts[0]
  // 첫 제목 앞의 문단은 어느 항목에도 속하지 않는다. 버리지 않고 따로 묶는다.
  if (first !== undefined && first > 0) {
    const lead = build(paragraphs, 0, first - 1, LEAD_SECTION_TITLE, 'fallback', sections.length + 1)
    if (lead !== null) sections.push(lead)
  }

  starts.forEach((start, i) => {
    const nextStart = starts[i + 1] ?? paragraphs.length
    const title = paragraphs[start]?.text ?? ''
    const section = build(paragraphs, start, nextStart - 1, title, source, sections.length + 1)
    if (section !== null) sections.push(section)
  })

  return sections
}

/**
 * 사용자가 고친 경계가 지금 문단 목록 위에서 말이 되는지 본다.
 * 문제가 없으면 빈 배열. 문구는 그대로 사용자에게 보여 준다.
 */
export function sectionOverrideProblems(
  paragraphs: readonly SectionParagraph[],
  overrides: readonly SectionOverride[],
): string[] {
  if (overrides.length === 0) return ['보고서 항목을 하나 이상 남겨 주세요.']

  const positions = new Map(paragraphs.map((paragraph, position) => [paragraph.uuid, position]))
  const problems: string[] = []
  let previousEnd = -1

  overrides.forEach((override, i) => {
    const label = `${i + 1}번 항목`
    if (override.ordinal !== i + 1) problems.push(`${label}: 순번이 어긋납니다.`)
    if (normalizeText(override.title) === '') problems.push(`${label}: 이름을 적어 주세요.`)

    const start = positions.get(override.startParagraphUuid)
    const end = positions.get(override.endParagraphUuid)
    if (start === undefined || end === undefined) {
      problems.push(`${label}: 지금 문서에 없는 문단을 가리킵니다.`)
      return
    }
    if (start > end) problems.push(`${label}: 시작 문단이 끝 문단보다 뒤에 있습니다.`)
    if (start <= previousEnd) problems.push(`${label}: 앞 항목과 겹칩니다.`)
    previousEnd = end
  })

  return problems
}

/**
 * 저장된 사용자 경계를 지금 문단 목록에 맞춰 되살린다.
 * 가리키던 문단이 사라졌거나 순서가 어긋나면 **임의로 고치지 않고** null 을 돌려준다.
 * 그때는 부르는 쪽이 추정으로 되돌리고 그 사실을 사용자에게 알린다.
 */
export function resolveSectionOverrides(
  paragraphs: readonly SectionParagraph[],
  overrides: readonly SectionOverride[],
): SectionBoundary[] | null {
  if (sectionOverrideProblems(paragraphs, overrides).length > 0) return null

  const positions = new Map(paragraphs.map((paragraph, position) => [paragraph.uuid, position]))
  const sections: SectionBoundary[] = []
  for (const override of overrides) {
    const start = positions.get(override.startParagraphUuid)
    const end = positions.get(override.endParagraphUuid)
    if (start === undefined || end === undefined) return null
    const section = build(paragraphs, start, end, normalizeText(override.title), 'user', override.ordinal)
    if (section === null) return null
    sections.push(section)
  }
  return sections
}

/** 항목에 속한 문단. 경계 안의 문단을 문서 순서로 돌려준다. */
export function paragraphsOfSection<T extends SectionParagraph>(
  paragraphs: readonly T[],
  section: SectionBoundary,
): T[] {
  return paragraphs.slice(section.startIndex, section.endIndex + 1)
}
