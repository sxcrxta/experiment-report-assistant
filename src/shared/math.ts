/**
 * 조판한 수식의 모양 (한글 수식 스크립트 → 이 나무 → 화면의 MathML).
 *
 * 이 모듈은 타입만 담는다. 스크립트를 이 나무로 바꾸는 일은 `core/math/hwp-equation.ts` 가,
 * 이 나무를 그리는 일은 `renderer/src/views/math.ts` 가 한다.
 *
 * **모르는 문법이 하나라도 나오면 나무를 만들지 않는다.** 그때는 사용자가 쓴 스크립트 원문을
 * 그대로 보여 준다. 잘못 조판한 수식은 없는 것보다 나쁘다.
 */

export type MathNode =
  /** 변수·함수 이름. `upright` 면 곧게 쓴다 (`rm`, 함수 이름) */
  | { kind: 'ident'; text: string; upright?: boolean }
  | { kind: 'number'; text: string }
  /** 연산자·기호. `big` 이면 합·적분처럼 크게 그린다 */
  | { kind: 'op'; text: string; big?: boolean }
  /** 수식 안의 일반 글 (한글 등) */
  | { kind: 'text'; text: string }
  | { kind: 'space'; em: number }
  | { kind: 'row'; children: MathNode[] }
  /** 분수. `line: false` 면 선 없이 위아래로만 쌓는다 (`atop`) */
  | { kind: 'frac'; numerator: MathNode; denominator: MathNode; line: boolean }
  | { kind: 'sqrt'; radicand: MathNode; index: MathNode | null }
  /** 위·아래 첨자. `limits` 면 첨자를 옆이 아니라 위아래에 둔다 (합·극한) */
  | { kind: 'script'; base: MathNode; sub: MathNode | null; sup: MathNode | null; limits: boolean }
  /** 글 위에 붙는 표시. `under` 면 아래에 붙인다 */
  | { kind: 'accent'; child: MathNode; accent: string; under?: boolean }
  | { kind: 'fenced'; open: string; close: string; child: MathNode }
  | { kind: 'matrix'; rows: MathNode[][]; open: string; close: string }
  | { kind: 'style'; child: MathNode; variant: 'upright' | 'bold' | 'italic' }
