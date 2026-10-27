/**
 * 4단계 — OpenRouter Gemma 어댑터 (고정 응답). 실제 네트워크 호출은 없다.
 *
 * T-11 AI 응답이 저장소를 직접 바꾸는 경로가 없다 (어댑터는 저장소를 모른다).
 * T-27 응답 봉투를 읽지 못하면 결과가 아니라 malformed 로 알린다 (재시도는 앱이 한다).
 * T-29 외부 전송은 한 지점에서만 일어나고, 페이로드가 대상·문맥으로 한정된다.
 * T-30 키는 요청 머리글에만 실리고 본문·결과·오류 문구에 들어가지 않는다.
 *
 * 그 밖에
 * - 키 미등록·키체인 오류·API 오류(401/402/429/5xx)·연결 실패·시간 초과를 결과로 알린다
 * - 프롬프트는 버전이 붙은 템플릿이다. 판을 올리지 않고 글을 고치면 이 테스트가 실패한다
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createOpenRouterGemma,
  GEMMA_MODEL_ID,
  OPENROUTER_CHAT_COMPLETIONS_URL,
  renderOutboundPrompt,
  type HttpTransport,
  type OutboundRequest,
  type OutboundResponse,
} from '../src/adapters/model/openrouter-gemma.js'
import { QUICK_REVIEW_PROMPT, QUICK_REVIEW_V1, QUICK_REVIEW_V3 } from '../src/adapters/model/prompts/index.js'
import {
  createReviewRequest,
  toModelPayload,
  validateModelOutput,
  type ReviewRequest,
} from '../src/adapters/model/schema.js'
import { SECRET_KEYS, type SecretStore } from '../src/adapters/secret/index.js'
import { selectContext } from '../src/core/diff/context.js'
import { confirmRubric } from '../src/core/rubric/model.js'

import { makeParagraphs } from './helpers/paragraphs.js'

/** 고정 응답용 가짜 키. 실제 키 형식(sk-or-v1- + 64자리)이 아니다 */
const FAKE_KEY = 'sk-or-v1-fixture-key'

it('성장 요약도 같은 Gemma 전송 경계를 사용하고 집계만 보낸다',async()=>{
  const resultText=JSON.stringify({sentences:[{text:'관찰 기록입니다.',evidence:['E1']}]})
  const {transport,sent}=fixedTransport(()=>completion(resultText))
  const model=createOpenRouterGemma({secrets:memorySecrets(),transport})
  const result=await model.summarizeGrowth!({groups:[{perspective:'logic',repeatCount:2,changedCount:1,
    improvedCount:0,rebuttalCount:1,evidence:['E1']}]})
  expect(result).toEqual({ok:true,text:resultText})
  expect(sent).toHaveLength(1)
  expect(sent[0]!.url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL)
  expect(JSON.parse(sent[0]!.body)).toMatchObject({model:GEMMA_MODEL_ID})
  expect(sent[0]!.body).toContain('repeatCount')
  expect(sent[0]!.body).not.toContain(FAKE_KEY)
})

const SRC = join(import.meta.dirname, '..', 'src')

function memorySecrets(initial: Record<string, string> = { [SECRET_KEYS.openRouter]: FAKE_KEY }): SecretStore {
  const values = new Map(Object.entries(initial))
  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}

/** 보낸 요청을 모아 두고 정해 둔 응답을 돌려주는 가짜 전송. */
function fixedTransport(
  respond: (request: OutboundRequest) => OutboundResponse | Promise<OutboundResponse>,
): { transport: HttpTransport; sent: OutboundRequest[] } {
  const sent: OutboundRequest[] = []
  return {
    sent,
    transport: async (request) => {
      sent.push(request)
      return respond(request)
    },
  }
}

/** OpenRouter chat completions 성공 응답 모양의 고정 응답 */
function completion(content: string): OutboundResponse {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'gen-fixture-1',
      model: GEMMA_MODEL_ID,
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  }
}

function errorResponse(status: number, message: string): OutboundResponse {
  return { status, body: JSON.stringify({ error: { code: status, message } }) }
}

