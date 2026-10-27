/**
 * Myers Diff 단위 테스트 (T-10 결정론).
 *
 * 편집 스크립트가 최소인지, 같은 입력에 같은 출력이 나오는지, 그리고 스크립트를 그대로
 * 적용하면 새 열이 복원되는지(성질 기반)를 본다.
 */
import { describe, expect, it } from 'vitest'

import { myersDiff, type EditOp } from '../src/core/diff/myers.js'

/** 편집 스크립트를 적용해 새 열을 다시 만든다. 이게 틀리면 Diff 가 틀린 것이다. */
function applyOps(oldSeq: readonly string[], newSeq: readonly string[], ops: readonly EditOp[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    if (op.kind === 'equal') out.push(oldSeq[op.oldIndex] as string)
    else if (op.kind === 'insert') out.push(newSeq[op.newIndex] as string)
  }
  return out
}

function counts(ops: readonly EditOp[]): { equal: number; insert: number; delete: number } {
  return {
    equal: ops.filter((op) => op.kind === 'equal').length,
    insert: ops.filter((op) => op.kind === 'insert').length,
    delete: ops.filter((op) => op.kind === 'delete').length,
  }
}

describe('Myers Diff', () => {
  it('빈 입력', () => {
    expect(myersDiff([], [])).toEqual([])
  })

  it('한쪽이 비면 전부 추가·삭제다', () => {
    expect(counts(myersDiff([], ['a', 'b']))).toEqual({ equal: 0, insert: 2, delete: 0 })
    expect(counts(myersDiff(['a', 'b'], []))).toEqual({ equal: 0, insert: 0, delete: 2 })
  })

  it('같으면 전부 equal 이다', () => {
    const ops = myersDiff(['a', 'b', 'c'], ['a', 'b', 'c'])
    expect(counts(ops)).toEqual({ equal: 3, insert: 0, delete: 0 })
  })

  it('가운데 한 줄만 바뀌면 삭제 1 + 삽입 1 이다', () => {
    const ops = myersDiff(['a', 'b', 'c'], ['a', 'B', 'c'])
    expect(counts(ops)).toEqual({ equal: 2, insert: 1, delete: 1 })
  })

  it('가운데 한 줄이 끼어들면 삽입 1 뿐이다', () => {
    const ops = myersDiff(['a', 'c'], ['a', 'b', 'c'])
    expect(counts(ops)).toEqual({ equal: 2, insert: 1, delete: 0 })
    expect(ops.filter((op) => op.kind === 'insert')).toEqual([{ kind: 'insert', newIndex: 1 }])
  })

  it('고전적인 예제에서 최소 편집 거리를 낸다', () => {
    // Myers 논문의 예: ABCABBA -> CBABAC (편집 거리 5)
    const ops = myersDiff([...'ABCABBA'], [...'CBABAC'])
    const { insert, delete: removed } = counts(ops)
    expect(insert + removed).toBe(5)
  })

  it('편집 스크립트를 적용하면 새 열이 그대로 복원된다', () => {
    const cases: [string[], string[]][] = [
      [[...'실험목적재료방법'], [...'실험목적준비물방법결과']],
      [['a', 'b', 'c', 'd'], ['b', 'c', 'e']],
      [['x'], ['x', 'x', 'x']],
      [['x', 'x', 'x'], ['x']],
      [[], ['a']],
    ]
    for (const [oldSeq, newSeq] of cases) {
      const ops = myersDiff(oldSeq, newSeq)
      expect(applyOps(oldSeq, newSeq, ops)).toEqual(newSeq)
    }
  })

  it('삭제·삽입 인덱스가 각각 순서대로 한 번씩만 나온다', () => {
    const oldSeq = [...'ABCABBA']
    const newSeq = [...'CBABAC']
    const ops = myersDiff(oldSeq, newSeq)

    const oldIndexes = ops.flatMap((op) => (op.kind === 'insert' ? [] : [op.oldIndex]))
    const newIndexes = ops.flatMap((op) => (op.kind === 'delete' ? [] : [op.newIndex]))

    expect(oldIndexes).toEqual(oldSeq.map((_, i) => i))
    expect(newIndexes).toEqual(newSeq.map((_, i) => i))
  })

  it('같은 입력에는 항상 같은 출력이 나온다 (T-10)', () => {
    const oldSeq = ['h1', 'h2', 'h3', 'h4']
    const newSeq = ['h1', 'h9', 'h3', 'h4', 'h5']
    expect(myersDiff(oldSeq, newSeq)).toEqual(myersDiff(oldSeq, newSeq))
  })
})
