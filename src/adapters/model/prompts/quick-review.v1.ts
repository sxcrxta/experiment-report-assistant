/**
 * 빠른 검토 프롬프트 — 1판.
 *
 * **이 파일의 글을 고치면 새 판 파일(quick-review.v2.ts)을 만든다.** 판 이름은 캐시 키의 일부다
 * (`CLAUDE.md` §5, §6). 같은 판 이름으로 글만 바뀌면 예전 결과가 새 프롬프트의 결과처럼 재사용된다.
 * `tests/gemma.test.ts` 가 이 판의 출력 해시를 고정해 두어, 판을 올리지 않고 고치면 실패한다.
 *
 * 모델에 보내는 문서 내용은 `payload` 뿐이다. 여기서 문서를 따로 읽거나 덧붙이지 않는다.
 */
import type { ModelPayload } from '../schema.js'
import { REVIEW_STAGE_LABELS, type ReviewStage } from '../../../shared/review.js'

import type { PromptTemplate } from './index.js'

/** 단계마다 모델이 해도 되는 것. 예시 단계가 아니면 고친 문장을 쓰지 못하게 한다 (PRD 4.2). */
const STAGE_INSTRUCTIONS: Readonly<Record<ReviewStage, string>> = {
  question:
    '문제를 직접 지적하거나 답을 알려 주지 말고, 학생이 스스로 문제를 발견하도록 이끄는 질문 한두 개만 body 에 씁니다.',
  weak_hint:
    '어느 부분을 다시 살펴보면 좋을지 방향만 짧게 알려 줍니다. 무엇이 틀렸는지, 어떻게 고칠지는 말하지 않습니다.',
  strong_hint:
    '무엇이 부족하거나 어긋나는지 구체적으로 짚습니다. 고친 문장이나 대신 쓸 문장은 쓰지 않습니다.',
  explanation:
    '왜 문제가 되는지 개념과 근거를 들어 설명합니다. 고친 문장이나 대신 쓸 문장은 쓰지 않습니다.',
  example:
    '무엇을 왜 고치면 좋은지 body 에 설명하고, 학생이 명시적으로 요청한 짧은 수정 예시를 example 에 1~2문장으로 씁니다.',
}

function render(payload: ModelPayload): string {
  const isExample = payload.stage === 'example'
  const itemShape = [
    '    {',
    '      "paragraph": "검토 대상 문단의 id (예: P1)",',
    '      "perspective": "관점 code 중 하나",',
    '      "severity": 1부터 5까지의 정수 (5가 가장 심각),',
    '      "body": "이 단계에 맞는 피드백",',
    '      "rationale": "그렇게 판단한 근거",',
    `      "rubricItems": ["근거가 된 평가 지침 id (예: R1). 없으면 빈 목록"]${isExample ? ',' : ''}`,
    ...(isExample ? ['      "example": "짧은 수정 예시 (1~2문장)"'] : []),
    '    }',
  ]

  return [
    '당신은 학생의 실험보고서 학습을 돕는 조교입니다. 학생이 직접 쓴 글을 스스로 고치도록 돕습니다.',
    '',
    '[지켜야 할 것]',
    '- 보고서 본문을 대신 써 주지 않습니다. 고친 문장이나 완성된 문단을 제시하지 않습니다.',
    isExample
      ? '- 이번 요청은 학생이 짧은 수정 예시를 명시적으로 요청했습니다. 예시는 각 항목의 example 에만 짧게 씁니다.'
      : '- 수정 예시는 쓰지 않습니다. example 필드를 넣지 않습니다.',
    '- role 이 "target" 인 검토 대상 문단에만 피드백을 답니다. role 이 "context" 인 문단은 판단을 위한 참고일 뿐입니다.',
    '- 입력의 perspectives 에 있는 관점만 봅니다.',
    '- 평가 지침(rubric)에 근거가 있으면 그 항목의 id 를 rubricItems 에 적습니다.',
    '- guidelines 는 학생이 승인한 개인 지침입니다. 있으면 따릅니다.',
    '- 학생의 능력을 단정하는 표현을 쓰지 않습니다. 글에 드러난 문제만 말합니다.',
    '- 한국어로 씁니다.',
    '',
    `[이번 단계: ${REVIEW_STAGE_LABELS[payload.stage]}]`,
    STAGE_INSTRUCTIONS[payload.stage],
    '',
    '[응답 형식]',
    'JSON 객체 하나만 출력합니다. 앞뒤에 다른 글을 붙이지 않습니다.',
    '{',
    '  "summary": "이번 검토를 한두 문장으로 요약",',
    '  "items": [',
    ...itemShape,
    '  ]',
    '}',
    '지적할 것이 없으면 items 를 빈 목록으로 둡니다.',
    '',
    '[입력]',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

export const QUICK_REVIEW_V1: PromptTemplate = {
  version: 'quick-review.v1',
  render,
}
