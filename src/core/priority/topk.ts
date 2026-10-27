/** 점수가 같은 항목도 입력 순서로 안정적으로 정렬하는 Top-K 선택. */
import { FEEDBACK_PRIORITY } from './score.js'

export interface Scored<T> {
  value: T
  score: number
}

export function rankByPriority<T>(items: readonly Scored<T>[]): Scored<T>[] {
  return items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ index: _index, ...item }) => item)
}

export function selectTopK<T>(items: readonly Scored<T>[], limit: number = FEEDBACK_PRIORITY.topK): Scored<T>[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Top-K는 0 이상의 정수여야 합니다.')
  if (limit === 0) return []
  type Entry = { item: Scored<T>; index: number }
  const heap: Entry[] = []
  // 양수면 a가 더 우선이다. 최소 힙의 루트에는 탈락 후보를 둔다.
  const compare = (a: Entry, b: Entry): number => a.item.score - b.item.score || b.index - a.index
  function sink(): void {
    let parent = 0
    for (;;) {
      const left = parent * 2 + 1
      if (left >= heap.length) return
      const right = left + 1
      const child = right < heap.length && compare(heap[right]!, heap[left]!) < 0 ? right : left
      if (compare(heap[parent]!, heap[child]!) <= 0) return
      ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
      parent = child
    }
  }
  items.forEach((item, index) => {
    const entry = { item, index }
    if (heap.length < limit) {
      heap.push(entry)
      let child = heap.length - 1
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2)
        if (compare(heap[parent]!, heap[child]!) <= 0) break
        ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
        child = parent
      }
    } else if (compare(entry, heap[0]!) > 0) {
      heap[0] = entry
      sink()
    }
  })
  return heap.sort((a, b) => -compare(a, b)).map(({ item }) => item)
}
