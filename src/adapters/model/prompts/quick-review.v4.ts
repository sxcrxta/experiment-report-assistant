import { QUICK_REVIEW_V3 } from './quick-review.v3.js'
import type { PromptTemplate } from './index.js'

/**
 * 평가 지침 없이, **문서 종류에 맞춰** 검토하는 4판 ([Q-48]).
 *
 * 검토는 더 이상 평가 지침을 싣지 않는다 (rubric 은 빈 목록). 대신 AI 가 짐작하거나 사용자가 고친
 * 문서 종류(`payload.document.kind`)를 앞에 알려 그 종류에 맞는 기준으로 보게 한다.
 * 나머지 규칙(단계·대필 금지·그림·문장)은 3판 그대로다.
 */
export const QUICK_REVIEW_V4: PromptTemplate = {
  version: 'quick-review.v4',
  render(payload) {
    const kind = payload.document?.kind
    return [
      kind === undefined
        ? '이 문서의 종류는 아직 모릅니다. 글을 보고 어떤 문서인지 짐작해 그에 맞는 기준으로 보세요.'
        : `이 문서는 "${kind}" 입니다. 이 종류의 문서에 맞는 기준으로 보세요 (예: 실험 보고서면 과학적 정확성과 근거, 신청서면 요구 사항과 명료성).`,
      '이번 검토에는 평가 지침을 쓰지 않습니다. rubricItems 는 빈 목록으로 두세요.',
      QUICK_REVIEW_V3.render(payload),
    ].join('\n')
  },
}
