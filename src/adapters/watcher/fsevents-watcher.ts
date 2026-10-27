/**
 * 저장 감지 — macOS FSEvents 기반.
 *
 * **근거는 관찰이다.** `docs/V1-hwpx-저장동작.md` 에 기록한 한글 for Mac 12.30 의 저장 순서:
 *
 * ```
 * <파일명>.BAK 생성 → 원본을 제자리에서 8,192바이트로 truncate → 약 20ms 뒤 재작성 → .BAK 삭제
 * ```
 *
 * 여기서 나오는 요구사항 다섯 가지를 그대로 구현한다 (같은 문서 §3).
 *
 * 1. 파일 이름 비교는 **NFC 정규화 후에** 한다 (`filename.ts`).
 * 2. 변경 이벤트를 받자마자 읽지 않는다. **크기·mtime 이 조용해질 때까지 기다린다.**
 * 3. 읽기 전에 ZIP·mimetype 으로 **온전한지 확인**하고, 실패하면 잠시 뒤 다시 시도한다.
 *    한 번 실패했다고 "문서가 깨졌다"고 알리지 않는다.
 * 4. `.BAK` 같은 대상 외 파일은 무시한다.
 * 5. **경로**를 기준으로 본다. inode 는 추적 근거가 아니다(관찰상 유지되지만 믿지 않는다).
 *
 * macOS 에서 디렉터리를 `fs.watch` 하면 FSEvents 를 쓴다. 파일 하나가 아니라 **폴더**를 보는
 * 이유는, 파일이 지워지거나 이름이 바뀌는 순간까지 함께 봐야 경로 유실을 알 수 있기 때문이다.
 * FSEvents 가 이벤트를 흘리는 경우를 대비해 느린 주기의 stat 확인을 안전망으로 둔다.
 */
