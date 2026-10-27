/**
 * 5단계 — 문장 앵커 (core/document/sentence-anchor.ts).
 *
 * T-23 문장 앵커를 재해석하지 못하면 다른 문장에 자동 연결되지 않는다.
 *      (사용자 확인 요청 상태로 두는 것은 app/review-stage.ts 가 하고, 여기서는 "찾지 못했다"까지 본다)
 * T-10 같은 입력이면 코어 함수는 항상 같은 출력을 낸다.
 */
import { describe, expect, it } from 'vitest'

import {
  createSentenceAnchor,
  resolveSentenceAnchor,
  sentenceHash,
  splitSentences,
  type SentenceAnchor,
} from '../src/core/document/sentence-anchor.js'
import { normalizeText } from '../src/core/document/normalize.js'

const PARAGRAPH = '온도가 올라가면 압력이 증가했다. 그래프의 기울기는 0.5 였다. 따라서 보일 법칙이 성립한다.'

function anchorOf(text: string, index: number, uuid = 'para-1'): SentenceAnchor {
  const anchor = createSentenceAnchor({ paragraphUuid: uuid, paragraphText: text, sentenceIndex: index })
  if (anchor === null) throw new Error('앵커를 만들지 못했습니다')
  return anchor
}

describe('문장 자르기 (splitSentences)', () => {
  it('종결 부호 뒤에 공백이 오면 문장을 끊는다', () => {
    expect(splitSentences(PARAGRAPH).map((s) => s.text)).toEqual([
      '온도가 올라가면 압력이 증가했다.',
      '그래프의 기울기는 0.5 였다.',
      '따라서 보일 법칙이 성립한다.',
    ])
  })

  it('소수점은 문장 끝이 아니다', () => {
    expect(splitSentences('오차는 0.5 %였다.')).toHaveLength(1)
  })

  it('항목 번호("3.")는 문장 끝이 아니다', () => {
    expect(splitSentences('3. 결론').map((s) => s.text)).toEqual(['3. 결론'])
  })

  it('닫는 따옴표·괄호는 문장 끝에 붙여 둔다', () => {
    expect(splitSentences('"이상기체로 보았다." 그러나 오차가 있었다.').map((s) => s.text)).toEqual([
      '"이상기체로 보았다."',
      '그러나 오차가 있었다.',
    ])
  })

  it('물음표와 느낌표도 문장을 끊는다', () => {
    expect(splitSentences('왜 차이가 날까? 다시 재어 보았다!').map((s) => s.text)).toEqual([
      '왜 차이가 날까?',
      '다시 재어 보았다!',
    ])
  })

  it('종결 부호가 없어도 한 문장이다', () => {
    expect(splitSentences('측정값 표').map((s) => s.text)).toEqual(['측정값 표'])
  })

  it('빈 문단에는 문장이 없다', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })

  it('offset 은 문단 텍스트 안의 실제 위치다', () => {
    for (const sentence of splitSentences(PARAGRAPH)) {
      expect(PARAGRAPH.slice(sentence.offset, sentence.offset + sentence.text.length)).toBe(sentence.text)
    }
  })

  it('두 번 잘라도 같은 결과가 나온다', () => {
    expect(splitSentences(PARAGRAPH)).toEqual(splitSentences(PARAGRAPH))
  })
})

describe('앵커 만들기 (createSentenceAnchor)', () => {
  it('문단 uuid · 문장 번호 · 문장 · 위치 · 해시를 담는다', () => {
    expect(anchorOf(PARAGRAPH, 1)).toEqual({
      paragraphUuid: 'para-1',
      sentenceIndex: 1,
      text: '그래프의 기울기는 0.5 였다.',
      offset: PARAGRAPH.indexOf('그래프'),
      hash: sentenceHash('그래프의 기울기는 0.5 였다.'),
    })
  })

  it('그런 문장이 없으면 만들지 않는다', () => {
    expect(createSentenceAnchor({ paragraphUuid: 'para-1', paragraphText: PARAGRAPH, sentenceIndex: 9 })).toBeNull()
    expect(createSentenceAnchor({ paragraphUuid: 'para-1', paragraphText: '', sentenceIndex: 0 })).toBeNull()
  })

  it('정규화된 같은 문장이면 해시도 같다', () => {
    expect(sentenceHash('압력이  증가했다.')).toBe(sentenceHash(normalizeText('압력이 증가했다.')))
  })
})

describe('앵커 다시 찾기 (resolveSentenceAnchor)', () => {
  const anchor = anchorOf(PARAGRAPH, 2)

  it('그대로면 같은 자리에서 찾는다', () => {
    expect(resolveSentenceAnchor(anchor, { uuid: 'para-1', text: PARAGRAPH })).toEqual({
      status: 'found',
      sentenceIndex: 2,
      offset: anchor.offset,
      text: anchor.text,
      moved: false,
    })
  })

  it('앞에 문장이 늘어 위치가 밀려도 같은 문장이면 이어진다', () => {
    const edited = `실험 조건을 먼저 적는다. ${PARAGRAPH}`
    const resolved = resolveSentenceAnchor(anchor, { uuid: 'para-1', text: edited })

    expect(resolved).toMatchObject({ status: 'found', sentenceIndex: 3, moved: true })
  })

  it('그 문장을 지우면 비슷한 문장에 붙이지 않고 찾지 못했다고 한다 (T-23)', () => {
    const edited = '온도가 올라가면 압력이 증가했다. 그래프의 기울기는 0.5 였다. 따라서 이상기체 법칙이 성립한다.'

    expect(resolveSentenceAnchor(anchor, { uuid: 'para-1', text: edited })).toEqual({
      status: 'not-found',
      reason: 'sentence-missing',
    })
  })

  it('문단 자체가 사라지면 찾지 못했다고 한다 (T-23)', () => {
    expect(resolveSentenceAnchor(anchor, null)).toEqual({
      status: 'not-found',
      reason: 'paragraph-missing',
    })
    // 다른 문단에 같은 글이 있어도 그 문단으로 옮겨 붙이지 않는다.
    expect(resolveSentenceAnchor(anchor, { uuid: 'para-2', text: PARAGRAPH })).toEqual({
      status: 'not-found',
      reason: 'paragraph-missing',
    })
  })

  it('똑같은 문장이 여럿이고 원래 자리에 없으면 고르지 않는다 (T-23)', () => {
    const twice = anchorOf('첫 문장이다. 같은 문장이다.', 1)
    const edited = '같은 문장이다. 새로 쓴 문장이다. 같은 문장이다.'

    expect(resolveSentenceAnchor(twice, { uuid: 'para-1', text: edited })).toEqual({
      status: 'not-found',
      reason: 'ambiguous',
    })
  })

  it('똑같은 문장이 여럿이어도 원래 자리에 그대로 있으면 그것으로 본다', () => {
    const twice = anchorOf('같은 문장이다. 다른 문장이다. 같은 문장이다.', 0)
    const edited = '같은 문장이다. 고친 문장이다. 같은 문장이다.'

    expect(resolveSentenceAnchor(twice, { uuid: 'para-1', text: edited })).toMatchObject({
      status: 'found',
      sentenceIndex: 0,
    })
  })
})
