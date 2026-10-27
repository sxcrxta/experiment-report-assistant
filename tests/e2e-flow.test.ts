/**
 * 9단계 — 종단 시나리오 (`IMPLEMENTATION_PLAN.md` §4.3, PRD 6절).
 *
 * 한 흐름으로 아래를 순서대로 통과한다.
 *
 *   HWPX 선택 → 지침 설정 → 한글 저장 감지 → 해시·메모이제이션과 Myers Diff 기반 변경 처리 →
 *   우선순위 큐 기반 피드백 선별 → 범위·관점·단계 선택 → Gemma 빠른 검토 →
 *   사용자 자기평가·반박 → 개인화 데이터 축적 → 성장 요약 표시
 *
 * 규칙
 * - **모델만 고정 응답이다.** 저장소는 실제 SQLite(메모리), 나머지는 실제 코드다.
 * - 이 시나리오는 **빠른 검토만으로** 끝까지 돈다. Claude 모드가 없는 환경을 그대로 흉내 낸다.
 *   심층 검토는 선택 기능이므로 없어도 전체 흐름이 돌아야 한다 ([Q-30]). 깊이 선택은 `review-depth.test.ts` 가 본다.
 * - HWPX 읽기 구간은 실제 한글 for Mac 샘플이 있을 때만 돈다. 없으면 그 구간만 건너뛰고
 *   나머지 흐름은 그대로 검증한다 (`tests/fixtures/README.md`, `CLAUDE.md` §7).
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createCheckpointStore, sha256File } from '../src/adapters/checkpoint/index.js'
import { hwpxReader } from '../src/adapters/hwpx/index.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createPersonalizationRepository } from '../src/adapters/repo/personalization.js'
import { createFileWatcher } from '../src/adapters/watcher/index.js'
import { createDocumentSession } from '../src/app/document-session.js'
import { firstRunGuide } from '../src/app/first-run.js'
import { createPersonalizationService } from '../src/app/personalization.js'
import { INITIAL_VISIBLE_CARDS } from '../src/shared/feedback.js'

import { createReviewHarness, DOCUMENT_ID, feedbackItem, modelReply, REVIEW_TEXTS } from './helpers/review-harness.js'

const SAMPLE = join(import.meta.dirname, 'fixtures', 'sample-full.hwpx')
const MIGRATIONS = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

describe('종단 시나리오 — HWPX 선택부터 성장 요약까지', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.()
  })

  it('빠른 검토 하나만으로 전체 흐름이 끝까지 돈다 (T-25)', async () => {
    // ---- 1. 문서와 지침. 하네스가 HWPX 등록과 지침 확정까지 끝낸 상태를 만든다.
    // 하네스가 훅으로 부를 때는 이미 만들어져 있다. 만드는 순서 때문에 나중에 채운다.
    // eslint-disable-next-line prefer-const
    let personal!: ReturnType<typeof createPersonalizationService>
    const h = createReviewHarness({
      repeatedObservation: (card) => personal.repeatedObservation(card),
      preserveFeedback: (id) => repo.reactions().some((r) => r.feedbackId === id),
      approvedGuidelines: (documentId) => personal.approvedGuidelines(documentId),
    })
    cleanup.push(() => h.close())
    const repo = createPersonalizationRepository(h.db)
    personal = createPersonalizationService({
      documents: h.documents, reviews: h.reviews, repo, models: { quick: h.model, deep: h.deepModel },
      online: { isOnline: () => true }, now: () => new Date().toISOString(), newId: randomUUID,
    })
    h.model.summarizeGrowth = () => Promise.resolve({ ok: true,
      text: JSON.stringify({ sentences: [{ text: '논리 관점의 기록과 내 판단을 함께 볼 수 있습니다.', evidence: ['E1'] }] }) })

    // 첫 실행 안내는 여기서 이미 "준비됨"이어야 한다. 키는 선택이다.
    // Claude 모드가 없어도 필수 단계는 모두 끝난 상태다. 심층 검토만 선택으로 남는다 ([Q-30]).
    expect(firstRunGuide({ documents: h.documents.listDocuments(), keyStatus: 'registered',
      claudeState: 'not-installed', dataPath: '/data', logPath: '/logs' }))
      .toMatchObject({ ready: true, complete: false })

    // ---- 2. AI 검토 전 자기평가. 아직 모델을 부르지 않는다.
    expect(personal.mutate({ kind: 'assessment', documentId: DOCUMENT_ID, phase: 'before',
      text: '결과 문단의 근거가 약한 것 같다.' }).status).toBe('ok')
    expect(h.model.calls).toHaveLength(0)

    // ---- 3. 한글 저장 감지 → 해시·Diff 로 바뀐 문단만 남는다.
    const edited = [...REVIEW_TEXTS]
    edited[4] = '온도가 올라가면 압력이 증가했다. 기울기는 0.5였다.'
    h.saveVersion(edited)
    const versions = h.documents.listVersions(DOCUMENT_ID)
    expect(versions).toHaveLength(2)

    // ---- 4. 범위·관점·단계 선택 → Gemma 빠른 검토 (고정 응답).
    h.model.replies.push(modelReply([
      feedbackItem({ severity: 4 }),
      feedbackItem({ severity: 1, body: '단위를 함께 적었나요?', rationale: '기울기에 단위가 없습니다.' }),
    ]))
    const requested = await h.staged.requestStagedReview({
      documentId: DOCUMENT_ID, scope: 'paragraph', paragraphIds: [h.uuidAt(4)],
      perspectives: ['logic'], stage: 'question',
    })
    if (!requested.ok) throw new Error(requested.message)
    expect(h.model.calls).toHaveLength(1)
    // 바뀐 문단만 나갔다. 문서 전체를 습관적으로 보내지 않는다 (T-17).
    expect(h.model.calls[0]!.targets.map((target) => target.text)).toEqual([edited[4]])

    // ---- 5. 우선순위 큐 선별. 프로그램이 순서와 표시 여부를 정한다 (T-12, T-20).
    const panel = await h.staged.getPanel(DOCUMENT_ID, {})
    if ('ok' in panel) throw new Error(panel.message)
    expect(panel.cards.length).toBeLessThanOrEqual(INITIAL_VISIBLE_CARDS)
    expect(panel.cards[0]!.severity).toBe(4)
    expect(panel.cards[0]!.stage).toBe('question')
    // 모든 카드에 반복 관찰 근거가 붙는다 (T-8).
    for (const card of panel.cards) {
      expect(card.repeatedObservation.count).toBe(card.repeatedObservation.versions.length)
    }

    // ---- 6. 사용자 판단: 반박(사유 필수)과 자기평가.
    const target = panel.cards[0]!
    expect(personal.mutate({ kind: 'reaction', documentId: DOCUMENT_ID, feedbackId: target.itemId,
      reaction: 'rebuttal', reason: '' }).status).toBe('failed')
    expect(personal.mutate({ kind: 'reaction', documentId: DOCUMENT_ID, feedbackId: target.itemId,
      reaction: 'rebuttal', reason: '기울기를 이미 적었습니다.' }).status).toBe('ok')
    expect(personal.mutate({ kind: 'assessment', documentId: DOCUMENT_ID, phase: 'after',
      text: '단위를 빠뜨린 것은 맞다.' }).status).toBe('ok')

    // ---- 7. 개인화 축적. 승인 없이는 지침이 생기지 않는다 (T-6, T-7).
    expect(personal.mutate({ kind: 'guideline', documentId: DOCUMENT_ID, scope: 'document',
      text: '기울기는 이미 적었으니 단위를 먼저 물어봐 주세요.' }).status).toBe('failed')
    expect(repo.guidelines()).toEqual([])
    expect(personal.mutate({ kind: 'guideline', documentId: DOCUMENT_ID, scope: 'document',
      text: '기울기는 이미 적었으니 단위를 먼저 물어봐 주세요.' }, true).status).toBe('ok')
    expect(personal.approvedGuidelines(DOCUMENT_ID)).toHaveLength(1)

    // 승인한 지침은 다음 검토 요청에 실려 나가고 캐시를 새로 태운다.
    h.model.replies.push(modelReply())
    await h.staged.requestStagedReview({ documentId: DOCUMENT_ID, scope: 'paragraph',
      paragraphIds: [h.uuidAt(4)], perspectives: ['logic'], stage: 'question' })
    expect(h.model.calls).toHaveLength(2)
    expect(h.model.calls[1]!.personalization.approvedGuidelines)
      .toEqual(['기울기는 이미 적었으니 단위를 먼저 물어봐 주세요.'])

    // ---- 8. 성장 요약. Gemma 하나로 나오고 근거가 붙는다.
    const view = await personal.getView()
    expect(view.observations.length).toBeGreaterThan(0)
    expect(view.assessments).toHaveLength(2)
    expect(view.groups[0]!.rebuttalCount).toBe(1)
    expect((await personal.summarize()).status).toBe('ok')

    const summarized = await personal.getView()
    expect(summarized.summary!.sentences[0]!.evidenceIds).not.toHaveLength(0)
    expect(summarized.summary!.modelId).toBe(h.model.modelId)
    // 요약 문장의 근거는 실제 관찰과 그 문서 버전으로 이어진다.
    const evidence = summarized.observations.find((o) => o.id === summarized.summary!.sentences[0]!.evidenceIds[0])
    expect(evidence).toMatchObject({ documentId: DOCUMENT_ID })
    expect(evidence!.versionOrdinal).toBeGreaterThan(0)
  })

  it('오프라인에서도 검토 요청만 막히고 나머지 흐름은 그대로 돈다 (T-32, T-33)', async () => {
    const h = createReviewHarness()
    cleanup.push(() => h.close())
    const repo = createPersonalizationRepository(h.db)
    const personal = createPersonalizationService({
      documents: h.documents, reviews: h.reviews, repo, models: { quick: h.model, deep: h.deepModel },
      online: { isOnline: () => false }, now: () => new Date().toISOString(), newId: randomUUID,
    })
    h.setOnline(false)

    // 저장 감지·버전 기록·자기평가·개인화 관리는 그대로 된다.
    h.saveVersion([...REVIEW_TEXTS, '고찰을 덧붙였다.'])
    expect(h.documents.listVersions(DOCUMENT_ID)).toHaveLength(2)
    expect(personal.mutate({ kind: 'assessment', documentId: DOCUMENT_ID, phase: 'before',
      text: '오프라인에서 적는 자기평가.' }).status).toBe('ok')
    expect(personal.mutate({ kind: 'guideline', documentId: DOCUMENT_ID, scope: 'global',
      text: '항상 단위를 확인해 주세요.' }, true).status).toBe('ok')
    expect(repo.guidelines()).toHaveLength(1)

    // 화면과 기존 기록 조회도 열린다. 잠기는 것은 요청 바뿐이고, 이유가 함께 나온다.
    const panel = await h.staged.getPanel(DOCUMENT_ID, {})
    if ('ok' in panel) throw new Error(panel.message)
    expect(panel.requestAvailable).toBe(false)
    expect(panel.unavailableMessage).not.toBe('')
    expect(panel.paragraphs.length).toBeGreaterThan(0)

    const blocked = await h.staged.requestStagedReview({ documentId: DOCUMENT_ID, scope: 'paragraph',
      paragraphIds: [h.uuidAt(4)], perspectives: ['logic'], stage: 'question' })
    expect(blocked.ok).toBe(false)
    expect(h.model.calls).toHaveLength(0)

    // 성장 요약도 막히지만 기록 화면은 그대로 열린다.
    expect((await personal.summarize()).status).toBe('failed')
    expect((await personal.getView()).summaryAvailable).toBe(false)
  })

  it.skipIf(!existsSync(SAMPLE))(
    '실제 한글 HWPX 를 골라 등록하고 저장을 감지해 버전을 잇는다 (T-13, T-14)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'e2e-hwpx-'))
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, '실험보고서.hwpx')
      copyFileSync(SAMPLE, path)
      const before = sha256File(path)

      const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS })
      cleanup.push(() => db.close())
      const documents = createDocumentRepository(db)
      const session = createDocumentSession({
        repo: documents, reader: hwpxReader, watcher: createFileWatcher(),
        checkpoints: createCheckpointStore(join(dir, 'checkpoints')),
        hashFile: sha256File, fileSize: (p) => statSync(p).size,
        now: () => new Date().toISOString(), newId: randomUUID,
      })

      const registered = session.registerDocument({ path, subject: '일반화학실험' })
      if (!registered.ok) throw new Error(registered.message)
      expect(documents.listParagraphs(registered.version.id).length).toBeGreaterThan(0)
      // 최초본 체크포인트가 남아 되살릴 수 있다 (T-15).
      expect(registered.checkpoint.kind).toBe('initial')

      // 같은 바이트를 다시 저장하면 새 버전을 만들지 않는다 (해시 판정).
      const again = session.handleSaved(registered.document.id)
      if (!again.ok) throw new Error(again.message)
      expect(again.alreadyKnown).toBe(true)
      expect(documents.listVersions(registered.document.id)).toHaveLength(1)

      // 전체 시나리오를 돌린 뒤에도 원본 바이트가 그대로다 (T-13).
      expect(sha256File(path)).toBe(before)
    },
  )
})
