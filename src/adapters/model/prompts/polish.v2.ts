/**
 * 글 다듬기 2판 ([Q-48]). 1판에 **문서 종류**를 더했다 — 실험 보고서면 보고서 문체로, 신청서면 신청서
 * 문체로 다듬는다. 지어내지 않기·숫자 그대로·JSON 형식 등 나머지 규칙은 1판 그대로다.
 */
import { renderPolishPrompt as renderV1, type PolishPayload } from './polish.v1.js'

export const POLISH_PROMPT_VERSION = 'polish.v2'

export interface PolishPayloadV2 extends PolishPayload {
  /** 문서 종류. 모르면 빈 문자열 */
  kind: string
}

export function renderPolishPrompt(payload: PolishPayloadV2): string {
  const v1 = renderV1(payload)
  if (payload.kind === '') return v1.replace('한국어 실험보고서에 바로 넣을 수 있는', '이 문서에 바로 넣을 수 있는')
  return [
    `이 글은 "${payload.kind}" 에 들어갈 글입니다. 그 문서에 맞는 문체로 다듬으세요.`,
    v1.replace('한국어 실험보고서에 바로 넣을 수 있는', '이 문서에 바로 넣을 수 있는'),
  ].join('\n')
}
