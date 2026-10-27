/**
 * 테스트용 문단 만들기.
 *
 * 읽기(`adapters/hwpx`)를 거치지 않고 코어 알고리즘만 볼 때 쓴다.
 * 해시와 uuid 는 실제와 같은 함수로 계산해, 테스트가 우연히 통과하지 않게 한다.
 */
import { paragraphHash, paragraphUuid } from '../../src/core/document/hash.js'
import type { Paragraph } from '../../src/core/document/model.js'
import { normalizeText } from '../../src/core/document/normalize.js'

export function makeParagraph(rawText: string, index: number, sectionIndex = 0): Paragraph {
  const text = normalizeText(rawText)
  const equations: string[] = []
  return {
    uuid: paragraphUuid({ sectionIndex, index, text, equations }),
    index,
    sectionIndex,
    role: 'body',
    headingLevel: null,
    styleName: '바탕글',
    table: null,
    rawText,
    text,
    equations,
    hash: paragraphHash({ text, equations }),
  }
}

export function makeParagraphs(texts: readonly string[], sectionIndex = 0): Paragraph[] {
  return texts.map((text, index) => makeParagraph(text, index, sectionIndex))
}

/** 문단 추적에 넘길 "이전 버전" 모양으로 바꾼다. */
export function asPrevious(
  paragraphs: readonly Paragraph[],
): { uuid: string; hash: string; text: string }[] {
  return paragraphs.map((p) => ({ uuid: p.uuid, hash: p.hash, text: p.text }))
}
