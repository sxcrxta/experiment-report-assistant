/**
 * 4단계 — 키체인 보관과 키 등록 (PRD 5절).
 *
 * T-30 API 키가 저장소·설정 평문·빌드 산출물에 포함되지 않고, 키체인에만 존재한다.
 *      - 키체인 어댑터는 키를 명령 인자에 싣지 않는다 (stdin 으로만 지나간다)
 *      - 설정 화면으로 키가 되돌아가지 않는다
 *      - DB 스키마·렌더러 저장소·빌드 설정에 키 자리가 없다
 *      - 저장소와 빌드 산출물(out/)에 실제 키 모양의 문자열이 없다
 * T-33 오프라인·키 미등록이면 설정 화면이 AI 검토 요청이 막혔다는 사실과 이유를 보여 준다.
 *
 * 실제 `/usr/bin/security` 는 부르지 않는다. 설명서로 확인한 인자 모양대로 부르는지 가짜 실행기로 본다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ReviewModel } from '../src/adapters/model/index.js'
import type { ClaudeCliStatus } from '../src/adapters/model/claude-path.js'
import { SECRET_KEYS, type SecretStore } from '../src/adapters/secret/index.js'
import {
  createKeychainSecretStore,
  KEYCHAIN_SERVICE,
  KeychainError,
  type CommandResult,
  type SecurityRunner,
} from '../src/adapters/secret/keychain.js'
import { OFFLINE_MESSAGE } from '../src/app/review-request.js'
import { CONTEXT_RADIUS } from '../src/core/diff/context.js'
import type { ConfirmRequest } from '../src/main/document-ipc.js'
import { createSettingsHandlers, parseOpenRouterKeyInput } from '../src/main/settings-ipc.js'

const ROOT = join(import.meta.dirname, '..')

/** 가짜 키. 실제 키 모양(sk-or-v1- 뒤 64자리 16진수)이 아니다 */
const FAKE_KEY = 'sk-or-v1-fixture-0123'

interface Call {
  args: readonly string[]
  stdin: string | null
}

/**
 * 설명서의 인자 모양을 흉내 내는 가짜 security.
 * `-i` 로 들어온 stdin 의 한 줄 명령은 공백으로 나눠 읽는다.
 */
function fakeSecurity(options: { failAdd?: boolean; failDelete?: boolean; stderr?: string } = {}): {
  run: SecurityRunner
  calls: Call[]
  items: Map<string, string>
} {
  const items = new Map<string, string>()
  const calls: Call[] = []
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
  const notFound: CommandResult = { code: 1, stdout: '', stderr: '항목을 찾을 수 없습니다' }

  function option(args: readonly string[], flag: string): string | undefined {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }

  function execute(args: readonly string[]): CommandResult {
    const account = option(args, '-a')
    const service = option(args, '-s')
    const id = `${service}/${account}`
    switch (args[0]) {
      case 'find-generic-password': {
        const value = items.get(id)
        return value === undefined ? notFound : ok(`${value}\n`)
      }
      case 'add-generic-password': {
        if (options.failAdd === true) return { code: 1, stdout: '', stderr: options.stderr ?? '' }
        if (items.has(id) && !args.includes('-U')) return { code: 1, stdout: '', stderr: '이미 있습니다' }
        items.set(id, option(args, '-w') ?? '')
        return ok()
      }
      case 'delete-generic-password': {
        if (options.failDelete === true) return { code: 1, stdout: '', stderr: '지울 수 없습니다' }
        return items.delete(id) ? ok() : notFound
      }
      default:
        return { code: 2, stdout: '', stderr: '알 수 없는 명령' }
    }
  }

  const run: SecurityRunner = (args, stdin) => {
    calls.push({ args: [...args], stdin })
    if (args[0] === '-i') {
      // 대화형 모드: 종료 코드가 명령 결과를 뜻한다고 가정하지 않는다. 늘 0 으로 끝낸다.
      const result = execute((stdin ?? '').trim().split(/\s+/))
      return Promise.resolve({ code: 0, stdout: '', stderr: result.stderr })
    }
    return Promise.resolve(execute(args))
  }

  return { run, calls, items }
}

