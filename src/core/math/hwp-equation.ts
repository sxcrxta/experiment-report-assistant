/**
 * 한글 수식 스크립트를 조판용 나무(`shared/math.ts`)로 바꾼다.
 *
 * 한글은 수식을 그림이 아니라 스크립트로 저장한다 (`<hp:equation><hp:script>`).
 * 예) `PV= {w} over {M} RT`, `n=3.448 times 10^{-3} rm mol`
 *
 * 규칙
 * - **모르는 것이 하나라도 나오면 `null` 을 돌려준다.** 부르는 쪽은 그때 스크립트 원문을 그대로 보여 준다.
 *   반쯤 조판한 수식은 사용자의 보고서 내용을 틀리게 보여 줄 수 있으므로 만들지 않는다.
 * - 부작용이 없는 순수 함수다. 화면·파일·모델을 모르고, 같은 입력에는 같은 나무를 돌려준다.
 * - 여기서 다루는 문법은 `tests/hwp-equation.test.ts` 가 고정한다. 새 문법을 넣을 때는
 *   **실제 문서에서 본 것만** 넣고 테스트를 함께 더한다. 추측으로 넓히지 않는다.
 */
import type { MathNode } from '../../shared/math.js'

/** 스크립트에 쓰이는 낱말 기호. 왼쪽이 한글 수식 편집기의 이름이다. */
const SYMBOLS: Readonly<Record<string, string>> = {
  // 그리스 소문자
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // 그리스 대문자
  GAMMA: 'Γ', DELTA: 'Δ', THETA: 'Θ', LAMBDA: 'Λ', XI: 'Ξ', PI: 'Π',
  SIGMA: 'Σ', UPSILON: 'Υ', PHI: 'Φ', PSI: 'Ψ', OMEGA: 'Ω',
  // 연산·관계
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗',
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  propto: '∝', ll: '≪', gg: '≫',
  // 집합·논리
  in: '∈', notin: '∉', subset: '⊂', supset: '⊃', cup: '∪', cap: '∩',
  emptyset: '∅', forall: '∀', exists: '∃',
  // 화살표
  rarrow: '→', larrow: '←', leftarrow: '←', rightarrow: '→', uparrow: '↑', downarrow: '↓',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  // 그 밖
  INF: '∞', infty: '∞', partial: '∂', nabla: '∇', angle: '∠', deg: '°', degree: '°',
  THEREFORE: '∴', BECAUSE: '∵', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  prime: '′', circ: '∘', bullet: '∙', perp: '⊥', parallel: '∥',
}

/** 곧게 쓰는 함수 이름. 기울이면 변수의 곱으로 읽힌다. */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh',
  'arcsin', 'arccos', 'arctan', 'log', 'ln', 'exp', 'max', 'min', 'gcd', 'mod', 'det',
])

/** 첨자를 위아래에 두는 큰 연산자. */
const BIG_OPERATORS: Readonly<Record<string, string>> = {
  sum: '∑', prod: '∏', coprod: '∐', lim: 'lim', int: '∫', oint: '∮', iint: '∬', iiint: '∭',
}

const ACCENTS: Readonly<Record<string, string>> = {
  bar: '‾', vec: '⃗', hat: '^', tilde: '~', dot: '˙', ddot: '¨', acute: '´', grave: '`',
  widehat: '^', widetilde: '~', check: 'ˇ', breve: '˘', ring: '˚', overline: '‾',
}
/** 글 아래에 붙는 것. 위에 붙는 `ACCENTS` 와 방향만 다르다. */
const UNDER_ACCENTS: Readonly<Record<string, string>> = { underline: '_', underbar: '_' }

