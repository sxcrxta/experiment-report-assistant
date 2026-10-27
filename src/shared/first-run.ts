/**
 * 첫 실행 설정 안내가 경계를 넘어 다니는 모양 (9단계).
 *
 * 계산은 `app/first-run.ts` 가 한다. 렌더러는 앱 계층을 import 할 수 없으므로
 * (계층 경계), 화면과 앱이 함께 보는 타입만 여기 둔다.
 *
 * 이 모듈은 순수한 타입만 담는다. 여기에 로직을 넣지 않는다.
 */

/**
 * 첫 실행에서 확인하는 단계. `STAGE_TASKS.md` 9단계의 "문서 선택, 키 등록" 에
 * 7단계의 "Claude 모드 감지" 가 더해진다 ([Q-30]). 과목 입력은 선택이 되어 빠졌다 ([Q-52]).
 */
export type FirstRunStepId = 'document' | 'key' | 'claude'

export interface FirstRunStep {
  id: FirstRunStepId
  title: string
  /** 사용자가 그대로 읽는 안내. 끝났으면 무엇이 준비되었는지를 적는다 */
  detail: string
  done: boolean
  /**
   * 하지 않아도 나머지 기능이 도는가.
   * 키 등록은 선택이다. 없으면 **AI 검토 요청만** 막히고 문서·지침·기록은 그대로 쓴다.
   * Claude 모드도 선택이다. 없으면 **심층 검토만** 막히고 빠른 검토는 그대로 돈다.
   */
  optional: boolean
}

export interface FirstRunGuide {
  /** 필수 단계를 모두 마쳤는가. 선택 단계는 세지 않는다 */
  ready: boolean
  /** 선택 단계까지 모두 마쳤는가 */
  complete: boolean
  steps: FirstRunStep[]
  /** 지금 해야 할 단계. 다 끝냈으면 null */
  next: FirstRunStep | null
  /** 백업할 로컬 데이터 위치 (`docs/사용법.md`) */
  dataPath: string
  logPath: string
}
