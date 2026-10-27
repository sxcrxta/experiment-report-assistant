/**
 * 5단계 — 보고서 항목 경계 추정 (core/rubric/section-boundary.ts).
 *
 * PRD 4.2: "보고서 항목의 경계는 제목 스타일과 지침 항목으로 추정하고 사용자가 수정한다."
 *
 * T-10 같은 입력이면 코어 함수는 항상 같은 출력을 낸다.
 * 추정은 추정일 뿐이므로, 사용자가 고친 경계가 있으면 그것이 이긴다.
 * 고친 경계가 가리키던 문단이 사라지면 **임의로 맞추지 않고** 쓸 수 없다고 답한다.
 */
import { describe, expect, it } from 'vitest'

import type { Paragraph } from '../src/core/document/model.js'
import {
  estimateSectionBoundaries,
  LEAD_SECTION_TITLE,
  paragraphsOfSection,
  resolveSectionOverrides,
  sectionOverrideProblems,
  WHOLE_DOCUMENT_TITLE,
  type SectionOverride,
} from '../src/core/rubric/section-boundary.js'

import { makeParagraphs } from './helpers/paragraphs.js'

/** 개요 수준이 있는 제목 문단으로 바꾼다. */
function asHeading(paragraph: Paragraph, level: number | null): Paragraph {
  return { ...paragraph, role: 'heading', headingLevel: level, styleName: level === null ? '타이들' : `개요 ${level}` }
}

const TEXTS = [
  '기체의 분자량 측정',
  '1. 실험 목적',
  '기체의 분자량을 구한다.',
  '2. 실험 방법',
  '주사기에 공기를 넣었다.',
  '2.1 준비물',
  '주사기, 온도계',
  '3. 결론',
  '보일 법칙이 성립한다.',
]

/** 0 표지 · 1·3·7 개요 1 · 5 개요 2 · 나머지 본문 */
function document(): Paragraph[] {
  const paragraphs = makeParagraphs(TEXTS)
  const heading = (at: number, level: number | null): void => {
    const paragraph = paragraphs[at]
    if (paragraph === undefined) throw new Error('문단이 없습니다')
    paragraphs[at] = asHeading(paragraph, level)
  }
  heading(1, 1)
  heading(3, 1)
  heading(5, 2)
  heading(7, 1)
  return paragraphs
}

function summarize(paragraphs: readonly Paragraph[], rubricTitles: string[] = []): string[] {
  return estimateSectionBoundaries(paragraphs, rubricTitles).map(
    (section) => `${section.ordinal}:${section.title}:${section.startIndex}-${section.endIndex}:${section.source}`,
  )
}

describe('제목 스타일로 추정', () => {
  it('가장 얕은 개요 수준만 항목 경계가 된다', () => {
    expect(summarize(document())).toEqual([
      `1:${LEAD_SECTION_TITLE}:0-0:fallback`,
      '2:1. 실험 목적:1-2:heading',
      // 개요 2(2.1 준비물)는 항목을 새로 열지 않고 '2. 실험 방법' 안에 남는다.
      '3:2. 실험 방법:3-6:heading',
      '4:3. 결론:7-8:heading',
    ])
  })

  it('첫 제목 앞의 문단은 버리지 않고 앞부분으로 묶는다', () => {
    const lead = estimateSectionBoundaries(document())[0]
    if (lead === undefined) throw new Error('항목이 없습니다')

    expect(paragraphsOfSection(document(), lead).map((p) => p.text)).toEqual(['기체의 분자량 측정'])
  })

  it('제목이 맨 앞이면 앞부분 항목을 만들지 않는다', () => {
    const paragraphs = makeParagraphs(['1. 실험 목적', '기체의 분자량을 구한다.'])
    const first = paragraphs[0]
    if (first === undefined) throw new Error('문단이 없습니다')
    paragraphs[0] = asHeading(first, 1)

    expect(summarize(paragraphs)).toEqual(['1:1. 실험 목적:0-1:heading'])
  })

  it('개요 수준이 없는 제목만 있으면 그 제목들을 경계로 쓴다', () => {
    const paragraphs = makeParagraphs(['서론', '배경을 적는다.', '결론', '정리한다.'])
    for (const at of [0, 2]) {
      const paragraph = paragraphs[at]
      if (paragraph === undefined) throw new Error('문단이 없습니다')
      paragraphs[at] = asHeading(paragraph, null)
    }

    expect(summarize(paragraphs)).toEqual(['1:서론:0-1:heading', '2:결론:2-3:heading'])
  })

  it('두 번 추정해도 같은 결과가 나온다 (T-10)', () => {
    expect(estimateSectionBoundaries(document())).toEqual(estimateSectionBoundaries(document()))
  })
})

