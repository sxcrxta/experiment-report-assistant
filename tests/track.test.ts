/**
 * 문단 추적 단위 테스트.
 *
 * T-22: 문단 분할·병합 시 새 UUID 가 부여되고 기존 UUID 와의 관계가 기록된다.
 * PRD 4.5: 해시가 같은 문단은 분석 대상에서 빠진다 (메모이제이션의 1단계).
 */
import { describe, expect, it } from 'vitest'

import {
  SPLIT_MERGE_SIMILARITY,
  textSimilarity,
  trackParagraphs,
} from '../src/core/diff/track.js'

import { asPrevious, makeParagraphs } from './helpers/paragraphs.js'

const VERSION = 'v2'

describe('문단 추적 — 바뀌지 않은 문단', () => {
  it('해시가 같으면 uuid 를 물려받고 분석 대상에서 빠진다', () => {
    const before = makeParagraphs(['실험 목적', '실험 방법', '실험 결과'])
    const after = makeParagraphs(['실험 목적', '실험 방법', '실험 결과'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.changed).toEqual([])
    expect(result.unchangedCount).toBe(3)
    expect(result.paragraphs.map((p) => p.uuid)).toEqual(before.map((p) => p.uuid))
    expect(result.paragraphs.every((p) => p.change === 'unchanged')).toBe(true)
  })

  it('문단 하나만 고치면 그 문단만 분석 대상이 된다', () => {
    const before = makeParagraphs(['실험 목적', '실험 방법', '실험 결과'])
    const after = makeParagraphs(['실험 목적', '실험 방법을 자세히 적었다', '실험 결과'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.change).toBe('modified')
    expect(result.changed[0]?.paragraph.index).toBe(1)
    expect(result.unchangedCount).toBe(2)
    // 수정은 uuid 를 끊지 않는다. 붙어 있던 피드백이 살아남아야 한다.
    expect(result.changed[0]?.uuid).toBe(before[1]?.uuid)
    expect(result.changed[0]?.previousUuid).toBe(before[1]?.uuid)
    expect(result.lineage).toEqual([])
  })

  it('문단이 앞에 끼어들어 순서가 밀려도 뒤 문단은 그대로다', () => {
    const before = makeParagraphs(['실험 목적', '실험 방법'])
    const after = makeParagraphs(['제목', '실험 목적', '실험 방법'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.changed).toHaveLength(1)
    expect(result.changed[0]?.change).toBe('added')
    expect(result.paragraphs[1]?.uuid).toBe(before[0]?.uuid)
    expect(result.paragraphs[2]?.uuid).toBe(before[1]?.uuid)
    expect(result.unchangedCount).toBe(2)
  })
})

describe('문단 추적 — 추가와 삭제', () => {
  it('새 문단은 추가로 잡히고 새 uuid 를 받는다', () => {
    const before = makeParagraphs(['실험 목적'])
    const after = makeParagraphs(['실험 목적', '실험 방법'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.changed.map((c) => c.change)).toEqual(['added'])
    expect(result.changed[0]?.previousUuid).toBeNull()
    expect(result.removed).toEqual([])
  })

  it('지워진 문단은 removed 로 나온다', () => {
    const before = makeParagraphs(['실험 목적', '군더더기 문장', '실험 방법'])
    const after = makeParagraphs(['실험 목적', '실험 방법'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.removed).toEqual([{ uuid: before[1]?.uuid, text: '군더더기 문장' }])
    expect(result.changed).toEqual([])
    expect(result.unchangedCount).toBe(2)
  })
})

describe('문단 추적 — 분할과 병합 (T-22)', () => {
  it('한 문단이 둘로 나뉘면 새 uuid 와 계보가 생긴다', () => {
    const before = makeParagraphs(['비커에 물을 넣었다. 그리고 소금을 넣었다.'])
    const after = makeParagraphs(['비커에 물을 넣었다.', '그리고 소금을 넣었다.'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    const parent = before[0]?.uuid as string
    expect(result.changed.map((c) => c.change)).toEqual(['split', 'split'])
    // 새 uuid 다. 이전 uuid 를 재사용하지 않는다.
    expect(result.changed.every((c) => c.uuid !== parent)).toBe(true)
    expect(new Set(result.changed.map((c) => c.uuid)).size).toBe(2)
    expect(result.lineage).toEqual([
      { childUuid: result.paragraphs[0]?.uuid, parentUuid: parent, relation: 'split' },
      { childUuid: result.paragraphs[1]?.uuid, parentUuid: parent, relation: 'split' },
    ])
  })

  it('두 문단이 하나로 합쳐지면 새 uuid 와 계보가 생긴다', () => {
    const before = makeParagraphs(['비커에 물을 넣었다.', '그리고 소금을 넣었다.'])
    const after = makeParagraphs(['비커에 물을 넣었다. 그리고 소금을 넣었다.'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    const child = result.paragraphs[0]?.uuid as string
    expect(result.changed.map((c) => c.change)).toEqual(['merged'])
    expect(before.map((p) => p.uuid)).not.toContain(child)
    expect(result.lineage).toEqual([
      { childUuid: child, parentUuid: before[0]?.uuid, relation: 'merge' },
      { childUuid: child, parentUuid: before[1]?.uuid, relation: 'merge' },
    ])
  })

  it('서로 무관한 문단이 들어오고 나간 경우는 분할로 보지 않는다', () => {
    const before = makeParagraphs(['가설을 세웠다.'])
    const after = makeParagraphs(['온도를 기록했다.', '질량을 측정했다.'])

    const result = trackParagraphs({
      previous: asPrevious(before),
      current: after,
      versionKey: VERSION,
    })

    expect(result.lineage).toEqual([])
    expect(result.changed.map((c) => c.change)).toEqual(['modified', 'added'])
  })

  it('같은 내용이 지워졌다가 같은 자리에 되살아나도 uuid 가 겹치지 않는다', () => {
    const before = makeParagraphs(['앞 문단', '되살아날 문단'])
    const withoutIt = makeParagraphs(['앞 문단'])
    const again = makeParagraphs(['앞 문단', '되살아날 문단'])

    const deleted = trackParagraphs({
      previous: asPrevious(before),
      current: withoutIt,
      versionKey: 'v2',
    })
    expect(deleted.removed).toHaveLength(1)

    const revived = trackParagraphs({
      previous: asPrevious(withoutIt),
      current: again,
      versionKey: 'v3',
    })
    expect(revived.changed[0]?.uuid).not.toBe(before[1]?.uuid)
  })
})

describe('유사도', () => {
  it('같으면 1, 겹치지 않으면 낮다', () => {
    expect(textSimilarity('가나다', '가나다')).toBe(1)
    expect(textSimilarity('가나다', ' 가 나 다 ')).toBe(1)
    expect(textSimilarity('가나다', '')).toBe(0)
    expect(textSimilarity('가나다라마', '바사아자차')).toBeLessThan(SPLIT_MERGE_SIMILARITY)
  })

  it('가운데만 조금 달라진 문장은 임계값을 넘는다', () => {
    expect(textSimilarity('실험을 진행하여 결과를 기록했다', '실험을 수행하여 결과를 기록했다'))
      .toBeGreaterThanOrEqual(SPLIT_MERGE_SIMILARITY)
  })

  it('가중치 상수는 한 곳에서만 정의된다', () => {
    expect(SPLIT_MERGE_SIMILARITY).toBe(0.8)
  })
})
