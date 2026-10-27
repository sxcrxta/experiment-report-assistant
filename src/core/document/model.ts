/**
 * 문서 모델.
 *
 * `IMPLEMENTATION_PLAN.md` §1.8 의 Paragraph 에 대응한다.
 * 버전 사이의 문단 추적(분할·병합)은 2단계에서 다룬다.
 */

/** 문단이 문서에서 맡는 역할. header.xml 의 스타일 이름으로 판정한다. */
export type ParagraphRole = 'heading' | 'body' | 'caption' | 'other'

/** 표 안 문단의 위치. */
export interface TablePosition {
  /** 문서 안에서 몇 번째 표인가 (0부터) */
  tableIndex: number
  row: number
  col: number
}

export interface Paragraph {
  /** 같은 파일을 다시 읽어도 같은 값이 나온다 (내용과 위치에서 유도) */
  uuid: string
  /** 문서 전체에서의 순서 (0부터) */
  index: number
  /** 몇 번째 섹션에서 나왔는가 */
  sectionIndex: number
  role: ParagraphRole
  /** 개요 1~10 이면 1~10, 아니면 null */
  headingLevel: number | null
  /** header.xml 의 스타일 이름 (예: 바탕글, 개요 1, 캡션) */
  styleName: string | null
  /** 표 안이면 위치, 본문이면 null */
  table: TablePosition | null
  /** 정규화 전 원문 */
  rawText: string
  /** 정규화된 텍스트. 비교와 표시의 기준 */
  text: string
  /** 문단에 들어 있는 수식의 스크립트. text 에는 넣지 않지만 해시에는 반영한다 */
  equations: string[]
  /** 정규화된 텍스트와 수식으로 계산한 해시 */
  hash: string
}

export interface HwpxDocument {
  paragraphs: Paragraph[]
  /** 읽은 섹션 수 */
  sectionCount: number
}

/** 문단에 실제 내용이 있는가. 선행 작성 확인(PRD 4.2)의 기준이 된다. */
export function hasContent(paragraph: Paragraph): boolean {
  return paragraph.text.length > 0 || paragraph.equations.length > 0
}

/** 스타일 이름에서 역할과 개요 수준을 판정한다. */
export function roleFromStyleName(styleName: string | null): {
  role: ParagraphRole
  headingLevel: number | null
} {
  if (styleName === null) return { role: 'other', headingLevel: null }

  const outline = /^개요\s*(\d+)$/.exec(styleName) ?? /^Outline\s*(\d+)$/.exec(styleName)
  if (outline !== null) {
    return { role: 'heading', headingLevel: Number(outline[1]) }
  }
  if (styleName === '차례 제목' || styleName === '타이들' || styleName === 'TOC Heading') {
    return { role: 'heading', headingLevel: null }
  }
  if (styleName === '캡션' || styleName === 'Caption') {
    return { role: 'caption', headingLevel: null }
  }
  if (styleName === '바탕글' || styleName === '본문' || styleName === 'Normal' || styleName === 'Body') {
    return { role: 'body', headingLevel: null }
  }
  return { role: 'other', headingLevel: null }
}
