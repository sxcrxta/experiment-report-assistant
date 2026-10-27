/**
 * 양식 점검 프롬프트 — 3판 ([Q-50]).
 *
 * 조건은 "고찰 부분은 200자 이상이어야 한다" 처럼 한 줄이다. AI 는 글자 수를 세는 데 서툴러서, 목차 항목마다
 * **프로그램이 센 글자 수**를 함께 보내고 그 값을 쓰게 한다. 나머지(충족도 %, 형식)는 2판 그대로다.
 */
import type { SectionStat } from '../../../shared/check.js'

import { renderCheckPrompt as renderV2, type CheckPayload } from './check.v2.js'

export const CHECK_PROMPT_VERSION = 'check.v3'

export interface CheckPayloadV3 extends CheckPayload {
  /** 목차 항목별 글자 수. 목차가 없으면 빈 목록 */
  sections: SectionStat[]
}

export function renderCheckPrompt(payload: CheckPayloadV3): string {
  const v2 = renderV2(payload)
  const counts = payload.sections.length === 0
    ? '항목별 글자 수: (목차를 찾지 못했습니다. 글자 수 조건은 문단을 보고 판단하되, 확실하지 않으면 그렇다고 적으세요.)'
    : [
      '항목별 글자 수 (프로그램이 센 값입니다. 글자 수 조건은 반드시 이 값으로 판단하고 직접 세지 마세요.',
      '"고찰 부분" 처럼 부분을 가리키면 이름이 맞는 항목을 쓰세요. 제목 줄은 빼고 셌습니다. 공백 기준이 없으면 공백 포함 값을 쓰세요):',
      ...payload.sections.map((s) => `${'  '.repeat(s.level - 1)}- ${s.title} (문단 ${s.from}~${s.to}): `
        + `공백 포함 ${s.chars}자, 공백 제외 ${s.charsNoSpace}자`),
    ].join('\n')
  const at = v2.lastIndexOf('\n문서:\n')
  return `${v2.slice(0, at)}\n${counts}${v2.slice(at)}`
}

export { CHECK_OUTPUT_SCHEMA, CHECK_SYSTEM, parseCheck, type CheckResult } from './check.v2.js'
