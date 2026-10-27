/**
 * AI 검토 설정 — OpenRouter 키 등록 (PRD 5절).
 *
 * - 키는 macOS 키체인에만 들어간다. 이 화면은 키를 보내기만 하고 다시 받지 않는다.
 *   등록한 뒤에는 "등록됨"만 보이고, 입력칸은 바로 비운다.
 * - 오프라인이거나 키가 없으면 AI 검토 요청만 막힌다는 사실과 할 일을 보여 준다.
 * - 검토를 요청하면 외부로 무엇이 나가는지 함께 보여 준다 (`CLAUDE.md` §4).
 * - 심층 검토(Claude 모드)는 **선택**이다. 이 화면은 찾았는지·로그인되었는지만 알려 주고,
 *   못 찾았으면 실행 파일 경로를 직접 지정할 수 있게 한다 (PRD 4.3·5절, [Q-30]).
 *
 * 파일·네트워크에 직접 닿지 않는다. window.agent (preload 브리지)만 쓴다.
 */
import {
  CLAUDE_CLI_PATH_MAX_LENGTH,
  OPENROUTER_KEY_MAX_LENGTH,
  type AiSettingsView,
  type ClaudeModeView,
} from '../../../shared/ipc.js'

export interface SettingsOptions {
  /** 설정을 그릴 자리 */
  container: HTMLElement
  /** 화면 위쪽 안내 문구를 바꾼다 */
  notify: (message: string) => void
  onSettingsChanged?: (settings: AiSettingsView) => void
}

const KEY_STATUS_TEXT: Readonly<Record<AiSettingsView['keyStatus'], string>> = {
  registered: '등록됨',
  missing: '없음',
  unreadable: '키체인을 확인하지 못함',
}

const CLAUDE_STATE_TEXT: Readonly<Record<ClaudeModeView['state'], string>> = {
  ready: '사용 가능',
  'not-installed': '찾지 못함',
  'not-logged-in': '로그인 필요',
  error: '확인 실패',
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className !== undefined) node.className = className
  return node
}

function button(text: string, action: () => void, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const node = el('button', text)
  node.type = type
  if (type === 'button') node.addEventListener('click', action)
  return node
}

function render(options: SettingsOptions, settings: AiSettingsView): void {
  const { container, notify } = options

  const form = document.createElement('form')
  form.className = 'inline-form'
  const input = document.createElement('input')
  input.type = 'password'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.maxLength = OPENROUTER_KEY_MAX_LENGTH
  input.placeholder = 'OpenRouter API 키'
  input.required = true
  input.setAttribute('aria-label', 'OpenRouter API 키')
  form.append(input, button(settings.keyStatus === 'registered' ? '키 바꾸기' : '키 등록', () => undefined, 'submit'))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const key = input.value
    // 보낸 뒤에는 화면에 남기지 않는다.
    input.value = ''
    void (async () => {
      const result = await window.agent.saveOpenRouterKey(key)
      if (result.status === 'failed') {
        notify(result.message)
        return
      }
      notify('키를 등록했습니다.')
      render(options, result.settings)
    })()
  })
  if (settings.keyStatus === 'registered') {
    form.append(button('키 삭제', () => {
      void (async () => {
        const result = await window.agent.deleteOpenRouterKey()
        if (result.status === 'canceled') return
        if (result.status === 'failed') {
          notify(result.message)
          return
        }
        notify('키를 삭제했습니다.')
        render(options, result.settings)
      })()
    }))
  }

  const parts: HTMLElement[] = [
    el('h2', '빠른 검토'),
    el('p', `OpenRouter 키: ${KEY_STATUS_TEXT[settings.keyStatus]} · 모델 ${settings.modelId}`),
    form,
    // 키는 키체인에만 둔다. 무엇이 나가는지는 늘 보여 준다 (`CLAUDE.md` §4).
    el('p', `키는 macOS 키체인에만 보관합니다. ${settings.outboundNotice}`, 'muted'),
  ]
  if (!settings.reviewAvailable) parts.push(el('p', settings.unavailableMessage, 'notice'))

  container.replaceChildren(...parts, ...claudeSection(options, settings))
  options.onSettingsChanged?.(settings)
}

/**
 * 심층 검토(Claude 모드) 구역. 선택 기능이다.
 * 쓸 수 없어도 안내만 하고 나머지 설정은 그대로 보인다. 여기서 키를 다루지 않는다.
 */
function claudeSection(options: SettingsOptions, settings: AiSettingsView): HTMLElement[] {
  const { notify } = options
  const claude = settings.claude

  const apply = (result: Awaited<ReturnType<typeof window.agent.recheckClaudeMode>>, done: string): void => {
    if (result.status === 'failed') {
      notify(result.message)
      return
    }
    notify(done)
    render(options, result.settings)
  }

  const status = el('p', `Claude Code: ${CLAUDE_STATE_TEXT[claude.state]}`
    + (claude.version === null ? '' : ` (${claude.version})`) + ` · 모델 ${claude.modelId} `)
  status.append(button('다시 확인', () => {
    void (async () => {
      apply(await window.agent.recheckClaudeMode(), 'Claude Code 상태를 다시 확인했습니다.')
    })()
  }))

  const parts: HTMLElement[] = [el('h2', '심층 검토 (선택)'), status]
  if (claude.state !== 'ready') parts.push(el('p', claude.message, 'muted'))
  if (claude.state === 'ready' && !claude.deepAvailable) parts.push(el('p', claude.deepUnavailableMessage, 'muted'))

  // 자동으로 못 찾을 때만 쓰는 칸이다. 접어 둔다.
  const manual = el('details')
  manual.open = claude.fromOverride || claude.state === 'not-installed'
  manual.append(el('summary', '실행 파일 경로 직접 지정'))
  const form = document.createElement('form')
  form.className = 'inline-form'
  const input = document.createElement('input')
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.maxLength = CLAUDE_CLI_PATH_MAX_LENGTH
  input.placeholder = '/Users/이름/.local/bin/claude'
  input.required = true
  input.setAttribute('aria-label', 'Claude Code 실행 파일 경로')
  form.append(input, button('저장', () => undefined, 'submit'))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const path = input.value
    void (async () => {
      apply(await window.agent.saveClaudeCliPath(path), '경로를 저장하고 다시 확인했습니다.')
    })()
  })
  if (claude.fromOverride) {
    form.append(button('지정 해제', () => {
      void (async () => {
        apply(await window.agent.clearClaudeCliPath(), '지정한 경로를 지우고 자동으로 다시 찾았습니다.')
      })()
    }))
  }
  if (claude.path !== null) manual.append(el('p', `현재: ${claude.path}${claude.fromOverride ? ' (직접 지정)' : ''}`, 'muted'))
  manual.append(form, el('p', '터미널에서 `which claude` 로 나오는 경로를 넣으세요. 별도 API 키는 쓰지 않습니다.', 'muted'))
  parts.push(manual)
  return parts
}

async function refresh(options: SettingsOptions): Promise<void> {
  const result = await window.agent.getAiSettings()
  if (result.status === 'failed') {
    options.notify(result.message)
    return
  }
  render(options, result.settings)
}

/** 설정 화면을 연다. 연결 상태가 바뀌면 다시 그린다. */
export async function openSettings(options: SettingsOptions): Promise<void> {
  const onChange = (): void => {
    void refresh(options)
  }
  if (!watched.has(options.container)) {
    watched.add(options.container)
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
  }
  await refresh(options)
}

const watched = new WeakSet<HTMLElement>()