const MODEL_OUTPUT = JSON.stringify({
  summary: '결과 해석의 근거를 다시 볼 곳이 있습니다.',
  items: [
    {
      paragraph: 'P1',
      perspective: 'logic',
      severity: 4,
      body: '압력이 늘었다고 판단한 측정값은 어디에 있나요?',
      rationale: '결과 문단에 수치가 드러나지 않습니다.',
      rubricItems: ['R1'],
    },
  ],
})

/** 문단 다섯 개인 문서에서 가운데 문단 하나만 검토하는 요청 */
function sampleRequest(stage: ReviewRequest['stage'] = 'question'): { request: ReviewRequest; texts: string[] } {
  const texts = [
    '1. 실험 목적 — 보일 법칙을 확인한다.',
    '2. 실험 방법 — 주사기 부피를 바꾸며 압력을 쟀다.',
    '3. 결과 — 부피가 줄면 압력이 늘었다.',
    '4. 고찰 — 온도가 일정하지 않았을 수 있다.',
    '5. 결론 — 보일 법칙이 성립한다.',
  ]
  const paragraphs = makeParagraphs(texts)
  const target = paragraphs[2]!
  const context = selectContext(paragraphs, new Set([target.uuid]))

  const rubric = confirmRubric({
    documentId: 'doc-1',
    ordinal: 1,
    items: [{ itemId: 'rubric-1', title: '결과 해석', description: '측정값을 근거로 해석하는가', importance: 5 }],
    confirmedAt: '2026-09-11T00:00:00.000Z',
  })
  if (!rubric.ok) throw new Error(rubric.problems.join())

  const created = createReviewRequest({
    requestId: 'req-internal-id',
    documentVersionId: 'version-internal-id',
    scope: 'paragraph',
    stage,
    perspectives: ['logic'],
    targets: [{ paragraphId: target.uuid, text: target.text, order: target.index }],
    context: context.map((p) => ({ paragraphId: p.uuid, text: p.text, order: p.index })),
    rubric: rubric.rubric,
    approvedGuidelines: [],
  })
  if (!created.ok) throw new Error(created.problems.join())
  return { request: created.request, texts }
}

describe('OpenRouter 로 보내는 요청', () => {
  it('키는 머리글에만 싣고, 모델 이름과 사용자 메시지 하나를 보낸다', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const { request } = sampleRequest()

    const result = await model.review(request)

    expect(result).toEqual({ ok: true, text: MODEL_OUTPUT })
    expect(sent).toHaveLength(1)
    const outbound = sent[0]!
    expect(outbound.url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL)
    expect(outbound.headers).toEqual({
      Authorization: `Bearer ${FAKE_KEY}`,
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(outbound.body)).toEqual({
      model: GEMMA_MODEL_ID,
      messages: [{ role: 'user', content: renderOutboundPrompt(request) }],
      temperature: 0.2,
    })
    // 키는 본문과 결과 어디에도 없다 (T-30)
    expect(outbound.body).not.toContain(FAKE_KEY)
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    expect(model.modelId).toBe(GEMMA_MODEL_ID)
    expect(model.promptVersion).toBe(QUICK_REVIEW_PROMPT.version)
  })

  it('대상 문단과 앞뒤 문맥만 보내고, 나머지 문단과 내부 식별자는 보내지 않는다 (T-29)', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const { request, texts } = sampleRequest()

    await model.review(request)
    const body = sent[0]!.body

    // 대상(3번)과 문맥(2번, 4번)만 나간다
    for (const sentText of [texts[1]!, texts[2]!, texts[3]!]) expect(body).toContain(sentText)
    for (const kept of [texts[0]!, texts[4]!]) expect(body).not.toContain(kept)

    for (const internal of [
      'req-internal-id',
      'version-internal-id',
      'doc-1',
      'rubric-1',
      request.rubric.rubricVersion,
      ...request.targets.map((t) => t.paragraphId),
      ...request.context.map((c) => c.paragraphId),
    ]) {
      expect(body).not.toContain(internal)
    }

    const payload = toModelPayload(request)
    expect(payload.paragraphs.map((p) => [p.id, p.role])).toEqual([
      ['C1', 'context'],
      ['P1', 'target'],
      ['C2', 'context'],
    ])
  })
})