/**
 * 한글 수식 편집기에 있는 것은 알지만 **아직 조판하지 않는** 명령.
 *
 * 이 목록이 필요한 이유: 모르는 낱말은 변수로 본다 (`mol`, `atm` 처럼 단위가 그렇게 온다).
 * 목록이 없으면 `widehat x` 가 변수 일곱 개의 곱처럼 보이고, 사용자는 자기가 쓴 것과 **다른 수식**을 본다.
 * 목록에 있으면 그 수식만 스크립트 원문으로 내려가므로 틀리게 보이지 않는다.
 * 목록이 완전하지 않을 수 있다. 새로 발견하면 여기에 더하거나 조판을 구현한다.
 */
const UNSUPPORTED = new Set([
  'lsub', 'lsup', 'binom', 'bincoef', 'choose', 'func', 'mat', 'size', 'color', 'nitalic',
  'big', 'buildrel', 'stackrel', 'limsup', 'liminf', 'arch', 'dyad', 'smallint', 'combine',
  'repeat', 'hspace', 'vspace', 'align', 'eqalign',
])

const STYLES: Readonly<Record<string, 'upright' | 'bold' | 'italic'>> = {
  rm: 'upright', roman: 'upright', bold: 'bold', it: 'italic', italic: 'italic',
}

/** 묶음 기호. `left`·`right` 뒤에 온다. */
const FENCES: Readonly<Record<string, string>> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '{': '{', '}': '}',
  '|': '|', '‖': '‖', '<': '⟨', '>': '⟩', '.': '',
  LEFT: '', RIGHT: '',
}

/** 행렬 종류와 바깥 묶음 기호. */
const MATRICES: Readonly<Record<string, { open: string; close: string }>> = {
  matrix: { open: '', close: '' },
  pmatrix: { open: '(', close: ')' },
  bmatrix: { open: '[', close: ']' },
  dmatrix: { open: '|', close: '|' },
  cases: { open: '{', close: '' },
  pile: { open: '', close: '' },
}

/** 여러 글자로 된 연산자를 먼저 본다. `<=` 를 `<` 와 `=` 로 쪼개면 뜻이 달라진다. */
const OPERATOR_PAIRS: Readonly<Record<string, string>> = {
  '<=': '≤', '>=': '≥', '!=': '≠', '==': '=', '->': '→', '<-': '←', '+-': '±', '-+': '∓',
}

const SINGLE_OPERATORS = '+-=<>/()[]|,;:!∈∉⊂⊃∪∩→←↑↓↔×·÷±∓≤≥≠≈≡∼∝∞∂∇∠°∴∵…⋯％%'

interface Token {
  kind: 'word' | 'number' | 'op' | 'brace' | 'script' | 'space' | 'sep' | 'text'
  text: string
}

/** 스크립트를 토막으로 끊는다. 모르는 글자가 나오면 `null`. */
export function tokenizeHwpEquation(script: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < script.length) {
    const c = script[i]!
    if (/\s/.test(c)) { i += 1; continue }
    if (c === '~') { tokens.push({ kind: 'space', text: '~' }); i += 1; continue }
    if (c === '`') { tokens.push({ kind: 'space', text: '`' }); i += 1; continue }
    if (c === '{' || c === '}') { tokens.push({ kind: 'brace', text: c }); i += 1; continue }
    if (c === '^' || c === '_') { tokens.push({ kind: 'script', text: c }); i += 1; continue }
    if (c === '&' || c === '#') { tokens.push({ kind: 'sep', text: c }); i += 1; continue }
    const pair = script.slice(i, i + 2)
    if (OPERATOR_PAIRS[pair] !== undefined) { tokens.push({ kind: 'op', text: OPERATOR_PAIRS[pair] }); i += 2; continue }
    if (/[0-9]/.test(c)) {
      const number = /^[0-9]+(?:\.[0-9]+)?/.exec(script.slice(i))![0]
      tokens.push({ kind: 'number', text: number })
      i += number.length
      continue
    }
    if (/[A-Za-z]/.test(c)) {
      const word = /^[A-Za-z]+/.exec(script.slice(i))![0]
      tokens.push({ kind: 'word', text: word })
      i += word.length
      continue
    }
    if (SINGLE_OPERATORS.includes(c)) { tokens.push({ kind: 'op', text: c }); i += 1; continue }
    // 한글·단위 기호처럼 글로 둘 것. 이어지는 만큼 한 덩어리로 묶는다.
    const text = /^[^\s{}^_&#0-9A-Za-z~`]+/.exec(script.slice(i))
    if (text === null) return null
    const run = text[0].split('').filter(ch => !SINGLE_OPERATORS.includes(ch)).join('')
    if (run.length === 0) return null
    tokens.push({ kind: 'text', text: run })
    i += run.length
  }
  return tokens
}