describe('키체인 어댑터', () => {
  it('설명서에 있는 인자로 넣고 읽는다. 키는 명령 인자에 실리지 않는다 (T-30)', async () => {
    const security = fakeSecurity()
    const store = createKeychainSecretStore({ run: security.run })

    await store.set(SECRET_KEYS.openRouter, FAKE_KEY)
    expect(await store.get(SECRET_KEYS.openRouter)).toBe(FAKE_KEY)

    expect(security.calls[0]).toEqual({
      args: ['-i'],
      stdin: `add-generic-password -a ${SECRET_KEYS.openRouter} -s ${KEYCHAIN_SERVICE} -w ${FAKE_KEY} -U\n`,
    })
    expect(security.calls[1]).toEqual({
      args: ['find-generic-password', '-a', SECRET_KEYS.openRouter, '-s', KEYCHAIN_SERVICE, '-w'],
      stdin: null,
    })
    for (const call of security.calls) expect(call.args.join(' ')).not.toContain(FAKE_KEY)
  })

  it('넣은 뒤 다시 읽어 같은지 확인한다. 다르면 실패로 알리고, 오류 출력 속 키는 가린다', async () => {
    const security = fakeSecurity({ failAdd: true, stderr: `add-generic-password -w ${FAKE_KEY}: 거절됨` })
    const warnings: string[] = []
    const store = createKeychainSecretStore({ run: security.run, warn: (m) => warnings.push(m) })

    const error = await store.set(SECRET_KEYS.openRouter, FAKE_KEY).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(KeychainError)
    expect((error as Error).message).toContain('저장하지 못했습니다')
    expect((error as Error).message).not.toContain(FAKE_KEY)
    expect(warnings.join()).not.toContain(FAKE_KEY)
  })

  it('한 줄 명령의 뜻을 바꿀 수 있는 문자가 든 값은 실행하지 않고 거절한다', async () => {
    const security = fakeSecurity()
    const store = createKeychainSecretStore({ run: security.run })
    for (const value of ['', 'a b', 'a"b', "a'b", 'a\nb', 'a;b', 'a\\b', '키']) {
      await expect(store.set(SECRET_KEYS.openRouter, value)).rejects.toThrow(KeychainError)
    }
    expect(security.calls).toEqual([])
  })

  it('없는 항목을 읽으면 null 이고, 오류 출력은 경고로 남긴다', async () => {
    const security = fakeSecurity()
    const warnings: string[] = []
    const store = createKeychainSecretStore({ run: security.run, warn: (m) => warnings.push(m) })

    expect(await store.get(SECRET_KEYS.openRouter)).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('항목을 찾을 수 없습니다')
  })

  it('지우기: 지우면 없어지고, 이미 없어도 성공이며, 남아 있으면 실패로 알린다', async () => {
    const security = fakeSecurity()
    const store = createKeychainSecretStore({ run: security.run, warn: () => {} })
    await store.set(SECRET_KEYS.openRouter, FAKE_KEY)

    await store.delete(SECRET_KEYS.openRouter)
    // delete 가 한 번에 성공하면 그것이 마지막 호출이다.
    // (set 은 저장 후 확인까지 두 번 부르므로 at(-2) 는 set 의 확인 호출이다)
    expect(security.calls.at(-1)?.args).toEqual([
      'delete-generic-password',
      '-a',
      SECRET_KEYS.openRouter,
      '-s',
      KEYCHAIN_SERVICE,
    ])
    expect(await store.get(SECRET_KEYS.openRouter)).toBeNull()
    await expect(store.delete(SECRET_KEYS.openRouter)).resolves.toBeUndefined()

    const stuck = fakeSecurity({ failDelete: true })
    const stuckStore = createKeychainSecretStore({ run: stuck.run, warn: () => {} })
    await stuckStore.set(SECRET_KEYS.openRouter, FAKE_KEY)
    await expect(stuckStore.delete(SECRET_KEYS.openRouter)).rejects.toThrow('지우지 못했습니다')
  })

  it('security 를 실행하지 못하면 예외가 그대로 드러난다', async () => {
    const store = createKeychainSecretStore({ run: () => Promise.reject(new Error('spawn ENOENT')) })
    await expect(store.get(SECRET_KEYS.openRouter)).rejects.toThrow('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// 설정 화면 IPC
// ---------------------------------------------------------------------------

function memorySecrets(): SecretStore & { values: Map<string, string>; setCalls: number } {
  const values = new Map<string, string>()
  const store = {
    values,
    setCalls: 0,
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    set: (key: string, value: string) => {
      store.setCalls += 1
      values.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
  return store
}

/** 심층 검토 어댑터 자리. 이 화면은 부르지 않는다 */
function deepModelStub(): ReviewModel {
  return {
    modelId: 'test/claude',
    promptVersion: 'deep-review.v1',
    checkAvailability: () =>
      Promise.resolve({ available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.' }),
    review: () => Promise.reject(new Error('설정 화면은 모델을 부르지 않는다')),
  }
}

/** Claude 모드 감지 자리. 저장한 경로와 다시 확인한 횟수를 기억한다 */
function claudeStub(): {
  status: () => Promise<ClaudeCliStatus>
  recheck: () => Promise<ClaudeCliStatus>
  setPath: (path: string) => void
  clearPath: () => void
  saved: string | null
  rechecks: number
} {
  const state = {
    saved: null as string | null,
    rechecks: 0,
    status: () => Promise.resolve(current()),
    recheck: () => {
      state.rechecks += 1
      return Promise.resolve(current())
    },
    setPath: (path: string) => {
      state.saved = path
    },
    clearPath: () => {
      state.saved = null
    },
  }
  const current = (): ClaudeCliStatus => ({
    state: 'not-installed',
    path: state.saved,
    version: null,
    message: 'Claude Code 를 찾지 못했습니다.',
    fromOverride: state.saved !== null,
  })
  return state
}

/** 키가 있으면 쓸 수 있다고 답하는 모델. 부르지는 않는다 */
function modelFor(secrets: SecretStore): ReviewModel {
  return {
    modelId: 'test/gemma',
    promptVersion: 'quick-review.v1',
    checkAvailability: async () =>
      (await secrets.get(SECRET_KEYS.openRouter)) === null
        ? { available: false, reason: 'no-key', message: 'OpenRouter 키가 등록되지 않았습니다.' }
        : { available: true },
    review: () => Promise.reject(new Error('설정 화면은 모델을 부르지 않는다')),
  }
}

function settingsHarness(options: { online?: boolean; answer?: boolean } = {}): {
  handlers: ReturnType<typeof createSettingsHandlers>
  secrets: ReturnType<typeof memorySecrets>
  confirms: ConfirmRequest[]
  claude: ReturnType<typeof claudeStub>
} {
  const secrets = memorySecrets()
  const confirms: ConfirmRequest[] = []
  const claude = claudeStub()
  const handlers = createSettingsHandlers({
    secrets,
    online: { isOnline: () => options.online ?? true },
    models: { quick: modelFor(secrets), deep: deepModelStub() },
    claude,
    confirm: (request) => {
      confirms.push(request)
      return Promise.resolve(options.answer ?? true)
    },
  })
  return { handlers, secrets, confirms, claude }
}

describe('설정 화면 IPC — 키 등록', () => {
  it('키를 키체인에 넣고, 화면에는 등록됐다는 사실만 돌려준다 (T-30)', async () => {
    const h = settingsHarness()
    const result = await h.handlers.saveOpenRouterKey(`  ${FAKE_KEY}\n`)

    expect(result).toMatchObject({
      status: 'saved',
      settings: { keyStatus: 'registered', online: true, reviewAvailable: true, unavailableMessage: '' },
    })
    expect(h.secrets.values.get(SECRET_KEYS.openRouter)).toBe(FAKE_KEY)
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(await h.handlers.getAiSettings())).not.toContain(FAKE_KEY)
  })

  it('형식이 맞지 않는 키는 넣지 않고, 문구에 입력값을 옮기지 않는다', async () => {
    const h = settingsHarness()
    for (const bad of ['', '   ', `${FAKE_KEY} extra`, `"${FAKE_KEY}"`, 42, null, 'a'.repeat(513)]) {
      const result = await h.handlers.saveOpenRouterKey(bad)
      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    }
    expect(h.secrets.setCalls).toBe(0)
    expect(parseOpenRouterKeyInput(FAKE_KEY)).toEqual({ ok: true, key: FAKE_KEY })
  })

  it('키체인에 넣지 못하면 실패로 알린다', async () => {
    const h = settingsHarness()
    h.secrets.set = () => Promise.reject(new KeychainError('키체인이 잠겨 있습니다'))
    expect(await h.handlers.saveOpenRouterKey(FAKE_KEY)).toEqual({
      status: 'failed',
      message: '키를 키체인에 넣지 못했습니다: 키체인이 잠겨 있습니다',
    })
  })

  it('키 지우기는 확인을 받은 뒤에만 한다', async () => {
    const cancel = settingsHarness({ answer: false })
    await cancel.handlers.saveOpenRouterKey(FAKE_KEY)
    expect(await cancel.handlers.deleteOpenRouterKey()).toEqual({ status: 'canceled' })
    expect(cancel.confirms).toHaveLength(1)
    expect(cancel.secrets.values.has(SECRET_KEYS.openRouter)).toBe(true)

    const accept = settingsHarness({ answer: true })
    await accept.handlers.saveOpenRouterKey(FAKE_KEY)
    expect(await accept.handlers.deleteOpenRouterKey()).toMatchObject({
      status: 'deleted',
      settings: { keyStatus: 'missing', reviewAvailable: false },
    })
    expect(accept.secrets.values.has(SECRET_KEYS.openRouter)).toBe(false)
  })

  it('무엇이 외부로 나가는지 알린다', async () => {
    const result = await settingsHarness().handlers.getAiSettings()
    if (result.status !== 'ok') throw new Error(result.message)
    expect(result.settings.outboundNotice).toContain(`앞뒤 문단 ${CONTEXT_RADIUS}개씩`)
    expect(result.settings.outboundNotice).toContain('test/gemma')
    expect(result.settings.outboundNotice).toContain('문서 전체는 보내지 않습니다')
  })
})

describe('설정 화면 IPC — 검토 요청이 막힌 이유 (T-33)', () => {
  it('키가 없으면 AI 검토 요청만 막혔다고 알린다', async () => {
    const result = await settingsHarness().handlers.getAiSettings()
    expect(result).toMatchObject({
      status: 'ok',
      settings: { keyStatus: 'missing', online: true, reviewAvailable: false },
    })
    expect(result.status === 'ok' && result.settings.unavailableMessage).toContain('키가 등록되지 않았습니다')
  })

  it('오프라인이면 키가 있어도 막혔다고 알리고, 나머지 기능은 쓸 수 있다고 안내한다', async () => {
    const h = settingsHarness({ online: false })
    await h.handlers.saveOpenRouterKey(FAKE_KEY)
    const result = await h.handlers.getAiSettings()
    expect(result).toMatchObject({
      status: 'ok',
      settings: { keyStatus: 'registered', online: false, reviewAvailable: false, unavailableMessage: OFFLINE_MESSAGE },
    })
    expect(OFFLINE_MESSAGE).toContain('문서 등록·저장 감지·버전 기록')
  })

  it('Claude Code 를 못 찾아도 빠른 검토 설정은 그대로 보인다 (PRD 4.3)', async () => {
    const h = settingsHarness()
    await h.handlers.saveOpenRouterKey(FAKE_KEY)
    const result = await h.handlers.getAiSettings()
    if (result.status !== 'ok') throw new Error(result.message)

    expect(result.settings.reviewAvailable).toBe(true)
    expect(result.settings.claude).toMatchObject({
      state: 'not-installed', deepAvailable: false, fromOverride: false, modelId: 'test/claude',
    })
    expect(result.settings.claude.deepUnavailableMessage).toContain('찾지 못했습니다')
    // 무엇이 어디로 나가는지 두 경로 모두 적는다 (`CLAUDE.md` §4).
    expect(result.settings.outboundNotice).toContain('OpenRouter')
    expect(result.settings.outboundNotice).toContain('Claude Code')
  })

  it('사용자가 지정한 경로를 저장하고 곧바로 다시 확인한다', async () => {
    const h = settingsHarness()
    const result = await h.handlers.saveClaudeCliPath('/opt/claude')

    expect(result.status).toBe('ok')
    expect(h.claude.saved).toBe('/opt/claude')
    if (result.status !== 'ok') throw new Error(result.message)
    expect(result.settings.claude).toMatchObject({ path: '/opt/claude', fromOverride: true })
  })

  it('절대 경로가 아니면 저장하지 않는다', async () => {
    const h = settingsHarness()
    for (const bad of ['claude', './claude', '', '   ', 3, null, '/bin/claude\nrm -rf /']) {
      const result = await h.handlers.saveClaudeCliPath(bad)
      expect(result.status).toBe('failed')
    }
    expect(h.claude.saved).toBeNull()
  })

  it('지정한 경로를 지우면 자동 탐색으로 돌아간다', async () => {
    const h = settingsHarness()
    await h.handlers.saveClaudeCliPath('/opt/claude')
    const result = await h.handlers.clearClaudeCliPath()

    expect(h.claude.saved).toBeNull()
    if (result.status !== 'ok') throw new Error(result.message)
    expect(result.settings.claude.fromOverride).toBe(false)
  })

  it('다시 확인은 캐시를 버리고 묻는다', async () => {
    const h = settingsHarness()
    expect((await h.handlers.recheckClaudeMode()).status).toBe('ok')
  })

  it('키체인을 확인하지 못하면 그렇게 표시한다', async () => {
    const h = settingsHarness()
    h.secrets.get = () => Promise.reject(new Error('잠김'))
    const result = await h.handlers.getAiSettings().catch((cause: unknown) => cause)
    // 모델 쪽 확인도 같은 키체인을 읽으므로 실패가 드러나야 한다. 조용히 "등록 안 됨"으로 바꾸지 않는다.
    expect(result).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// 키가 저장소·설정·빌드 산출물에 없다 (T-30)
// ---------------------------------------------------------------------------

/** OpenRouter 키 모양. 가짜 키(FAKE_KEY)는 이 모양이 아니다 */
const REAL_KEY_SHAPE = /sk-or-v1-[0-9a-f]{32,}/i

/**
 * 훑지 않는 곳.
 * `release/` 는 묶은 `.app` 이다. 우리 코드는 이미 `out/` 으로 보고 있고,
 * 그 안은 Electron 프레임워크 300MB 와 심볼릭 링크 덩어리라 글로 읽을 것이 없다 ([Q-31]).
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'release'])
const BINARY = /\.(hwpx|hwp|png|jpe?g|gif|ico|icns|sqlite|db|node|dylib|zip)$/i

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    // 심볼릭 링크는 따라가지 않는다. 가리키는 것이 폴더면 읽다가 터진다.
    if (!entry.isFile()) return []
    if (BINARY.test(entry.name) || statSync(full).size > 5_000_000) return []
    return [full]
  })
}

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join('/')
}

describe('키는 키체인에만 있다 (T-30)', () => {
  it('저장소와 빌드 산출물(out/)에 실제 키 모양의 문자열이 없다', () => {
    const files = filesUnder(ROOT)
    expect(files.some((file) => rel(file).startsWith('src/'))).toBe(true)
    if (existsSync(join(ROOT, 'out'))) {
      expect(files.some((file) => rel(file).startsWith('out/'))).toBe(true)
    }
    const offenders = files.filter((file) => REAL_KEY_SHAPE.test(readFileSync(file, 'utf8'))).map(rel)
    expect(offenders).toEqual([])
  })

  it('DB 스키마에 키를 담을 자리가 없다', () => {
    const dir = join(ROOT, 'src', 'adapters', 'repo', 'migrations')
    const sql = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
      .replace(/--.*$/gm, '')
    expect(sql).not.toMatch(/api_?key|secret|password|credential|token/i)
  })

  it('렌더러는 브라우저 저장소를 쓰지 않는다. 키가 설정 파일처럼 남을 곳이 없다', () => {
    const offenders = filesUnder(join(ROOT, 'src', 'renderer'))
      .filter((file) => /localStorage|sessionStorage|indexedDB|document\.cookie/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('빌드 설정과 코드가 환경 변수로 키를 주입받지 않는다', () => {
    const files = [
      ...filesUnder(join(ROOT, 'src')),
      ...['electron.vite.config.ts', 'package.json'].map((name) => join(ROOT, name)),
    ]
    // 이름에 KEY 가 들어간 상수(예: OPENROUTER_KEY_MAX_LENGTH)는 키가 아니다.
    // 실제 위험은 환경 변수에서 비밀을 읽거나 키 리터럴을 박아 넣는 것이다.
    const envRead = /process\.env\s*(?:\.\s*[A-Za-z_]*|\[\s*['"][A-Za-z_]*)(KEY|TOKEN|SECRET|PASSWORD)/i
    const literalKey = /sk-or-[A-Za-z0-9]/
    const offenders = files
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return envRead.test(source) || literalKey.test(source)
      })
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('키체인 항목 이름을 쓰는 곳은 키체인·모델 어댑터·설정 IPC 뿐이다', () => {
    const users = filesUnder(join(ROOT, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('SECRET_KEYS.openRouter'))
      .map(rel)
      .sort()
    expect(users).toEqual(['src/adapters/model/openrouter-gemma.ts', 'src/main/settings-ipc.ts'])
  })
})
