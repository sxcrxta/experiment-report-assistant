/**
 * 7단계 — 심층 검토 어댑터 (로컬 Claude Code). 고정 응답만 쓰고 실제 프로세스를 띄우지 않는다.
 *
 * T-24 두 어댑터가 같은 요청·같은 검증기를 지난다 (`adapter-contract.test.ts` 와 함께).
 * T-27 응답을 읽지 못하면 결과가 아니라 malformed 로 알린다 (재시도는 앱이 한다).
 * T-28 **한 번에 하나만 실행되고, 타임아웃·취소가 프로세스를 정리한다.**
 * T-29 외부로 나가는 지점은 두 곳뿐이고, 나가는 내용은 대상·문맥으로 한정된다.
 *
 * 그 밖에
 * - Claude API 를 부르는 코드가 없다 (PRD 4.3). 네트워크 호출도, API 키도 이 어댑터에 없다.
 * - 종료 코드만 믿지 않는다. `is_error` 가 true 면 실패다 (`docs/V2-claude-code-확인.md` 5절).
 * - 프롬프트는 판이 붙은 템플릿이다. 판을 올리지 않고 글을 고치면 이 테스트가 실패한다.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_MODEL_ID,
  createClaudeCode,
  parseEnvelope,
  renderOutboundPrompt,
  REVIEW_OUTPUT_SCHEMA,
  type CliInvocation,
  type CliResult,
  type CliTransport,
} from '../src/adapters/model/claude-code.js'
import type { ClaudeCliLocator, ClaudeCliStatus } from '../src/adapters/model/claude-path.js'
import { DEEP_REVIEW_PROMPT, DEEP_REVIEW_V1 } from '../src/adapters/model/prompts/index.js'
import { createReviewRequest, type ReviewRequest } from '../src/adapters/model/schema.js'
import { confirmRubric } from '../src/core/rubric/model.js'

const SRC = join(import.meta.dirname, '..', 'src')
const CLI = '/Users/me/.local/bin/claude'

function ready(status: Partial<ClaudeCliStatus> = {}): ClaudeCliLocator {
  return {
    status: () =>
      Promise.resolve({
        state: 'ready',
        path: CLI,
        version: '2.1.269 (Claude Code)',
        message: '쓸 수 있습니다.',
        fromOverride: false,
        ...status,
      }),
    forget: () => undefined,
  }
}

/** 큐에 밀린 일이 실제로 시작될 때까지 기다린다. 마이크로태스크 몇 번으로는 모자란다. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 보낸 호출을 모아 두고 정해 둔 결과를 돌려주는 가짜 실행. */
function fixedTransport(
  respond: (invocation: CliInvocation) => CliResult | Promise<CliResult>,
): { transport: CliTransport; sent: CliInvocation[] } {
  const sent: CliInvocation[] = []
  return {
    sent,
    transport: async (invocation) => {
      sent.push(invocation)
      return respond(invocation)
    },
  }
}

/** 실제로 확인한 성공 봉투의 모양 (`docs/V2-claude-code-확인.md` 4절). */
function envelope(result: unknown, overrides: Record<string, unknown> = {}): CliResult {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      session_id: 's-1',
      total_cost_usd: 0.02,
      result: JSON.stringify(result),
      structured_output: result,
      api_error_status: null,
      ...overrides,
    }),
  }
}

const MODEL_OUTPUT = {
  summary: '결과와 고찰의 연결을 다시 살펴보세요.',
  items: [
    {
      paragraph: 'P1',
      perspective: 'logic',
      severity: 4,
      body: '온도 상승만으로 가설이 맞다고 볼 수 있을까요?',
      rationale: '관찰과 결론 사이에 다른 원인을 배제한 근거가 없습니다.',
      rubricItems: ['R1'],
    },
  ],
}

function sampleRequest(overrides: Partial<Parameters<typeof createReviewRequest>[0]> = {}): ReviewRequest {
  const confirmed = confirmRubric({
    documentId: 'doc-1',
    ordinal: 1,
    confirmedAt: '2026-09-12T00:00:00.000Z',
    items: [{ itemId: 'rubric-item-1', title: '결과', description: '측정값을 밝힌다', importance: 4 }],
  })
  if (!confirmed.ok) throw new Error(confirmed.problems.join(', '))
  const created = createReviewRequest({
    requestId: 'req-internal-id',
    documentVersionId: 'version-internal-id',
    scope: 'paragraph',
    stage: 'question',
    perspectives: ['logic'],
    targets: [{ paragraphId: 'paragraph-uuid-1', text: '온도가 올라갔으므로 가설이 맞다.', order: 4 }],
    context: [{ paragraphId: 'paragraph-uuid-0', text: '2. 결과', order: 3 }],
    rubric: confirmed.rubric,
    approvedGuidelines: [],
    ...overrides,
  })
  if (!created.ok) throw new Error(created.problems.join(', '))
  return created.request
}