import { watch as fsWatch, statSync, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { checkHwpxIntact } from '../hwpx/integrity.js'

import { sameFilename, toNfc } from './filename.js'
import { classifyPath } from './path-status.js'
import type { FileWatcher, WatchEvent } from './index.js'

export interface WatchOptions {
  /**
   * 크기·mtime 이 이만큼 조용해야 저장이 끝났다고 본다.
   * 관찰된 truncate→재작성 간격이 20ms 이므로 그보다 넉넉히 크게 잡는다.
   */
  quietPeriodMs?: number
  /** 온전성 확인 재시도 횟수 */
  integrityRetries?: number
  /** 온전성 확인 재시도 간격 */
  integrityRetryMs?: number
  /** 파일이 잠깐 사라져 보일 때 이만큼은 기다렸다가 경로 유실로 판정한다 */
  missingGraceMs?: number
  /** FSEvents 가 이벤트를 흘렸을 때를 대비한 안전망 주기 */
  safetyPollMs?: number
}

const DEFAULTS = {
  quietPeriodMs: 300,
  integrityRetries: 20,
  integrityRetryMs: 100,
  missingGraceMs: 1000,
  safetyPollMs: 2000,
} as const

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 파일의 상태 지문. **inode 를 넣지 않는다** (`CLAUDE.md` §3).
 * 크기와 mtime 만으로 "새로 저장되었는가"를 판정한다.
 */
function signatureOf(absolutePath: string): string | null {
  try {
    const stats = statSync(absolutePath)
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

class WatchSession {
  private readonly absolutePath: string
  private readonly onEvent: (event: WatchEvent) => void
  private readonly directory: string
  private readonly targetName: string
  private readonly options: Required<WatchOptions>

  private watcher: FSWatcher | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null

  private stopped = false
  private settling = false
  private rerun = false
  private lastSignature: string | null

  constructor(
    absolutePath: string,
    onEvent: (event: WatchEvent) => void,
    options: Required<WatchOptions>,
  ) {
    this.absolutePath = absolutePath
    this.onEvent = onEvent
    this.directory = dirname(absolutePath)
    this.targetName = toNfc(basename(absolutePath))
    this.options = options
    this.lastSignature = signatureOf(absolutePath)
  }

  start(): void {
    this.watcher = fsWatch(this.directory, { persistent: true }, (_type, filename) => {
      // filename 이 없으면 무엇이 바뀌었는지 모른다. 확인은 settle 이 한다.
      if (filename !== null && filename !== undefined) {
        // .BAK 을 비롯한 대상 외 파일은 여기서 걸러진다 (V-1 §2.3).
        if (!sameFilename(String(filename), this.targetName)) return
      }
      this.schedule()
    })

    this.watcher.on('error', () => {
      // 폴더 자체가 사라진 경우까지 포함한다. 판정은 settle 에 맡긴다.
      this.schedule()
    })

    this.poller = setInterval(() => {
      if (signatureOf(this.absolutePath) !== this.lastSignature) this.schedule()
    }, this.options.safetyPollMs)
  }

  stop(): void {
    this.stopped = true
    if (this.debounce !== null) clearTimeout(this.debounce)
    if (this.poller !== null) clearInterval(this.poller)
    this.watcher?.close()
    this.debounce = null
    this.poller = null
    this.watcher = null
  }

  /** 이벤트가 몰려 들어와도 마지막 하나만 살아남는다 (디바운스). */
  private schedule(): void {
    if (this.stopped) return
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.settle()
    }, this.options.quietPeriodMs)
  }

  private async settle(): Promise<void> {
    if (this.settling) {
      this.rerun = true
      return
    }
    this.settling = true
    try {
      do {
        this.rerun = false
        await this.run()
      } while (this.rerun && !this.stopped)
    } finally {
      this.settling = false
    }
  }

  private async run(): Promise<void> {
    const stable = await this.waitUntilStable()
    if (stable === null || this.stopped) return

    // 이미 알린 상태 그대로라면 아무 일도 없었던 것이다. saved 를 두 번 내지 않는다.
    if (stable === this.lastSignature) return

    for (let attempt = 0; attempt < this.options.integrityRetries; attempt += 1) {
      const result = checkHwpxIntact(this.absolutePath)
      if (result.ok) {
        this.lastSignature = stable
        this.onEvent({ kind: 'saved', path: this.absolutePath, byteSize: result.byteSize })
        return
      }
      await delay(this.options.integrityRetryMs)
      if (this.stopped) return
      if (signatureOf(this.absolutePath) !== stable) {
        // 저장이 계속되고 있다. 처음부터 다시 본다.
        this.rerun = true
        return
      }
    }

    this.onEvent({
      kind: 'unreadable',
      path: this.absolutePath,
      message:
        '저장이 끝나기를 기다렸지만 문서를 온전히 읽지 못했습니다. ' +
        '한글에서 저장이 끝난 뒤 다시 시도해 주세요.',
    })
  }

  /**
   * 크기·mtime 이 조용해질 때까지 기다린다.
   * 파일이 사라진 것으로 보이면 유예 시간만큼 더 기다렸다가 경로 유실로 판정한다.
   *
   * @returns 안정된 지문. 경로를 잃었거나 감시가 멈췄으면 null
   */
  private async waitUntilStable(): Promise<string | null> {
    let previous = signatureOf(this.absolutePath)

    for (;;) {
      if (this.stopped) return null

      if (previous === null) {
        const recovered = await this.waitForReturn()
        if (recovered === null) return null
        previous = recovered
        continue
      }

      await delay(this.options.quietPeriodMs)
      if (this.stopped) return null

      const current = signatureOf(this.absolutePath)
      if (current === null) {
        previous = null
        continue
      }
      if (current === previous) return current
      previous = current
    }
  }

  /**
   * 사라진 것처럼 보이는 파일을 유예 시간 동안 기다린다.
   * 돌아오지 않으면 `path-lost` 를 내고 감시를 멈춘다. 임의의 다른 파일로 옮겨 붙지 않는다.
   */
  private async waitForReturn(): Promise<string | null> {
    const deadline = Date.now() + this.options.missingGraceMs

    while (Date.now() < deadline) {
      await delay(this.options.integrityRetryMs)
      if (this.stopped) return null
      const signature = signatureOf(this.absolutePath)
      if (signature !== null) return signature
    }

    const status = classifyPath(this.absolutePath)
    this.stop()
    this.onEvent({
      kind: 'path-lost',
      path: this.absolutePath,
      reason: status.kind === 'icloud-not-downloaded' ? 'icloud-not-downloaded' : 'missing',
      message:
        status.kind === 'icloud-not-downloaded'
          ? status.message
          : '문서 경로를 찾을 수 없습니다. 다른 이름이나 다른 폴더로 저장했다면 ' +
            '문서를 다시 선택해 주세요.',
    })
    return null
  }
}

export class WatchTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WatchTargetError'
  }
}

/** FSEvents 기반 감시자를 만든다. */
export function createFileWatcher(options: WatchOptions = {}): FileWatcher {
  const resolved: Required<WatchOptions> = { ...DEFAULTS, ...options }

  return {
    watch(absolutePath: string, onEvent: (event: WatchEvent) => void): Promise<() => void> {
      const status = classifyPath(absolutePath)
      if (status.kind !== 'ok') {
        return Promise.reject(new WatchTargetError(status.message))
      }

      const session = new WatchSession(absolutePath, onEvent, resolved)
      session.start()
      return Promise.resolve(() => session.stop())
    },
  }
}
