/**
 * 피드백 표시 우선순위의 단일 설정값 (PRD 4.5).
 *
 * 코어와 렌더러가 모두 읽어야 하므로, 어느 한쪽에 의존하지 않는 shared 계층에 둔다.
 * 모델이 주는 심각도는 이 계산의 입력일 뿐, 표시 순서는 프로그램이 정한다.
 */
export const FEEDBACK_PRIORITY = Object.freeze({
  /**
   * 평가 기준 중요도. 검토가 평가 지침을 쓰지 않게 되며([Q-48], 2026-09-28) 0 이 되었다.
   * 그 몫(0.35)은 심각도·반복 취약점·관점에 나눠 주었다. 예전 기록의 점수 계산 모양은 그대로 둔다.
   */
  rubricImportance: 0,
  severity: 0.5,
  repeatedWeakness: 0.3,
  perspectiveMatch: 0.2,
  /** 처음 목록에 보여 줄 카드 수 */
  topK: 5,
  /** 반복 횟수는 이 횟수부터 최댓값(1)으로 본다. */
  repeatedWeaknessCap: 5,
})