describe('부르기 전 확인', () => {
  it('Claude Code 를 찾지 못하면 부르지 않고 이유를 돌려준다', async () => {
    const { transport, sent } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({
      transport,
      locator: {
        status: () =>
          Promise.resolve({
            state: 'not-installed', path: null, version: null,
            message: 'Claude Code 를 찾지 못했습니다.', fromOverride: false,
          }),
        forget: () => undefined,
      },
    })

    expect(await model.checkAvailability()).toEqual({
      available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.',
    })
    expect(await model.review(sampleRequest())).toMatchObject({ ok: false, reason: 'not-installed' })
    expect(sent).toHaveLength(0)
  })

  it('로그인되어 있지 않으면 부르지 않는다', async () => {
    const { transport, sent } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({
      transport,
      locator: ready({ state: 'not-logged-in', message: '로그인되어 있지 않습니다.' }),
    })

    expect(await model.review(sampleRequest())).toMatchObject({ ok: false, reason: 'not-logged-in' })
    expect(sent).toHaveLength(0)
  })
})

describe('호출 인자와 보내는 내용 (T-29)', () => {
  it('확인한 인자만 쓰고, 프롬프트는 인자가 아니라 stdin 으로 보낸다', async () => {
    const { transport, sent } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({ transport, locator: ready() })

    await model.review(sampleRequest())
    const call = sent[0]!

    expect(call.command).toBe(CLI)
    expect(call.args).toEqual([
      '-p', '--output-format', 'json',
      '--json-schema', JSON.stringify(REVIEW_OUTPUT_SCHEMA),
      '--system-prompt', DEEP_REVIEW_PROMPT.system,
      '--model', CLAUDE_MODEL_ID,
      '--tools', '',
      '--permission-prompts', 'none',
      '--no-session-persistence',
      '--safe-mode',
    ])
    // 문서 내용은 인자에 실리지 않는다. 다른 프로세스가 인자를 볼 수 있기 때문이다.
    expect(call.args.join(' ')).not.toContain('온도가 올라갔으므로')
    expect(call.stdin).toContain('온도가 올라갔으므로')
  })

  it('대상과 앞뒤 문맥만 보내고 내부 식별자는 별칭으로 바꾼다', async () => {
    const { transport, sent } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({ transport, locator: ready() })

    await model.review(sampleRequest())
    const stdin = sent[0]!.stdin

    expect(stdin).toContain('2. 결과')
    for (const internal of ['req-internal-id', 'version-internal-id', 'doc-1', 'rubric-item-1',
      'paragraph-uuid-1', 'paragraph-uuid-0']) {
      expect(stdin).not.toContain(internal)
    }
    expect(stdin).toContain('"id": "P1"')
  })

  it('재심이면 원 피드백과 사용자 판단을 함께 보내고, 아니면 그 자리가 아예 없다', async () => {
    const { transport, sent } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({ transport, locator: ready() })

    await model.review(sampleRequest())
    expect(sent[0]!.stdin).not.toContain('priorFeedback')

    await model.review(
      sampleRequest({
        priorFeedback: [{
          paragraphId: 'paragraph-uuid-1', perspective: 'logic', stage: 'question',
          body: '어떤 측정값으로 확인했나요?', rationale: '측정값이 드러나지 않습니다.',
          reaction: 'rebuttal', reactionReason: '표 2에 측정값을 적어 두었습니다.',
        }],
      }),
    )
    const stdin = sent[1]!.stdin
    expect(stdin).toContain('"userReaction": "rebuttal"')
    expect(stdin).toContain('표 2에 측정값을 적어 두었습니다.')
    // 재심에서도 문단은 별칭으로 나간다.
    expect(stdin).not.toContain('paragraph-uuid-1')
  })
})

