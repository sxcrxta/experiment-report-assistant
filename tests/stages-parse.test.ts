import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  extractSection,
  nextPendingStage,
  parseStages,
  parseStatusTable,
  withUpdatedStatus,
} from '../tools/stages/parse-stages.mts'

const REAL = readFileSync(join(import.meta.dirname, '..', 'STAGE_TASKS.md'), 'utf8')

describe('STAGE_TASKS.md 파싱 — 실제 문서', () => {
  it('0~9단계를 모두 읽는다', () => {
    const stages = parseStages(REAL)
    expect(stages.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  // 실제 문서의 상태 표는 단계가 끝날 때마다 자동화가 고친다. 특정 시점의 상태를 적어 두면
  // 단계 하나가 끝날 때마다 이 테스트가 깨지므로, 진행과 무관하게 성립하는 것만 확인한다.
  // 상태 표는 단계가 끝날 때마다 자동화가 고친다. 특정 시점의 상태를 적어 두면
  // 단계 하나가 끝날 때마다 이 테스트가 깨진다. 진행과 무관하게 성립하는 것만 확인한다.
  it('본문에서 읽은 상태가 상태 표와 일치한다', () => {
    const stages = parseStages(REAL)
    const table = parseStatusTable(REAL)
    expect(stages.length).toBeGreaterThan(0)
    for (const stage of stages) {
      expect(stage.status).toBe(table.get(stage.number)?.status)
    }
  })

  it('0단계는 언제나 완료 상태다 (이미 끝난 단계는 되돌아가지 않는다)', () => {
    expect(parseStages(REAL).find((s) => s.number === 0)?.status).toBe('done')
  })

  it('다음 미완료 단계는 대기 중인 것 중 가장 앞선 번호다', () => {
    const stages = parseStages(REAL)
    const pending = stages.filter((s) => s.status === 'pending').map((s) => s.number)
    const next = nextPendingStage(stages)

    if (pending.length === 0) {
      expect(next).toBeNull()
      return
    }
    expect(next?.number).toBe(Math.min(...pending))
    // 그 앞 단계는 완료했거나 이번 개발 범위에서 보류한 단계여야 한다. 보류는 자동 실행이 건너뛴다.
    expect(
      stages
        .filter((s) => s.number < (next as { number: number }).number)
        .every((s) => s.status === 'done' || s.status === 'deferred'),
    ).toBe(true)
  })

  it('각 단계의 절을 뽑는다', () => {
    const stage2 = parseStages(REAL).find((s) => s.number === 2)
    expect(stage2?.tasks).toContain('Myers Diff')
    expect(stage2?.completion).toContain('변경 문단만')
    expect(stage2?.outOfScope).toContain('AI 호출')
  })
})

describe('STAGE_TASKS.md 파싱 — 합성 입력', () => {
  const sample = [
    '| 단계 | 이름 | 상태 |',
    '| --- | --- | --- |',
    '| 0 | 뼈대 | **완료** (abc1234) |',
    '| 1 | 읽기 | 대기 |',
    '',
    '## 0단계 — 뼈대 ✅ 완료',
    '내용 0',
    '',
    '## 1단계 — 읽기',
    '',
    '**선행 조건**',
    '- [ ] 샘플이 필요하다',
    '',
    '**작업**',
    '- [ ] 파서를 만든다',
    '',
    '**완료 조건**',
    '- [ ] 파서가 동작한다',
    '',
  ].join('\n')

  it('상태 표를 읽는다', () => {
    const table = parseStatusTable(sample)
    expect(table.get(0)).toEqual({ title: '뼈대', status: 'done' })
    expect(table.get(1)).toEqual({ title: '읽기', status: 'pending' })
  })

  it('절을 정확히 잘라 낸다', () => {
    const stage = parseStages(sample).find((s) => s.number === 1)
    expect(stage?.prerequisites).toBe('- [ ] 샘플이 필요하다')
    expect(stage?.tasks).toBe('- [ ] 파서를 만든다')
    expect(stage?.completion).toBe('- [ ] 파서가 동작한다')
  })

  it('단계가 아닌 절은 앞 단계 본문에 섞이지 않는다', () => {
    const withExtra = [
      '| 단계 | 이름 | 상태 |',
      '| --- | --- | --- |',
      '| 1 | 하나 | 대기 |',
      '| 2 | 둘 | 대기 |',
      '',
      '## 1단계 — 하나',
      '**작업**',
      '- [ ] 하나의 일',
      '',
      '## 곁다리 절 — 단계가 아님',
      '여기 내용은 어느 단계에도 속하지 않는다',
      '',
      '## 2단계 — 둘',
      '**작업**',
      '- [ ] 둘의 일',
      '',
    ].join('\n')

    const stages = parseStages(withExtra)
    expect(stages.map((s) => s.number)).toEqual([1, 2])
    expect(stages[0]?.body).toContain('하나의 일')
    expect(stages[0]?.body).not.toContain('곁다리')
    expect(stages[0]?.body).not.toContain('어느 단계에도 속하지 않는다')
    expect(stages[1]?.body).toContain('둘의 일')
  })

  it('없는 절은 빈 문자열이다', () => {
    expect(extractSection('아무것도 없음', '작업')).toBe('')
  })

  it('보류 단계는 다음 실행 대상에서 건너뛴다', () => {
    const withDeferred = [
      '| 단계 | 이름 | 상태 |',
      '| --- | --- | --- |',
      '| 1 | 하나 | **완료** |',
      '| 2 | 둘 | **보류** — 이번 개발 범위 밖 |',
      '| 3 | 셋 | 대기 |',
      '',
      '## 1단계 — 하나',
      '내용',
      '',
      '## 2단계 — 둘',
      '내용',
      '',
      '## 3단계 — 셋',
      '내용',
      '',
    ].join('\n')

    const stages = parseStages(withDeferred)
    expect(stages.map((s) => s.status)).toEqual(['done', 'deferred', 'pending'])
    // 2단계를 건너뛰고 3단계를 고른다
    expect(nextPendingStage(stages)?.number).toBe(3)
  })

  it('대기 단계가 하나도 없으면 null 이다 (보류만 남아도 마찬가지)', () => {
    const allDone = [
      '| 단계 | 이름 | 상태 |',
      '| --- | --- | --- |',
      '| 1 | 하나 | **완료** |',
      '| 2 | 둘 | **보류** |',
      '',
      '## 1단계 — 하나',
      '',
      '## 2단계 — 둘',
      '',
    ].join('\n')
    expect(nextPendingStage(parseStages(allDone))).toBeNull()
  })

  it('상태 칸만 바꾸고 나머지는 그대로 둔다', () => {
    const updated = withUpdatedStatus(sample, 1, '**완료** (테스트)')
    expect(updated).toContain('| 1 | 읽기 | **완료** (테스트) |')
    expect(updated).toContain('| 0 | 뼈대 | **완료** (abc1234) |')
    expect(updated).toContain('- [ ] 파서를 만든다')
  })

  it('없는 단계의 상태를 바꾸려 하면 거절한다', () => {
    expect(() => withUpdatedStatus(sample, 7, '완료')).toThrow('찾지 못했습니다')
  })
})
