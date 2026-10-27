/**
 * 첫 실행 설정 안내 (9단계, `STAGE_TASKS.md`).
 *
 * 처음 연 사람이 무엇을 아직 하지 않았는지 한 곳에서 보여 준다.
 * 순서는 PRD 3절의 흐름을 따른다: 보고서 선택 → 검토 키 등록. 과목은 선택이라 묻지 않는다 ([Q-52]).
 *
 * **여기서 무엇을 대신 해 주지 않는다.** 남은 일이 무엇인지 계산해 알려 줄 뿐이고,
 * 문서 선택·키 등록은 모두 사용자가 기존 화면에서 직접 한다.
 *
 * 부작용이 없는 순수 함수다. 파일·네트워크·저장소에 닿지 않는다 (`CLAUDE.md` §2·§7).
 * 오프라인이거나 키가 없어도 나머지 기능은 그대로 쓸 수 있으므로, 키 단계는 **선택**으로 둔다
 * (`CLAUDE.md` §4, [Q-21]).
 */

import type { FirstRunGuide, FirstRunStep } from '../shared/first-run.js'

export interface FirstRunInput {
  documents: readonly { subject: string | null }[]
  /** 'unreadable' = 키체인을 확인하지 못했다. 등록된 것으로 치지 않는다 */
  keyStatus: 'registered' | 'missing' | 'unreadable'
  /** Claude 모드(심층 검토) 감지 결과. 'ready' 가 아니면 심층 검토만 막힌다 ([Q-30]) */
  claudeState: 'ready' | 'not-installed' | 'not-logged-in' | 'error'
  dataPath: string
  logPath: string
}

const KEY_DETAIL: Record<FirstRunInput['keyStatus'], string> = {
  registered: 'OpenRouter 키가 키체인에 있습니다. 빠른 검토를 요청할 수 있습니다.',
  missing:
    '설정에서 OpenRouter 키를 등록하면 AI 검토를 요청할 수 있습니다. ' +
    '등록하지 않아도 보고서 기록·평가 지침·자기평가·성장 기록은 그대로 쓸 수 있습니다.',
  unreadable:
    '키체인을 확인하지 못했습니다. 설정에서 다시 확인해 주세요. ' +
    '그동안에도 AI 검토를 뺀 나머지 기능은 그대로 쓸 수 있습니다.',
}

const CLAUDE_DETAIL: Record<FirstRunInput['claudeState'], string> = {
  ready: '설치·로그인된 Claude Code 를 찾았습니다. 검토를 요청할 때 심층 검토를 고를 수 있습니다.',
  'not-installed':
    'Claude Code 를 찾지 못했습니다. 설치되어 있다면 설정에서 실행 파일 경로를 지정해 주세요. ' +
    '없어도 빠른 검토와 나머지 기능은 그대로 쓸 수 있습니다.',
  'not-logged-in':
    'Claude Code 에 로그인되어 있지 않습니다. 터미널에서 `claude auth login` 을 실행한 뒤 설정에서 다시 확인해 주세요. ' +
    '그동안에도 빠른 검토는 그대로 쓸 수 있습니다.',
  error:
    'Claude Code 의 상태를 확인하지 못했습니다. 설정에서 다시 확인해 주세요. ' +
    '심층 검토만 쓸 수 없고 나머지는 그대로입니다.',
}

/** 남은 첫 실행 단계를 계산한다. */
export function firstRunGuide(input: FirstRunInput): FirstRunGuide {
  const hasDocument = input.documents.length > 0

  const steps: FirstRunStep[] = [
    {
      id: 'document',
      title: '보고서 불러오기',
      detail: hasDocument
        ? `보고서 ${input.documents.length}개를 불러왔습니다.`
        : '한글에서 저장한 HWPX 를 골라 주세요. 앱은 문서를 읽기만 하고 고치지 않습니다.',
      done: hasDocument,
      optional: false,
    },
    {
      id: 'key',
      title: 'OpenRouter 키 등록 (선택)',
      detail: KEY_DETAIL[input.keyStatus],
      done: input.keyStatus === 'registered',
      optional: true,
    },
    {
      id: 'claude',
      title: '심층 검토 준비 (선택)',
      detail: CLAUDE_DETAIL[input.claudeState],
      done: input.claudeState === 'ready',
      optional: true,
    },
  ]

  const required = steps.filter((step) => !step.optional)
  return {
    ready: required.every((step) => step.done),
    complete: steps.every((step) => step.done),
    steps,
    next: steps.find((step) => !step.done) ?? null,
    dataPath: input.dataPath,
    logPath: input.logPath,
  }
}