describe('응답 읽기', () => {
  it('구조화 출력을 그대로 돌려준다', async () => {
    const { transport } = fixedTransport(() => envelope(MODEL_OUTPUT))
    const model = createClaudeCode({ transport, locator: ready() })

    const result = await model.review(sampleRequest())
    expect(result).toEqual({ ok: true, text: JSON.stringify(MODEL_OUTPUT) })
  })

  it('종료 코드가 0 이어도 is_error 면 실패다', async () => {
    const { transport } = fixedTransport(() => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
        result: 'Rate limit reached',
      }),
    }))
    const model = createClaudeCode({ transport, locator: ready() })

    const result = await model.review(sampleRequest())
    expect(result).toMatchObject({ ok: false, reason: 'rate-limited' })
    if (result.ok) throw new Error('실패해야 한다')
    expect(result.message).toContain('Rate limit reached')
  })

  it('오류 응답의 설명 문장을 모델의 답인 척 쓰지 않는다 (T-27)', () => {
    const parsed = parseEnvelope(JSON.stringify({
      is_error: true, api_error_status: 404, result: "There's an issue with the selected model",
    }))
    expect(parsed).toEqual({
      isError: true, apiErrorStatus: 404, text: null, detail: "There's an issue with the selected model",
    })
  })

  it('봉투를 읽지 못하면 결과가 아니라 malformed 로 알린다 (T-27)', async () => {
    const { transport } = fixedTransport(() => ({ code: 0, stdout: '설명을 곁들인 글', stderr: '' }))
    const model = createClaudeCode({ transport, locator: ready() })

    const result = await model.review(sampleRequest())
    expect(result).toMatchObject({ ok: false, reason: 'malformed' })
    if (result.ok) throw new Error('실패해야 한다')
    // 파싱하지 못한 원문을 결과인 척 보여 주지 않는다.
    expect(result.message).not.toContain('설명을 곁들인 글')
  })

  it('로그인이 거절되면 무엇을 하면 되는지 알린다', async () => {
    const { transport } = fixedTransport(() => ({
      code: 1, stderr: '', stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: 'Unauthorized' }),
    }))
    const model = createClaudeCode({ transport, locator: ready() })
    const result = await model.review(sampleRequest())
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
    if (result.ok) throw new Error('실패해야 한다')
    expect(result.message).toContain('claude auth login')
  })

  it('실행 파일이 사라졌으면 다음 요청에서 다시 찾도록 캐시를 버린다', async () => {
    const forget = vi.fn()
    const { transport } = fixedTransport(() => ({ code: null, stdout: '', stderr: 'ENOENT', notFound: true }))
    const detector = ready()
    const model = createClaudeCode({
      transport,
      locator: { status: () => detector.status(), forget },
    })

    expect(await model.review(sampleRequest())).toMatchObject({ ok: false, reason: 'not-installed' })
    expect(forget).toHaveBeenCalled()
  })
})

describe('한 번에 하나만 실행한다 (T-28)', () => {
  it('앞 호출이 끝나야 다음 호출이 프로세스를 띄운다', async () => {
    let running = 0
    let peak = 0
    const release: (() => void)[] = []
    const { transport, sent } = fixedTransport(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise<void>((resolve) => release.push(resolve))
      running -= 1
      return envelope(MODEL_OUTPUT)
    })
    const model = createClaudeCode({ transport, locator: ready() })

    const first = model.review(sampleRequest())
    const second = model.review(sampleRequest())
    await flush()

    // 아직 하나만 떠 있다.
    expect(sent).toHaveLength(1)

    release.shift()!()
    await first
    // 앞 호출이 끝난 뒤에야 다음 호출이 프로세스를 띄운다.
    await flush()
    expect(sent).toHaveLength(2)
    release.shift()!()
    await second

    expect(sent).toHaveLength(2)
    expect(peak).toBe(1)
    expect(model.busy()).toBe(false)
  })

  it('앞 호출이 실패해도 다음 호출이 사라지지 않는다', async () => {
    let call = 0
    const { transport } = fixedTransport(() => {
      call += 1
      if (call === 1) throw new Error('실행 실패')
      return envelope(MODEL_OUTPUT)
    })
    const model = createClaudeCode({ transport, locator: ready() })

    expect(await model.review(sampleRequest())).toMatchObject({ ok: false, reason: 'rejected' })
    expect(await model.review(sampleRequest())).toMatchObject({ ok: true })
  })

  it('타임아웃으로 끝난 실행은 프로세스를 정리하고 실패로 알린다', async () => {
    const { transport } = fixedTransport(() => ({ code: null, stdout: '', stderr: '', timedOut: true }))
    const model = createClaudeCode({ transport, locator: ready(), timeoutMs: 1_000 })

    const result = await model.review(sampleRequest())
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    if (result.ok) throw new Error('실패해야 한다')
    expect(result.message).toContain('1초')
  })

  it('취소하면 실행 중인 호출에 중단 신호가 가고 결과는 실패다', async () => {
    let aborted = false
    const { transport } = fixedTransport(
      (_invocation) =>
        new Promise<CliResult>((resolve) => {
          // 신호를 받으면 죽은 프로세스의 결과를 흉내 낸다.
          signal!.addEventListener('abort', () => {
            aborted = true
            resolve({ code: null, stdout: '', stderr: '', canceled: true })
          })
        }),
    )
    let signal: AbortSignal | null = null
    const wrapped: CliTransport = (invocation, incoming) => {
      signal = incoming
      return transport(invocation, incoming)
    }
    const model = createClaudeCode({ transport: wrapped, locator: ready() })

    const pending = model.review(sampleRequest())
    await flush()
    expect(model.busy()).toBe(true)
    model.cancel()

    const result = await pending
    expect(aborted).toBe(true)
    expect(result).toMatchObject({ ok: false, reason: 'rejected' })
    if (result.ok) throw new Error('실패해야 한다')
    expect(result.message).toContain('취소')
    expect(model.busy()).toBe(false)
  })
})