describe('고정 응답을 공통 스키마로 검증한다', () => {
  it('성공 응답의 글이 검증을 통과해 대상 문단에 연결된다', async () => {
    const { transport } = fixedTransport(() => completion('```json\n' + MODEL_OUTPUT + '\n```'))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const { request } = sampleRequest()

    const call = await model.review(request)
    if (!call.ok) throw new Error(call.message)
    let n = 0
    const validated = validateModelOutput(
      request,
      call.text,
      { modelId: model.modelId, promptVersion: model.promptVersion },
      () => `item-${(n += 1)}`,
    )
    if (!validated.ok) throw new Error(validated.problems.join())

    expect(validated.response.modelId).toBe(GEMMA_MODEL_ID)
    expect(validated.response.items).toEqual([
      expect.objectContaining({
        paragraphId: request.targets[0]!.paragraphId,
        stage: 'question',
        severity: 4,
        appliedRubricItemIds: ['rubric-1'],
      }),
    ])
  })
})

describe('부를 수 없거나 실패하면 결과로 알린다', () => {
  it('키가 등록되지 않았으면 전송하지 않는다', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const model = createOpenRouterGemma({ secrets: memorySecrets({}), transport })

    expect(await model.checkAvailability()).toMatchObject({ available: false, reason: 'no-key' })
    const result = await model.review(sampleRequest().request)
    expect(result).toMatchObject({ ok: false, reason: 'no-key' })
    expect(result.ok === false && result.message).toContain('설정에서 키를 등록')
    expect(sent).toEqual([])
  })

  it('키체인을 읽지 못하면 전송하지 않고 알린다', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const secrets: SecretStore = {
      get: () => Promise.reject(new Error('키체인이 잠겨 있습니다')),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }
    const model = createOpenRouterGemma({ secrets, transport })

    expect(await model.checkAvailability()).toMatchObject({ available: false, reason: 'keychain-error' })
    expect(await model.review(sampleRequest().request)).toMatchObject({ ok: false, reason: 'keychain-error' })
    expect(sent).toEqual([])
  })

  it.each([
    [401, 'unauthorized', '키가 거절'],
    [403, 'unauthorized', '키가 거절'],
    [402, 'payment-required', '크레딧'],
    [408, 'timeout', '제때 응답하지'],
    [429, 'rate-limited', '잠시 뒤'],
    [500, 'server-error', 'HTTP 500'],
    [503, 'server-error', 'HTTP 503'],
    [400, 'rejected', 'HTTP 400'],
    [404, 'rejected', 'HTTP 404'],
  ])('HTTP %i → %s', async (status, reason, phrase) => {
    const { transport } = fixedTransport(() => errorResponse(status, '서비스 안내 문구'))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })

    const result = await model.review(sampleRequest().request)
    expect(result).toMatchObject({ ok: false, reason })
    if (result.ok) return
    expect(result.message).toContain(phrase)
    expect(result.message).toContain('서비스 안내 문구')
    expect(result.message).not.toContain(FAKE_KEY)
  })

  it('서비스 안내 문구가 길면 잘라서 옮긴다', async () => {
    const { transport } = fixedTransport(() => errorResponse(400, '가'.repeat(1000)))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const result = await model.review(sampleRequest().request)
    expect(result.ok === false && result.message.length).toBeLessThan(400)
  })

  it('연결 실패와 시간 초과를 구별해 알린다', async () => {
    const network = createOpenRouterGemma({
      secrets: memorySecrets(),
      transport: () => Promise.reject(new TypeError('fetch failed')),
    })
    expect(await network.review(sampleRequest().request)).toMatchObject({ ok: false, reason: 'network' })

    const timeout = createOpenRouterGemma({
      secrets: memorySecrets(),
      transport: () => Promise.reject(new DOMException('시간 초과', 'TimeoutError')),
    })
    expect(await timeout.review(sampleRequest().request)).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it.each([
    ['JSON 이 아닌 본문', { status: 200, body: '<html>게이트웨이</html>' }],
    ['choices 없음', { status: 200, body: JSON.stringify({ id: 'x' }) }],
    ['content 가 문자열이 아님', { status: 200, body: JSON.stringify({ choices: [{ message: { content: null } }] }) }],
  ])('성공 코드인데 모델의 글을 꺼낼 수 없으면 malformed (%s)', async (_label, response) => {
    const { transport } = fixedTransport(() => response)
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    expect(await model.review(sampleRequest().request)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('성공 코드로 오류를 알리면 그 안내를 결과로 쓰지 않는다', async () => {
    const { transport } = fixedTransport(() => ({
      status: 200,
      body: JSON.stringify({ error: { code: 502, message: '제공자 오류' } }),
    }))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    expect(await model.review(sampleRequest().request)).toMatchObject({ ok: false, reason: 'server-error' })
  })
})

describe('프롬프트 템플릿 (버전 관리)', () => {
  it('같은 문단의 다른 문장을 고르면 외부로 보내는 프롬프트가 달라진다', () => {
    const { request } = sampleRequest()
    const target = request.targets[0]!
    const first = { ...request, scope: 'sentence' as const,
      targets: [{ ...target, sentenceRef: { index: 0, text: '첫 번째 문장입니다.' } }] }
    const second = { ...request, scope: 'sentence' as const,
      targets: [{ ...target, sentenceRef: { index: 1, text: '두 번째 문장입니다.' } }] }
    expect(toModelPayload(first).paragraphs.find((paragraph) => paragraph.role === 'target')?.sentenceRef)
      .toEqual(first.targets[0]!.sentenceRef)
    expect(renderOutboundPrompt(first)).not.toBe(renderOutboundPrompt(second))
    expect(renderOutboundPrompt(second)).toContain('두 번째 문장입니다.')
  })
  it('평가 지침 없이 문서 종류를 싣는 현재 판은 quick-review.v4 이다 ([Q-48])', () => {
    expect(QUICK_REVIEW_PROMPT.version).toBe('quick-review.v4')
    expect(QUICK_REVIEW_V1.version).toBe('quick-review.v1')
  })

  it('현재 4판도 판을 올리지 않고 글을 고치면 실패한다 ([Q-48])', () => {
    const rendered = (['question', 'weak_hint', 'strong_hint', 'explanation', 'example'] as const)
      .flatMap((stage) => {
        const payload = toModelPayload(sampleRequest(stage).request)
        return [QUICK_REVIEW_PROMPT.render(payload), QUICK_REVIEW_PROMPT.render({ ...payload, document: { kind: '실험 보고서' } })]
      })
      .join('\n\u001f\n')
    expect(createHash('sha256').update(rendered).digest('hex')).toBe('15ff57bafd2984550420d9d37e753601bbf45446eecf84db4231bec7fff4a50f')
  })

  it('3판도 판을 올리지 않고 글을 고치면 실패한다', () => {
    const rendered = (['question', 'weak_hint', 'strong_hint', 'explanation', 'example'] as const)
      .map((stage) => QUICK_REVIEW_V3.render(toModelPayload(sampleRequest(stage).request)))
      .join('\n\u001f\n')
    expect(createHash('sha256').update(rendered).digest('hex')).toBe('b404eae56a4abc57662d8eba6658181a6f680dde34699aa79cb92a50413001ce')
  })

  it('판을 올리지 않고 글을 고치면 실패한다', () => {
    // 이 해시가 바뀌었다면 prompts/quick-review.v2.ts 를 새로 만들고 QUICK_REVIEW_PROMPT 를 옮긴 뒤,
    // 새 판의 해시를 새 테스트로 고정한다. 판 이름은 캐시 키의 일부다 (CLAUDE.md §5).
    const rendered = (['question', 'weak_hint', 'strong_hint', 'explanation', 'example'] as const)
      .map((stage) => QUICK_REVIEW_V1.render(toModelPayload(sampleRequest(stage).request)))
      .join('\n\n')
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(QUICK_REVIEW_V1_HASH)
  })

  it('예시 단계가 아니면 예시를 쓰지 말라고 하고, 예시 단계에서만 example 필드를 요구한다', () => {
    const question = renderOutboundPrompt(sampleRequest('question').request)
    expect(question).toContain('수정 예시는 쓰지 않습니다')
    expect(question).not.toContain('"example":')

    const example = renderOutboundPrompt(sampleRequest('example').request)
    expect(example).toContain('명시적으로 요청')
    expect(example).toContain('"example":')
  })
})

/** quick-review.v1 의 다섯 단계 출력 해시. 위 테스트의 설명을 따라서만 바꾼다 */
const QUICK_REVIEW_V1_HASH = '500793c11e170293d768bc1513ea32300560445a3511c9b9d099171dfc95140a'

// ---------------------------------------------------------------------------
// 코드 구조
// ---------------------------------------------------------------------------

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/** 주석을 걷어 낸 코드. 설명 속 낱말까지 잡히면 오탐이다. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function rel(file: string): string {
  return relative(join(SRC, '..'), file).split(sep).join('/')
}

/**
 * 그림도 같은 한 지점으로만 나간다 ([Q-38]).
 * 실제 요청 본문을 들여다봐서, 그림이 **요청의 그림 부분**으로 가고 프롬프트 글에는 없는지 본다.
 */
describe('그림은 요청의 그림 부분으로 나간다 (T-29)', () => {
  it('실제 요청 본문에 image_url 로 실리고, 프롬프트 글에는 base64 가 없다', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const { request } = sampleRequest()
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])

    await model.review({ ...request, images: [{ alias: 'G1', mimeType: 'image/jpeg', bytes }] })
    const body = JSON.parse(sent[0]!.body) as {
      messages: { content: ({ type: string; text?: string; image_url?: { url: string } })[] }[]
    }
    const parts = body.messages[0]!.content
    expect(Array.isArray(parts)).toBe(true)
    const text = parts.find(part => part.type === 'text')!.text!
    const picture = parts.find(part => part.type === 'image_url')!.image_url!.url

    // 그림은 data URI 로, 글에는 그 base64 가 없다.
    expect(picture.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(picture).toContain(Buffer.from(bytes).toString('base64'))
    expect(text).not.toContain(Buffer.from(bytes).toString('base64'))
    expect(text).toContain('G1')
  })

  it('그림이 없으면 예전처럼 문자열 하나로 보낸다', async () => {
    const { transport, sent } = fixedTransport(() => completion(MODEL_OUTPUT))
    const model = createOpenRouterGemma({ secrets: memorySecrets(), transport })
    const { request } = sampleRequest()

    await model.review(request)
    const body = JSON.parse(sent[0]!.body) as { messages: { content: unknown }[] }
    expect(typeof body.messages[0]!.content).toBe('string')
  })
})

describe('외부 전송 지점은 한 곳이다 (T-29)', () => {
  const OUTBOUND = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bsendBeacon\b/,
    /\bnet\.request\b/,
    /\bnet\.fetch\b/,
    /\bhttps?\.(request|get)\b/,
    /from\s+['"](node:)?(https?|http2|net|tls|dgram|undici)['"]/,
    // www.w3.org 는 제외한다. `http://www.w3.org/2000/svg` 는 XML 이름 공간 **식별자**이고
    // (인라인 SVG 를 그릴 때 createElementNS 에 넘긴다) 내려받는 주소가 아니다.
    /https?:\/\/(?!localhost|www\.w3\.org\/)[a-z0-9.-]+\.[a-z]{2,}/i,
  ]

  it('네트워크로 나가는 코드는 openrouter-gemma.ts 에만 있다', () => {
    const offenders = sourcesUnder(SRC)
      .filter((file) => OUTBOUND.some((pattern) => pattern.test(code(file))))
      .map(rel)
    expect(offenders).toEqual(['src/adapters/model/openrouter-gemma.ts'])
  })

  it('그 파일 안에서도 fetch 는 한 번만 부른다', () => {
    const source = code(join(SRC, 'adapters', 'model', 'openrouter-gemma.ts'))
    expect(source.match(/\bfetch\s*\(/g)).toHaveLength(1)
  })
})

describe('모델 어댑터는 저장소를 모른다 (T-11)', () => {
  it('adapters/model 이 저장소·파일 쓰기·DB 를 import 하지 않는다', () => {
    const offenders = sourcesUnder(join(SRC, 'adapters', 'model'))
      .filter((file) => /from\s+['"](\.\.\/repo|better-sqlite3|(node:)?fs(\/promises)?)['"/]/.test(code(file)))
      .map(rel)
    expect(offenders).toEqual([])
  })
})
