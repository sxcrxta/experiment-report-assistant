/**
 * 첫 실행 안내 (9단계). 아직 하지 않은 설정을 한 곳에 모아 보여 준다.
 *
 * **여기서 무엇을 대신 해 주지 않는다.** 남은 일을 적고, 그 일을 하는 기존 화면으로 보낼 뿐이다.
 * 계산은 메인 프로세스(`app/first-run.ts`)가 한다. 이 파일은 그 결과를 그리기만 한다.
 *
 * 색은 `styles.css` 의 토큰만 쓴다. 파일·네트워크에 직접 닿지 않는다.
 */
import type { FirstRunGuide } from '../../../shared/first-run.js'

import { element } from './dom.js'

export interface FirstRunOptions {
  guide: FirstRunGuide
  /** 보고서 불러오기 창을 연다 */
  onImport: () => void
  /** 설정(키 등록) 화면으로 간다 */
  onSettings: () => void
}

const ACTION_LABEL: Record<string, string> = {
  document: '＋ 보고서 불러오기',
  key: '설정에서 키 등록하기',
}

/** 남은 설정이 있으면 안내 카드를, 다 끝냈으면 null 을 준다. */
export function renderFirstRun(options: FirstRunOptions): HTMLElement | null {
  const { guide } = options
  if (guide.complete) return null

  const box = element('section', 'first-run')
  box.append(element('h2', undefined, guide.ready ? '거의 다 되었습니다' : '시작하기 전에'))

  const list = element('ol', 'first-run-steps')
  for (const step of guide.steps) {
    const row = element('li', `first-run-step${step.done ? ' first-run-step--done' : ''}`)
    row.append(element('span', 'first-run-mark', step.done ? '✓' : '○'))
    const text = element('div')
    text.append(element('strong', undefined, step.title), element('p', 'muted', step.detail))
    row.append(text)
    if (!step.done) {
      const action = element('button', undefined, ACTION_LABEL[step.id] ?? '바로 가기')
      action.type = 'button'
      action.addEventListener('click', step.id === 'key' ? options.onSettings : options.onImport)
      row.append(action)
    }
    list.append(row)
  }
  box.append(list)

  // 백업·복구는 이 경로를 통째로 복사하면 된다 (docs/사용법.md).
  const where = element('details', 'first-run-paths')
  where.append(element('summary', undefined, '기록이 저장되는 위치'))
  for (const [label, value] of [['로컬 데이터', guide.dataPath], ['로그', guide.logPath]] as const) {
    const row = element('p', 'muted')
    row.append(element('strong', undefined, `${label}: `), document.createTextNode(value))
    where.append(row)
  }
  where.append(element('p', 'muted',
    '이 폴더를 통째로 복사해 두면 기록을 백업할 수 있습니다. 원본 HWPX 는 한글에서 관리합니다.'))
  box.append(where)
  return box
}