class Unsupported extends Error {}

/** 한글 수식 스크립트를 조판용 나무로 바꾼다. 모르는 문법이면 `null`. */
export function parseHwpEquation(script: string): MathNode[] | null {
  const tokens = tokenizeHwpEquation(script)
  if (tokens === null) return null
  let at = 0
  const peek = (): Token | undefined => tokens[at]
  const next = (): Token => {
    const token = tokens[at]
    if (token === undefined) throw new Unsupported('수식이 끝나지 않았습니다')
    at += 1
    return token
  }

  function row(children: MathNode[]): MathNode {
    return children.length === 1 ? children[0]! : { kind: 'row', children }
  }

  /** 하나의 덩어리: 묶음·명령·기호 하나. */
  function primary(): MathNode {
    const token = next()
    if (token.kind === 'brace') {
      if (token.text !== '{') throw new Unsupported('짝이 맞지 않는 }')
      const children = items(stop => stop.kind === 'brace' && stop.text === '}')
      next()
      return row(children)
    }
    if (token.kind === 'space') return { kind: 'space', em: token.text === '~' ? 0.44 : 0.22 }
    if (token.kind === 'number') return { kind: 'number', text: token.text }
    if (token.kind === 'text') return { kind: 'text', text: token.text }
    if (token.kind === 'op') return { kind: 'op', text: token.text }
    if (token.kind === 'script' || token.kind === 'sep') throw new Unsupported(`홀로 쓸 수 없습니다: ${token.text}`)

    const word = token.text
    if (word === 'sqrt') return { kind: 'sqrt', radicand: primary(), index: null }
    if (word === 'root') {
      const index = primary()
      const of = next()
      if (of.kind !== 'word' || of.text !== 'of') throw new Unsupported('root 뒤에 of 가 없습니다')
      return { kind: 'sqrt', radicand: primary(), index }
    }
    if (UNSUPPORTED.has(word)) throw new Unsupported(`아직 조판하지 않는 명령입니다: ${word}`)
    if (STYLES[word] !== undefined) return { kind: 'style', child: primary(), variant: STYLES[word] }
    if (ACCENTS[word] !== undefined) return { kind: 'accent', child: primary(), accent: ACCENTS[word] }
    if (UNDER_ACCENTS[word] !== undefined) {
      return { kind: 'accent', child: primary(), accent: UNDER_ACCENTS[word], under: true }
    }
    if (word === 'left') return fenced()
    if (MATRICES[word] !== undefined) return matrix(word)
    if (BIG_OPERATORS[word] !== undefined) {
      return { kind: 'op', text: BIG_OPERATORS[word], big: true }
    }
    if (SYMBOLS[word] !== undefined) return { kind: 'op', text: SYMBOLS[word] }
    if (FUNCTIONS.has(word)) return { kind: 'ident', text: word, upright: true }
    if (word === 'over' || word === 'atop' || word === 'of' || word === 'right'
      || word === 'from' || word === 'to' || word === 'rsub' || word === 'rsup') {
      throw new Unsupported(`자리가 맞지 않습니다: ${word}`)
    }
    // 남은 낱말은 변수다. 한글은 변수를 글자마다 기울여 쓰므로(`PV` 는 P·V 의 곱) 한 글자씩 나눈다.
    // 단위처럼 곧게 써야 하는 것은 문서가 `rm` 을 붙여 주고, 그 `rm` 이 이 덩어리를 통째로 감싼다.
    return word.length === 1
      ? { kind: 'ident', text: word }
      : { kind: 'row', children: [...word].map(letter => ({ kind: 'ident', text: letter } as const)) }
  }

  function delimiter(): string {
    const token = next()
    const fence = FENCES[token.text]
    if (fence === undefined) throw new Unsupported(`묶음 기호가 아닙니다: ${token.text}`)
    return fence
  }

  function fenced(): MathNode {
    const open = delimiter()
    const children = items(stop => stop.kind === 'word' && stop.text === 'right')
    next()
    return { kind: 'fenced', open, close: delimiter(), child: row(children) }
  }

  function matrix(word: string): MathNode {
    const shape = MATRICES[word]!
    const brace = next()
    if (brace.kind !== 'brace' || brace.text !== '{') throw new Unsupported(`${word} 뒤에 { 가 없습니다`)
    const rows: MathNode[][] = [[]]
    let cell: MathNode[] = []
    for (;;) {
      const token = peek()
      if (token === undefined) throw new Unsupported('행렬이 닫히지 않았습니다')
      if (token.kind === 'brace' && token.text === '}') {
        next()
        rows[rows.length - 1]!.push(row(cell))
        break
      }
      if (token.kind === 'sep') {
        next()
        rows[rows.length - 1]!.push(row(cell))
        cell = []
        if (token.text === '#') rows.push([])
        continue
      }
      cell.push(...items(stop =>
        (stop.kind === 'brace' && stop.text === '}') || stop.kind === 'sep'))
    }
    return { kind: 'matrix', rows, open: shape.open, close: shape.close }
  }

  /** 덩어리 하나에 위·아래 첨자를 붙인다. `x_1^2`, `sum_{i=1}^{n}` */
  function withScripts(): MathNode {
    let base = primary()
    let sub: MathNode | null = null
    let sup: MathNode | null = null
    for (;;) {
      const token = peek()
      // `sum from {i=1} to {n}` 은 `sum_{i=1}^{n}` 과 같은 뜻이다.
      const named = token?.kind === 'word'
        ? token.text === 'from' || token.text === 'rsub' ? '_'
          : token.text === 'to' || token.text === 'rsup' ? '^' : null
        : null
      if (token === undefined || (token.kind !== 'script' && named === null)) break
      next()
      if ((named ?? token.text) === '_') {
        if (sub !== null) throw new Unsupported('아래 첨자가 두 번 붙었습니다')
        sub = primary()
      } else {
        if (sup !== null) throw new Unsupported('위 첨자가 두 번 붙었습니다')
        sup = primary()
      }
    }
    if (sub === null && sup === null) return base
    const limits = base.kind === 'op' && base.big === true
    if (base.kind === 'op' && base.text === 'lim') base = { kind: 'ident', text: 'lim', upright: true }
    return { kind: 'script', base, sub, sup, limits }
  }

  /** 덩어리를 차례로 모은다. `over` 는 앞뒤 덩어리를 분수로 묶는다. */
  function items(stop: (token: Token) => boolean): MathNode[] {
    const out: MathNode[] = []
    for (;;) {
      const token = peek()
      if (token === undefined || stop(token)) return out
      if (token.kind === 'word' && (token.text === 'over' || token.text === 'atop')) {
        next()
        const numerator = out.pop()
        if (numerator === undefined) throw new Unsupported('분수의 분자가 없습니다')
        out.push({ kind: 'frac', numerator, denominator: withScripts(), line: token.text === 'over' })
        continue
      }
      out.push(withScripts())
    }
  }

  try {
    const nodes = items(() => false)
    return nodes.length === 0 ? null : nodes
  } catch (cause) {
    if (cause instanceof Unsupported) return null
    throw cause
  }
}