describe('지침 항목 이름으로 추정', () => {
  const plain = (): Paragraph[] =>
    makeParagraphs(['1. 실험 목적', '기체의 분자량을 구한다.', '2. 결론', '보일 법칙이 성립한다.'])

  it('제목 스타일이 없으면 지침 이름과 같은 문단을 시작으로 본다', () => {
    expect(summarize(plain(), ['실험 목적', '결론'])).toEqual([
      '1:1. 실험 목적:0-1:rubric',
      '2:2. 결론:2-3:rubric',
    ])
  })

  it('본문이 지침 이름을 품고 있어도 항목 시작으로 보지 않는다', () => {
    const paragraphs = makeParagraphs(['결론을 먼저 적어 두었다.', '보일 법칙이 성립한다.'])

    expect(summarize(paragraphs, ['결론'])).toEqual([`1:${WHOLE_DOCUMENT_TITLE}:0-1:fallback`])
  })

  it('근거가 아무것도 없으면 문서 전체가 한 항목이다', () => {
    expect(summarize(plain())).toEqual([`1:${WHOLE_DOCUMENT_TITLE}:0-3:fallback`])
  })

  it('문단이 없으면 항목도 없다', () => {
    expect(estimateSectionBoundaries([])).toEqual([])
  })
})

describe('사용자가 고친 경계', () => {
  const paragraphs = (): Paragraph[] => makeParagraphs(['가', '나', '다', '라'])

  function override(ordinal: number, title: string, start: number, end: number): SectionOverride {
    const list = paragraphs()
    const from = list[start]
    const to = list[end]
    if (from === undefined || to === undefined) throw new Error('문단이 없습니다')
    return { ordinal, title, startParagraphUuid: from.uuid, endParagraphUuid: to.uuid }
  }

  it('고친 경계를 지금 문단 위에서 되살린다', () => {
    const resolved = resolveSectionOverrides(paragraphs(), [
      override(1, '앞부분', 0, 1),
      override(2, '뒷부분', 2, 3),
    ])

    expect(resolved?.map((s) => `${s.title}:${s.startIndex}-${s.endIndex}:${s.source}`)).toEqual([
      '앞부분:0-1:user',
      '뒷부분:2-3:user',
    ])
  })

  it('가리키던 문단이 사라지면 다른 문단에 맞추지 않고 쓸 수 없다고 한다', () => {
    const stale: SectionOverride = {
      ordinal: 1,
      title: '앞부분',
      startParagraphUuid: '사라진-문단',
      endParagraphUuid: '사라진-문단',
    }

    expect(resolveSectionOverrides(paragraphs(), [stale])).toBeNull()
    expect(sectionOverrideProblems(paragraphs(), [stale])).toEqual([
      '1번 항목: 지금 문서에 없는 문단을 가리킵니다.',
    ])
  })

  it('항목이 겹치거나 순서가 뒤집히면 받지 않는다', () => {
    expect(sectionOverrideProblems(paragraphs(), [override(1, '가', 0, 2), override(2, '나', 1, 3)])).toContain(
      '2번 항목: 앞 항목과 겹칩니다.',
    )
    expect(sectionOverrideProblems(paragraphs(), [override(1, '가', 3, 0)])).toContain(
      '1번 항목: 시작 문단이 끝 문단보다 뒤에 있습니다.',
    )
  })

  it('이름이 비었거나 항목이 하나도 없으면 받지 않는다', () => {
    expect(sectionOverrideProblems(paragraphs(), [override(1, '  ', 0, 1)])).toContain(
      '1번 항목: 이름을 적어 주세요.',
    )
    expect(sectionOverrideProblems(paragraphs(), [])).toEqual(['보고서 항목을 하나 이상 남겨 주세요.'])
  })
})
