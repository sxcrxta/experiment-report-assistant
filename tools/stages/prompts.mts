/**
 * 세션에 보낼 지시문.
 *
 * 구현 세션과 검토 세션은 서로 다른 세션이며, 검토 세션은 구현 세션의 판단을 물려받지 않는다.
 */
import type { Stage } from './types.mts'

export function implementPrompt(stage: Stage, attempt: number, previousProblems: string[]): string {
  const header =
    attempt === 0
      ? `${stage.number}단계 "${stage.title}" 를 구현해라.`
      : `${stage.number}단계 "${stage.title}" 의 지적 사항을 고쳐라. (수정 ${attempt}회차)`

  const fixes =
    previousProblems.length === 0
      ? ''
      : ['', '## 고쳐야 할 것', ...previousProblems.map((p) => `- ${p}`), ''].join('\n')

  return [
    header,
    '',
    '## 먼저 읽을 것',
    '- experiment-report-assistant-prd.md (요구사항 원천)',
    '- CLAUDE.md (개발 원칙. 여기 어긋나면 검토에서 떨어진다)',
    '- IMPLEMENTATION_PLAN.md (구조와 테스트 기준)',
    '- STAGE_TASKS.md (이 단계의 정의)',
    '',
    `## ${stage.number}단계 정의 (STAGE_TASKS.md 발췌)`,
    stage.body,
    fixes,
    '## 지켜야 할 것',
    '- 이 단계의 범위만 구현한다. 다음 단계 기능을 앞당겨 만들지 않는다.',
    '- 새 기능마다 그 기능을 실패시키는 테스트를 함께 넣는다.',
    '- npm run check (경계 -> 타입 -> 린트 -> 테스트) 가 통과해야 한다.',
    '- 다음 파일은 고치지 마라: PRD, CLAUDE.md, IMPLEMENTATION_PLAN.md, OPEN_QUESTIONS.md,',
    '  OPEN_ANSWERS.md, STAGE_TASKS.md, .gitignore. 상태 갱신과 커밋은 자동화가 한다.',
    '- 패키지를 새로 설치하지 마라. 필요하면 구현을 멈추고 이유를 설명해라.',
    '- git commit, git push, 파일 삭제, 외부 네트워크 호출을 하지 마라.',
    '- 모호하거나 결정이 필요한 지점이 나오면 추측하지 말고, 무엇이 막혔는지 설명하고 멈춰라.',
    '',
    '마지막에 무엇을 만들었고 무엇을 확인했는지 짧게 정리해라.',
  ].join('\n')
}

export function reviewPrompt(stage: Stage, diff: string, checkOutput: string): string {
  return [
    `너는 검토자다. ${stage.number}단계 "${stage.title}" 의 구현을 검토한다.`,
    '구현자와는 다른 세션이며, 구현자의 주장을 그대로 믿지 않는다.',
    '',
    '## 이 단계의 요구사항 (STAGE_TASKS.md)',
    stage.body,
    '',
    '## npm run check 결과',
    '```',
    checkOutput.slice(-4000),
    '```',
    '',
    '## 변경 diff',
    '```diff',
    diff.slice(0, 120000),
    '```',
    '',
    '## 확인할 것',
    '1. 위 "완료 조건" 을 실제로 충족하는가. 코드가 실제로 그렇게 동작하는지 근거를 들어라.',
    '2. "이 단계에서 하지 않는 것" 을 넘어서지 않았는가.',
    '3. CLAUDE.md 의 원칙을 어긴 곳이 있는가',
    '   (HWPX 쓰기, 코어의 I/O 의존, AI 가 결정론 로직을 대신함, 사용자 승인 없는 규칙 생성 등).',
    '4. 테스트가 실제로 그 기능을 검증하는가. 통과만 시키는 빈 테스트가 아닌가.',
    '5. 요구사항에 없는 기능을 덧붙이지 않았는가.',
    '',
    '필요하면 Read/Grep 으로 저장소 파일을 직접 확인해라. 파일을 고치지는 마라.',
    '',
    '## 응답 형식',
    '마지막 줄에 아래 JSON 만 한 줄로 출력해라. 다른 설명은 그 앞에 써라.',
    '{"verdict":"pass","summary":"한 문장"}',
    '또는',
    '{"verdict":"fail","summary":"한 문장","problems":["구체적인 문제 1","문제 2"]}',
    '',
    '의심스러우면 fail 로 하고 무엇이 부족한지 구체적으로 적어라.',
  ].join('\n')
}
