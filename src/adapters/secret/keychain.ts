/**
 * macOS 키체인 보관 — `/usr/bin/security` 로 일반 암호 항목을 넣고 읽고 지운다.
 *
 * PRD 5절: "키는 macOS 키체인에 보관하고 프로그램 코드나 설정 파일에 넣지 않는다."
 * CLAUDE.md §4: API 키를 저장소·설정 파일 평문·배포 산출물에 넣지 않는다. 사용자 키는 macOS 키체인에 둔다.
 *
 * 쓰는 명령과 인자는 이 맥에 설치된 security(1) 설명서(/usr/share/man/man1/security.1)로 확인한 것만 쓴다.
 * - 넣기: `add-generic-password -a <계정> -s <서비스> -w <암호> -U` (-U: 이미 있으면 갱신)
 * - 읽기: `find-generic-password -a <계정> -s <서비스> -w` (-w: 암호만 출력)
 * - 지우기: `delete-generic-password -a <계정> -s <서비스>`
 *
 * 설명서가 정하지 않은 것에는 기대지 않는다.
 * - **키를 명령 인자에 싣지 않는다.** 인자는 다른 프로세스가 볼 수 있다. 넣기는 `security -i`(명령을 stdin 에서
 *   읽는 대화형 모드)로 보내 키가 stdin 으로만 지나가게 한다. 대화형 모드는 한 줄을 명령으로 읽으므로
 *   공백·따옴표 같은 문자가 들어간 값은 받지 않는다.
 * - 대화형 모드의 종료 코드가 명령의 성공을 뜻하는지 설명서에 없다. 그래서 넣은 뒤 **다시 읽어 같은지** 확인한다.
 * - "항목 없음"의 종료 코드도 설명서에 없다. 읽기가 실패하면 없거나 읽을 수 없는 것으로 보고 null 을 돌려주며,
 *   오류 출력은 경고로 남긴다 (조용히 삼키지 않는다).
 */
import { spawn } from 'node:child_process'

import type { SecretStore } from './index.js'

export const SECURITY_PATH = '/usr/bin/security'

/** 키체인 항목의 서비스 이름. 앱 식별자와 같다 (~/Library/Application Support/experiment-agent). */
export const KEYCHAIN_SERVICE = 'experiment-agent'

/** 키체인에 넣을 수 있는 값과 이름. `security -i` 가 한 줄 명령으로 읽어도 뜻이 바뀌지 않는 문자만. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/

export interface CommandResult {
  /** 종료 코드. 신호로 끝났으면 null */
  code: number | null
  stdout: string
  stderr: string
}

/** security 를 한 번 실행한다. stdin 에 넣을 글이 없으면 null. */
export type SecurityRunner = (args: readonly string[], stdin: string | null) => Promise<CommandResult>

export const runSecurity: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY_PATH, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })

export class KeychainError extends Error {
  override name = 'KeychainError'
}

export interface KeychainDeps {
  run?: SecurityRunner
  service?: string
  /** 읽기 실패 같은, 실패로 끝내지는 않지만 남겨야 하는 일 */
  warn?: (message: string) => void
}

/** 오류 출력에 값이 섞여 나올 수 있으므로 옮기기 전에 가린다. */
function redact(text: string, secret: string): string {
  return (secret === '' ? text : text.split(secret).join('[가림]')).trim()
}

export function isSafeKeychainValue(value: string): boolean {
  return SAFE_TOKEN.test(value)
}

export function createKeychainSecretStore(deps: KeychainDeps = {}): SecretStore {
  const { run = runSecurity, service = KEYCHAIN_SERVICE, warn = (message: string) => console.warn(message) } = deps

  function assertSafeName(name: string): void {
    if (!SAFE_TOKEN.test(name) || !SAFE_TOKEN.test(service)) {
      throw new KeychainError('키체인 항목 이름에 쓸 수 없는 문자가 있습니다.')
    }
  }

  async function get(name: string): Promise<string | null> {
    assertSafeName(name)
    const result = await run(['find-generic-password', '-a', name, '-s', service, '-w'], null)
    if (result.code !== 0) {
      const detail = result.stderr.trim()
      warn(`[keychain] ${name} 을(를) 읽지 못했습니다${detail === '' ? '' : `: ${detail}`}`)
      return null
    }
    // -w 는 암호만 한 줄로 출력한다. 줄 끝만 걷어 낸다.
    const value = result.stdout.replace(/\r?\n$/, '')
    return value === '' ? null : value
  }

  return {
    get,

    async set(name, value): Promise<void> {
      assertSafeName(name)
      if (!SAFE_TOKEN.test(value)) {
        throw new KeychainError('키체인에 넣을 수 없는 문자가 있습니다. 영문·숫자·-·_ 만 쓸 수 있습니다.')
      }

      const result = await run(['-i'], `add-generic-password -a ${name} -s ${service} -w ${value} -U\n`)
      const stored = await get(name)
      if (stored !== value) {
        const detail = redact(result.stderr, value)
        throw new KeychainError(
          `키체인에 저장하지 못했습니다${detail === '' ? '' : `: ${detail}`}`,
        )
      }
    },

    async delete(name): Promise<void> {
      assertSafeName(name)
      const result = await run(['delete-generic-password', '-a', name, '-s', service], null)
      if (result.code === 0) return
      // 지우기가 실패했어도 항목이 이미 없으면 지운 것과 같다. 남아 있으면 실패로 알린다.
      if ((await get(name)) === null) return
      throw new KeychainError(`키체인에서 지우지 못했습니다: ${result.stderr.trim()}`)
    },
  }
}
