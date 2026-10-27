/**
 * Myers Diff.
 *
 * PRD 4.5: "해시가 달라진 구간에서 추가·삭제·수정된 문단만 추출하여 버전과 연결하고,
 * 해당 부분과 필요한 앞뒤 문맥만 AI에 전달한다."
 * CLAUDE.md §2: Diff 는 AI 에 위임하지 않는다. 여기는 부작용 없는 순수 함수만 둔다.
 *
 * 비교 단위는 문단이고, 비교 값은 문단 해시다. 텍스트 전체를 비교하지 않는 이유는
 * 해시 하나로 "같은 문단인가"가 끝나기 때문이다 (PRD 4.5 해싱·메모이제이션).
 *
 * 알고리즘은 Myers(1986) 의 그리디 방식이다. 라운드마다 V 배열을 복사해 두었다가
 * 끝점에서 거꾸로 따라가며 편집 스크립트를 만든다. 문단 수가 N 일 때 메모리는 O(D·N)
 * 이며, 실험보고서 한 편(문단 수백)에서는 문제가 되지 않는다.
 */

export type EditOp =
  /** 두 버전에 그대로 있는 문단 */
  | { readonly kind: 'equal'; readonly oldIndex: number; readonly newIndex: number }
  /** 이전 버전에만 있던 문단 */
  | { readonly kind: 'delete'; readonly oldIndex: number }
  /** 새 버전에만 있는 문단 */
  | { readonly kind: 'insert'; readonly newIndex: number }

/** 배열 밖을 읽는 실수를 조용히 넘기지 않는다. */
function at(values: readonly number[], index: number): number {
  const value = values[index]
  if (value === undefined) {
    throw new Error(`Myers Diff 내부 오류: V 배열 범위를 벗어났습니다 (index=${index})`)
  }
  return value
}

/**
 * 두 해시 열의 최소 편집 스크립트를 문서 순서대로 돌려준다.
 *
 * 같은 입력에는 항상 같은 출력이 나온다 (T-10).
 */
export function myersDiff(oldHashes: readonly string[], newHashes: readonly string[]): EditOp[] {
  const n = oldHashes.length
  const m = newHashes.length

  if (n === 0 && m === 0) return []
  if (n === 0) return newHashes.map((_, newIndex) => ({ kind: 'insert', newIndex }) as const)
  if (m === 0) return oldHashes.map((_, oldIndex) => ({ kind: 'delete', oldIndex }) as const)

  const max = n + m
  const offset = max
  const v: number[] = new Array<number>(2 * max + 2).fill(0)
  /** 라운드 d 를 시작하기 직전의 V. 되짚어 갈 때 쓴다. */
  const trace: number[][] = []

  for (let d = 0; d <= max; d += 1) {
    trace.push([...v])

    for (let k = -d; k <= d; k += 2) {
      const moveDown = k === -d || (k !== d && at(v, k - 1 + offset) < at(v, k + 1 + offset))
      let x = moveDown ? at(v, k + 1 + offset) : at(v, k - 1 + offset) + 1
      let y = x - k

      while (x < n && y < m && oldHashes[x] === newHashes[y]) {
        x += 1
        y += 1
      }

      v[k + offset] = x

      if (x >= n && y >= m) return backtrack(trace, offset, n, m)
    }
  }

  // (n + m) 번이면 반드시 끝점에 닿는다. 여기에 오면 위 계산이 깨진 것이다.
  throw new Error('Myers Diff 내부 오류: 편집 경로를 찾지 못했습니다')
}

function backtrack(trace: readonly number[][], offset: number, n: number, m: number): EditOp[] {
  const reversed: EditOp[] = []
  let x = n
  let y = m

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]
    if (v === undefined) throw new Error('Myers Diff 내부 오류: 라운드 기록이 없습니다')

    if (d === 0) {
      // 편집이 하나도 남지 않았다. 남은 구간은 전부 같은 문단이다.
      while (x > 0 && y > 0) {
        x -= 1
        y -= 1
        reversed.push({ kind: 'equal', oldIndex: x, newIndex: y })
      }
      break
    }

    const k = x - y
    const moveDown = k === -d || (k !== d && at(v, k - 1 + offset) < at(v, k + 1 + offset))
    const previousK = moveDown ? k + 1 : k - 1
    const previousX = at(v, previousK + offset)
    const previousY = previousX - previousK

    while (x > previousX && y > previousY) {
      x -= 1
      y -= 1
      reversed.push({ kind: 'equal', oldIndex: x, newIndex: y })
    }

    if (moveDown) {
      y -= 1
      reversed.push({ kind: 'insert', newIndex: y })
    } else {
      x -= 1
      reversed.push({ kind: 'delete', oldIndex: x })
    }
  }

  return reversed.reverse()
}
