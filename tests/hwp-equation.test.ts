/**
 * 한글 수식 스크립트 조판 (`src/core/math/hwp-equation.ts`).
 *
 * 여기서 지키는 것
 * - **모르는 문법이면 `null`.** 반쯤 조판한 수식은 보고서 내용을 틀리게 보여 줄 수 있다.
 * - 실제 보고서의 수식이 하나도 빠짐없이 조판된다.
 * - 조판한 나무에는 사용자가 쓴 것 말고 아무것도 더해지지 않는다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseHwpEquation } from '../src/core/math/hwp-equation.js'
import { readHwpx } from '../src/adapters/hwpx/reader.js'
import type { MathNode } from '../src/shared/math.js'

/** 나무를 눈으로 읽기 쉬운 한 줄로 만든다. */
function shape(nodes: readonly MathNode[]): string {
  return nodes.map(function one(node: MathNode): string {
    switch (node.kind) {
      case 'ident': return node.upright === true ? `rm:${node.text}` : node.text
      case 'number': return node.text
      case 'op': return node.big === true ? `BIG(${node.text})` : node.text
      case 'text': return `"${node.text}"`
      case 'space': return '_'
      case 'row': return `(${node.children.map(one).join(' ')})`
      case 'frac': return `${node.line ? 'frac' : 'atop'}(${one(node.numerator)} / ${one(node.denominator)})`
      case 'sqrt': return node.index === null ? `sqrt(${one(node.radicand)})`
        : `root(${one(node.index)}, ${one(node.radicand)})`
      case 'script': return `${node.limits ? 'limits' : 'script'}(${one(node.base)}`
        + `${node.sub === null ? '' : `, sub ${one(node.sub)}`}${node.sup === null ? '' : `, sup ${one(node.sup)}`})`
      case 'accent': return `accent(${one(node.child)})`
      case 'fenced': return `fence${node.open}${one(node.child)}${node.close}`
      case 'matrix': return `matrix[${node.rows.map(r => r.map(one).join(' & ')).join(' # ')}]`
      case 'style': return `${node.variant}(${one(node.child)})`
    }
  }).join(' ')
}

describe('한글 수식 스크립트 읽기', () => {
  it('분수·첨자·기호를 그대로 옮긴다', () => {
    expect(shape(parseHwpEquation('PV= {w} over {M} RT')!))
      .toBe('(P V) = frac(w / M) (R T)')
    expect(shape(parseHwpEquation('x_1 ^2')!)).toBe('script(x, sub 1, sup 2)')
    expect(shape(parseHwpEquation('3.448 times 10^{-3}')!)).toBe('3.448 × script(10, sup (- 3))')
    expect(shape(parseHwpEquation('THEREFORE ~M=41.81 rm g')!))
      .toBe('∴ _ M = 41.81 upright(g)')
  })

  it('근호·적분·합·극한·행렬·묶음을 옮긴다', () => {
    expect(shape(parseHwpEquation('sqrt {a^2 +b^2 }')!))
      .toBe('sqrt((script(a, sup 2) + script(b, sup 2)))')
    expect(shape(parseHwpEquation('root 3 of x')!)).toBe('root(3, x)')
    expect(shape(parseHwpEquation('sum_{i=1}^{n} x_i')!))
      .toBe('limits(BIG(∑), sub (i = 1), sup n) script(x, sub i)')
    expect(shape(parseHwpEquation('int_0^1 x dx')!))
      .toBe('limits(BIG(∫), sub 0, sup 1) x (d x)')
    expect(shape(parseHwpEquation('lim_{x -> 0}')!)).toBe('limits(rm:lim, sub (x → 0))')
    expect(shape(parseHwpEquation('matrix{a & b # c & d}')!)).toBe('matrix[a & b # c & d]')
    expect(shape(parseHwpEquation('left ( {x} over {y} right )')!)).toBe('fence(frac(x / y))')
    expect(shape(parseHwpEquation('bar {x}')!)).toBe('accent(x)')
  })

  it('한글과 단위 기호도 글로 그대로 남긴다', () => {
    expect(shape(parseHwpEquation('M(평균)=55.74 rm g/mol')!))
      .toBe('M ( "평균" ) = 55.74 upright(g) / (m o l)')
    expect(shape(parseHwpEquation('T(K)=t(℃)+273.15')!))
      .toBe('T ( K ) = t ( "℃" ) + 273.15')
  })

  it('모르는 문법이면 조판하지 않는다 (원문을 그대로 보여 주기 위해서다)', () => {
    // 없는 명령, 짝이 맞지 않는 묶음, 자리가 틀린 연산자, 빈 수식
    expect(parseHwpEquation('alpha func beta')).toBeNull()
    expect(parseHwpEquation('{a over b')).toBeNull()
    expect(parseHwpEquation('over {b}')).toBeNull()
    expect(parseHwpEquation('left ( x')).toBeNull()
    expect(parseHwpEquation('x^')).toBeNull()
    // 이름만 알고 아직 조판하지 않는 명령도 거부한다 (변수로 오해해 그리지 않는다).
    expect(parseHwpEquation('binom {n} {k}')).toBeNull()
    expect(parseHwpEquation('')).toBeNull()
    expect(parseHwpEquation('   ')).toBeNull()
  })
})

describe('실제 보고서의 수식', () => {
  const path = join(import.meta.dirname, 'fixtures/sample-full.hwpx')
  const has = existsSync(path)

  it.skipIf(!has)('한 개도 빠짐없이 조판된다', () => {
    const equations = readHwpx(path).paragraphs.flatMap(p => p.equations)
    expect(equations.length).toBeGreaterThan(100)
    const failed = equations.filter(script => parseHwpEquation(script) === null)
    expect(failed).toEqual([])
  })

  it.skipIf(!has)('원본 파일을 건드리지 않는다', () => {
    const before = readFileSync(path)
    readHwpx(path).paragraphs.flatMap(p => p.equations).forEach(parseHwpEquation)
    expect(readFileSync(path)).toEqual(before)
  })
})
