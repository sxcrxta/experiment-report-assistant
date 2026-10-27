/**
 * 보조 창 모드 ([Q-44]). 한글 옆에 좁게 붙여 쓰는 창의 위치를 계산한다.
 *
 * 부작용 없는 계산만 둔다. 창을 실제로 옮기는 일은 `main/index.ts` 가 한다.
 */
export interface Bounds { x: number; y: number; width: number; height: number }

/** 보조 창의 폭 */
export const COMPACT_WIDTH = 440
/** 보조 창에서 더 줄일 수 있는 최소 크기 */
export const COMPACT_MIN = { width: 360, height: 480 } as const
/** 보통 창의 최소 크기. 창을 만들 때와 되돌릴 때 같은 값을 쓴다 */
export const NORMAL_MIN = { width: 1000, height: 700 } as const

/** 화면(작업 영역)의 오른쪽 끝에 위아래로 꽉 차게 붙인다. 한글 창은 왼쪽에 둔다 */
export function compactBounds(workArea: Bounds): Bounds {
  const width = Math.min(COMPACT_WIDTH, workArea.width)
  return { x: workArea.x + workArea.width - width, y: workArea.y, width, height: workArea.height }
}
