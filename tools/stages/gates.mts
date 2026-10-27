/**
 * 사람이 직접 해야 하는 일을 알아본다.
 *
 * 사용자 선택, API 키 등록, 앱 화면 확인, 실제 한글로 HWPX 저장처럼
 * 자동화가 대신할 수 없는 일이 단계에 들어 있으면 실행하지 않고 안내하고 멈춘다.
 */
import type { HumanGate, Stage } from './types.mts'

interface GateRule {
  reason: string
  action: string
  patterns: RegExp[]
}

const RULES: GateRule[] = [
  {
    reason: '실제 한글 for Mac 으로 HWPX 를 저장해 동작을 관찰해야 합니다',
    action:
      '한글 for Mac 에서 실험보고서를 HWPX 로 저장하면서 임시 파일 이름, inode 변화, 파일 잠금, ' +
      '저장 완료 시점을 관찰하고 docs/V1-hwpx-저장동작.md 에 기록해 주세요.',
    patterns: [/V-1/, /한글 for Mac[^.]*저장/, /저장 동작을 관찰/],
  },
  {
    reason: 'OpenRouter API 키가 필요합니다',
    action:
      'OpenRouter 계정에서 API 키를 발급받아 두세요. 키는 저장소나 설정 파일이 아니라 ' +
      'macOS 키체인에 넣습니다 (PRD 5절). 자동화는 키를 대신 만들거나 저장하지 않습니다.',
    patterns: [/API\s*키/, /OpenRouter\s*계정/, /키 등록/, /키체인 보관/],
  },
  {
    reason: '설치된 Claude Code 의 실행 방식을 직접 확인해야 합니다 (V-2)',
    action:
      'claude --help 로 비대화형 실행 플래그와 출력 형식, 로그인 상태 판별 방법을 확인해 ' +
      'docs/V2-claude-code-확인.md 에 기록해 주세요. 추측한 플래그는 코드에 넣지 않습니다.',
    patterns: [/V-2/, /Claude Code의? 비대화형 실행 방식/],
  },
  {
    reason: '앱 화면을 눈으로 확인해야 합니다',
    action:
      'npm run dev 로 앱을 띄우고 이 단계에서 만든 화면이 의도대로 보이는지 확인해 주세요. ' +
      '자동화는 화면을 볼 수 없습니다.',
    patterns: [/src\/renderer\/src\/views\//, /UI\b/, /화면\b/],
  },
  {
    reason: '사용자가 직접 파일이나 항목을 골라야 합니다',
    action:
      '문서 선택 다이얼로그나 권한 승인처럼 사람이 클릭해야 하는 절차가 들어 있습니다. ' +
      '해당 부분을 직접 확인해 주세요.',
    patterns: [/문서 선택 다이얼로그/, /사용자가 재선택/, /권한 요청과 거부 상태 처리/],
  },
]

export function detectHumanGates(stage: Stage): HumanGate[] {
  const haystack = [stage.prerequisites, stage.tasks, stage.completion, stage.body].join('\n')
  const gates: HumanGate[] = []

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      gates.push({ reason: rule.reason, action: rule.action })
    }
  }
  return gates
}

export function formatGates(
  stage: Stage,
  gates: readonly HumanGate[],
  extraFlags: readonly string[] = [],
): string {
  const lines = [
    '',
    `${stage.number}단계 "${stage.title}" 는 사람이 직접 해야 하는 일을 포함합니다.`,
    '자동으로 진행하지 않고 여기서 멈춥니다.',
    '',
  ]
  gates.forEach((gate, i) => {
    lines.push(`  ${i + 1}. ${gate.reason}`)
    lines.push(`     -> ${gate.action}`)
    lines.push('')
  })
  lines.push('끝내신 뒤 아래로 이어서 진행하세요.')
  lines.push(`  npm run stage -- ${[stage.number, ...extraFlags, '--gate-ok'].join(' ')}`)
  lines.push('')
  return lines.join('\n')
}