describe('프롬프트 판 (버전 관리)', () => {
  it('판을 올리지 않고 글을 고치면 실패한다', () => {
    // 1판은 이제 현재 판이 아니지만, 글이 바뀌지 않았는지는 그대로 지킨다.
    const prompt = renderOutboundPrompt(sampleRequest(), DEEP_REVIEW_V1)
    const digest = createHash('sha256').update(`${DEEP_REVIEW_V1.system}\n${prompt}`).digest('hex')

    expect(DEEP_REVIEW_V1.version).toBe('deep-review.v1')
    expect(digest).toBe('976a259bddbd911cdd56216485bdca51856a624b4f97eed1035383f5d8222341')
  })

  it('현재 2판도 판을 올리지 않고 글을 고치면 실패한다 ([Q-48])', () => {
    const prompt = renderOutboundPrompt(sampleRequest())
    const digest = createHash('sha256').update(`${DEEP_REVIEW_PROMPT.system}\n${prompt}`).digest('hex')
    expect(DEEP_REVIEW_PROMPT.version).toBe('deep-review.v2')
    expect(DEEP_REVIEW_PROMPT.system).toContain('document.kind')
    expect(DEEP_REVIEW_PROMPT.system).not.toContain('평가 지침(rubric)에 근거가 있으면')
    expect(digest).toBe('068b77241cc32fb51d795da62b5797719b9bbe4de044ee2991cd2c1f802d29a6')
  })

  it('단계마다 해도 되는 것을 프롬프트가 적는다', () => {
    const question = renderOutboundPrompt(sampleRequest())
    expect(question).toContain('수정 예시는 쓰지 않습니다')

    const example = renderOutboundPrompt(sampleRequest({ stage: 'example' }))
    expect(example).toContain('명시적으로 요청했습니다')
  })
})

// ---------------------------------------------------------------------------
// 소스 전체에 걸린 불변식
// ---------------------------------------------------------------------------

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function rel(file: string): string {
  return relative(join(SRC, '..'), file).split(sep).join('/')
}

describe('Claude API 를 부르지 않는다 (PRD 4.3)', () => {
  it('어댑터에 API 주소도 키도 없다', () => {
    const source = code(join(SRC, 'adapters', 'model', 'claude-code.ts'))
    expect(source).not.toMatch(/api\.anthropic\.com|ANTHROPIC_API_KEY|anthropic-version/i)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    // 인증은 설치된 Claude Code 가 한다. 이 어댑터는 키를 만지지 않는다.
    expect(source).not.toContain('SECRET_KEYS')
  })

  it('자식 프로세스를 띄우는 파일은 정해진 세 곳뿐이다 (T-29)', () => {
    const offenders = sourcesUnder(SRC)
      .filter((file) => /from\s+['"]node:child_process['"]/.test(code(file)))
      .map(rel)
    // 키체인(security), 경로 감지, 심층 검토. 그 밖에는 없다.
    expect(offenders.sort()).toEqual([
      'src/adapters/model/claude-code.ts',
      'src/adapters/model/claude-path.ts',
      'src/adapters/secret/keychain.ts',
    ])
  })

  it('그 파일 안에서도 spawn 은 한 번만 부른다', () => {
    const source = code(join(SRC, 'adapters', 'model', 'claude-code.ts'))
    expect(source.match(/\bspawn\s*\(/g)).toHaveLength(1)
  })

  it('모델 이름 상수는 어댑터 안에만 있다', () => {
    const offenders = sourcesUnder(SRC)
      .filter((file) => /CLAUDE_MODEL_ID\s*=/.test(code(file)))
      .map(rel)
    expect(offenders).toEqual(['src/adapters/model/claude-code.ts'])
  })
})
