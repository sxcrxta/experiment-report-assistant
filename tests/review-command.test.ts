/**
 * 말로 하는 검토 요청 ([Q-44]). 대상 문단은 프로그램이 정한다 (`CLAUDE.md` §2).
 * 실제 샘플(큰 표 안에 번호 제목을 쓴 보고서)로도 확인한다.
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hwpxReader } from '../src/adapters/hwpx/index.js'
import type { ParagraphChoice, SectionBoundary } from '../src/shared/feedback.js'
import { commandWords, interpretReviewCommand } from '../src/shared/review-command.js'

function choices(texts: readonly string[], changed: readonly number[] = []): ParagraphChoice[] {
  return texts.map((text, index) => ({
    paragraphId: `p${index + 1}`, number: index + 1, text, hasContent: text.trim() !== '', role: 'body',
    table: null, sentences: [], changed: changed.includes(index + 1), equations: [],
  }))
}

const REPORT = choices([
  '1. 실험 목적', '몰질량을 구한다.',
  '2. 실험 결과', '가. 측정값', '176.70 g', '나. 계산', 'M = mRT/PV',
  '3. 고찰', '오차의 원인은 공기 보정이다.', '온도 측정이 늦었다.',
  '4. 참고문헌', '[1] 교재',
], [9])

const panel = (paragraphs: ParagraphChoice[], sections: SectionBoundary[] = []) => ({ paragraphs, sections })

describe('낱말 뽑기', () => {
  it('부탁하는 말과 조사를 떼고, 낱말 가운데는 자르지 않는다', () => {
    expect(commandWords('고찰 부분에 대해 피드백해줘')).toEqual(['고찰'])
    expect(commandWords('고찰부분에대해 피드백 좀')).toEqual(['고찰'])
    expect(commandWords('프로판 몰질량 봐줘')).toEqual(['프로판', '몰질량'])
    expect(commandWords('실험 결과와 효과')).toEqual(['실험', '결과', '효과'])
  })
})

describe('대상 정하기', () => {
  it('번호 제목을 찾아 같은 급의 다음 제목 전까지를 대상으로 한다', () => {
    const result = interpretReviewCommand('고찰 부분 피드백해줘', panel(REPORT))
    expect(result).toMatchObject({ ok: true, target: { kind: 'paragraphs', paragraphIds: ['p8', 'p9', 'p10'] },
      stage: null, depth: null })
  })

  it('큰 제목 아래 작은 제목은 큰 제목 범위에 들어간다', () => {
    const result = interpretReviewCommand('실험 결과 봐줘', panel(REPORT))
    expect(result).toMatchObject({ ok: true, target: { paragraphIds: ['p3', 'p4', 'p5', 'p6', 'p7'] } })
  })

  it('작은 제목도 찾는다', () => {
    expect(interpretReviewCommand('계산 부분', panel(REPORT)))
      .toMatchObject({ ok: true, target: { paragraphIds: ['p6', 'p7'] } })
  })

  it('전체·바뀐 문단·N번 문단을 알아듣는다', () => {
    expect(interpretReviewCommand('전체 다 봐줘', panel(REPORT))).toMatchObject({ ok: true, target: { kind: 'document' } })
    expect(interpretReviewCommand('바뀐 부분만', panel(REPORT))).toMatchObject({ ok: true, target: { paragraphIds: ['p9'] } })
    expect(interpretReviewCommand('9번 문단', panel(REPORT))).toMatchObject({ ok: true, target: { paragraphIds: ['p9'] } })
  })

  it('단계와 깊이를 말에서 읽는다', () => {
    expect(interpretReviewCommand('고찰 힌트 줘', panel(REPORT))).toMatchObject({ ok: true, stage: 'weak_hint' })
    expect(interpretReviewCommand('고찰 꼼꼼하게 설명해줘', panel(REPORT)))
      .toMatchObject({ ok: true, stage: 'explanation', depth: 'deep' })
  })

  it('예시는 여기서 열지 않는다 (카드에서 직접 요청)', () => {
    expect(interpretReviewCommand('고찰 예시 보여줘', panel(REPORT)).ok).toBe(false)
  })

  it('못 찾으면 있는 제목을 알려 주고, 똑같이 맞는 것이 둘이면 고르지 않는다', () => {
    const missing = interpretReviewCommand('서론 봐줘', panel(REPORT))
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok) expect(missing.message).toContain('3. 고찰')
    const twice = choices(['1. 결과', '가. 측정', '내용', '2. 고찰', '가. 측정', '내용'])
    expect(interpretReviewCommand('측정 봐줘', panel(twice)).ok).toBe(false)
    expect(interpretReviewCommand('고찰의 측정 봐줘', panel(twice))).toMatchObject({ ok: true, target: { paragraphIds: ['p5', 'p6'] } })
  })

  it('제목에 없는 낱말이 섞여도 가장 많이 덮는 제목으로 간다', () => {
    expect(interpretReviewCommand('고찰에서 오차 쪽 봐줘', panel(REPORT)))
      .toMatchObject({ ok: true, target: { paragraphIds: ['p8', 'p9', 'p10'] } })
  })

  it('쓴 내용이 없는 제목은 대상으로 삼지 않는다 (선행 작성 보장)', () => {
    expect(interpretReviewCommand('고찰', panel(choices(['1. 고찰', '', '2. 결론', '끝'])))).toMatchObject({ ok: false })
  })

  it('보고서 항목 이름과 맞으면 그 항목으로 고른다', () => {
    const paragraphs = choices(['고찰', '오차 원인'])
    const sections: SectionBoundary[] = [{ ordinal: 1, title: '고찰', startIndex: 0, endIndex: 1,
      startParagraphUuid: 'p1', endParagraphUuid: 'p2', source: 'heading' }]
    expect(interpretReviewCommand('고찰 피드백', panel(paragraphs, sections)))
      .toMatchObject({ ok: true, target: { kind: 'section', ordinal: 1 } })
  })
})

describe('실제 샘플 보고서', () => {
  const doc = hwpxReader.read(join(import.meta.dirname, 'fixtures', 'sample-full.hwpx'))
  const real = choices(doc.paragraphs.map((p) => p.text))

  it('제목 스타일이 없어도 번호 제목으로 실험 결과를 찾는다', () => {
    const result = interpretReviewCommand('실험 결과 부분 피드백해줘', panel(real))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.label).toMatch(/^7\. 실험 결과/)
      const ids = result.target.kind === 'paragraphs' ? result.target.paragraphIds : []
      const texts = ids.map((id) => real.find((p) => p.paragraphId === id)!.text)
      expect(texts[0]).toBe('7. 실험 결과')
      // 다음 1급 제목은 들어가지 않는다.
      expect(texts.slice(1).some((t) => /^\d+\.\s/.test(t.trim()))).toBe(false)
    }
  })

  it('같은 이름의 작은 제목이 여러 곳에 있으면 고르지 않고 알리고, 윗제목을 붙이면 고른다', () => {
    const vague = interpretReviewCommand('이산화탄소의 몰질량 측정 실험', panel(real))
    expect(vague.ok).toBe(false)
    if (!vague.ok) expect(vague.message).toContain('7. 실험 결과 > 가. 이산화탄소의 몰질량 측정 실험')
    const exact = interpretReviewCommand('실험 결과의 이산화탄소 몰질량 측정 실험', panel(real))
    expect(exact).toMatchObject({ ok: true })
    if (exact.ok) expect(exact.label).toMatch(/^가\. 이산화탄소/)
  })

  it('날짜·측정값("24.5 ℃")을 제목으로 잘못 보지 않는다', () => {
    const headings = real.filter((p) => /^\d{1,2}\.\s+[가-힣A-Za-z]/.test(p.text.trim()) && p.text.trim().length <= 40)
      .map((p) => p.text.trim())
    expect(headings).toEqual(['1. 실험 목적', '2. 이론적 배경', '3. 실험 기구 및 시약', '4. 실험 방법',
      '5. 안전 유의사항 및 시약 폐기법', '6. MSDS', '7. 실험 결과', '8. 오차 정량 분석 및 고찰', '9. 결론', '10. 참고문헌'])
  })

  it('"고찰 부분 피드백해줘" 는 8번 제목부터 9번 제목 전까지다', () => {
    const result = interpretReviewCommand('고찰 부분 피드백해줘', panel(real))
    expect(result.ok).toBe(true)
    if (!result.ok || result.target.kind !== 'paragraphs') return
    const texts = result.target.paragraphIds.map((id) => real.find((p) => p.paragraphId === id)!.text.trim())
    expect(texts[0]).toBe('8. 오차 정량 분석 및 고찰')
    expect(texts).not.toContain('9. 결론')
    expect(texts.length).toBeGreaterThan(3)
  })
})
