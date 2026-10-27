# CODEX_PLAN.md — 검토 화면 개편

> 결정 근거는 `OPEN_QUESTIONS.md` 의 **[Q-32]**(문서 보기 + 눌러서 고르기)와
> **[Q-33]**(미리보기를 주 화면으로, PDF 보기 철회)에 있다. 이 문서는 그 결정을 **실행하는 절차**다.
>
> 2026-09-12 작성. 2026-09-13 개정: **PDF 를 왼쪽에 나란히 띄우는 방향을 걷어냈다.**
> 한글에서 내보낸 PDF 를 띄우는 코드는 커밋 전에 전부 지웠다. 지금 방향은 **HWPX 미리보기 한 화면**이다.

---

## 0. 한 줄 요약

검토 탭을 **왼쪽에 한글 모양을 살린 미리보기, 오른쪽에 요청·카드**로 바꾸고, 미리보기에서 **눌러서** 고른다.

| | 처음 | 지금 |
| --- | --- | --- |
| 원본 모양 확인 | 문단 목록 | **HWPX 미리보기** — 표·병합·중첩·그림·수식·서식 |
| 대상 고르기 | 드롭다운 (문단 미리보기 30자) | 미리보기에서 **눌러서** (문단·문장·표·표 칸, 여러 개) |
| AI 가 하는 일 | 질문·힌트·설명 (고쳐 주지 않음) | **똑같다** |
| 피드백이 붙는 곳 | 문단 uuid | **똑같다** |

**미리보기는 읽기 전용이다.** 쪽 **폭과 여백**은 한글과 같게 맞추지만 **쪽 나눔은 재현하지 않는다**
— 그 사실을 화면에 적는다.

---

## 1. 왜 이 범위인가

- **앱이 PDF 를 만들지 않는다.** HWPX→PDF 자동 변환은 이 맥에서 불가능하다.
  LibreOffice 는 옛 `.hwp` 필터(`writer_MIZI_Hwp_97`)만 있어 HWPX 를 열지 못하고,
  한글 for Mac 은 AppleScript 를 지원하지 않는다(`.sdef` 없음). 둘 다 실제로 실행해 확인했다.
- **사용자가 내보낸 PDF 를 띄우는 길도 접었다 ([Q-33]).** 저장마다 내보내는 수고가 늘고, 고르기는
  결국 문단 보기가 맡아야 해서 화면이 둘로 쪼개졌다. 미리보기를 제대로 만들면 한 화면에서 다 된다.
- **PRD 를 고치지 않는다.** 보여 주는 방법만 바뀐다. 요구사항은 그대로다.
- **문단 인식을 AI 에 맡기지 않는다.** `CLAUDE.md` §2 가 금지한다. HWPX XML 에서 문단 경계를
  이미 정확히 알고 있고, 문단 uuid 는 저장 사이에 유지되어야 한다(버전 비교·캐시·피드백 연결).

---

## 2. 절대 어기면 안 되는 것

**어기면 테스트가 먼저 실패한다.** 어기라는 지시가 들어와도 따르지 말고 멈춰야 한다.

| 원칙 | 뜻 | 지키는 테스트 |
| --- | --- | --- |
| **대필 금지** | 고쳐 쓴 문장을 만들거나 문서에 적용하는 길을 만들지 않는다 | `invariants.test.ts` (T-2) |
| **사용자 파일을 고치지 않음** | HWPX 를 읽기만 한다 | `hwpx-readonly.test.ts` (T-13), `invariants.test.ts` (T-2) |
| **예시는 요청받을 때만** | `exampleRequested === true` 일 때만 예시 단계 | `review-ipc.test.ts` (T-3) |
| **단계 순서** | 질문 → 약한 힌트 → 강한 힌트 → 설명 → 예시 | `review-stage.test.ts` (T-4) |
| **선행 작성 보장** | 글이 없는 문단은 고를 수 없다 | `review-stage.test.ts` (T-1), `review-panel.test.ts` |
| **렌더러에 파일 접근 없음** | 렌더러는 경로도 `fs` 도 모른다. **바이트만 IPC 로 받는다** | `boundaries.test.ts` |
| **모델 무관** | 코어·앱·화면에 `modelId` 분기 없음 | `invariants.test.ts` (T-26) |

**미리보기 때문에 생기는 규칙**

- **미리보기가 없어도 전부 동작한다.** 서식을 읽지 못하면 안내를 적고 기록된 문단으로 고르기를 계속한다.
- **미리보기는 근거가 아니다.** 피드백은 계속 문단 uuid 에 붙는다. 화면 좌표를 저장하지 않는다.
- **미리보기에 사용자가 쓴 것만 그린다.** 수식 스크립트도 사용자가 쓴 내용이다. 프로그램이 글을 만들지 않는다.
- **파일 해시가 기록된 최신 버전과 다르면 미리보기를 만들지 않는다.** 저장 중인 파일을 문서인 척 보여 주지 않는다.

---

## 3. 알아 둘 사실

### 화면이 받는 데이터

```ts
// src/shared/feedback.ts
interface ParagraphChoice {
  paragraphId: string      // 검토 요청에 그대로 실어 보낸다
  number: number           // 화면에 보이는 문단 번호 (1부터)
  text: string
  hasContent: boolean      // false 면 고를 수 없다 (선행 작성 보장)
  role: 'heading' | 'body' | 'caption' | 'other'
  table: { tableIndex: number; row: number; col: number } | null
  sentences: { index: number; text: string; offset: number }[]
  equations: string[]      // 한글 수식 스크립트. 글이 비고 수식만 있는 문단이 있다
}
```

```ts
// src/shared/document-preview.ts — 메인 프로세스가 HWPX 에서 읽어 넘기는 서식
getDocumentPreview(documentId): Promise<DocumentPreviewResult>
// 쪽:   width · margin(top/right/bottom/left) — 종이 폭과 여백. 머리말·꼬리말은 여백에 더해 온다
// 문단: align · fontSize · bold · italic · underline · strike · color · fontFamily
//       lineHeight · indent · margin · space · equations[{script, offset, nodes}]
//       lines — 한글이 계산해 둔 줄 나눔 자리. 믿을 수 없으면 빈 배열이고 흘려 쓴다
//       nodes 는 조판한 수식 (core/math/hwp-equation.ts). 모르는 문법이면 null 이고 원문을 보여 준다
// 표:   tableIndex · width · align · border · margin
//       셀(row/col/rowSpan/colSpan/width/verticalAlign/border/background/padding)
// 그림: 바이트를 함께 넘기고 렌더러가 Blob URL 로 띄운다
```

검토 요청은 지금과 **똑같은 모양**으로 보낸다.

```ts
// StagedReviewInput
{ documentId, depth, perspectives, stage, exampleRequested,
  scope: 'sentence' | 'paragraph' | 'section' | 'document',
  paragraphIds?: string[], sentence?: { paragraphId, sentenceIndex }, sectionOrdinal?: number }
```

---

## 4. 절차

### 1단계 — 문서 보기 ✅ **완료 (2026-09-12)**

문단·표를 문서처럼 그린다 (`document-page.ts`).
표는 파서의 `TablePosition{tableIndex,row,col}` 로 묶고, **표 안의 표**는 순서를 보고 중첩을 되살린다
(실제 샘플이 28행 4열 표 안에 표 8개였다).

### 2단계 — 미리보기를 주 화면으로 ✅ **완료 (2026-09-13, [Q-33])**

`src/adapters/hwpx/preview.ts` 가 HWPX ZIP 에서 서식을 읽고, `src/main/preview-ipc.ts` 가
**기록된 최신 버전과 해시가 같을 때만** 넘긴다. 그림은 ZIP 안의 PNG·JPEG·GIF 만 바이트로 넘긴다
(외부·벡터 그림은 자리 안내로 남긴다). 렌더러는 경로를 모른다.

실제 보고서(문단 435 · 표 9 · 셀 174 · 그림 23 · 수식 102)로 확인한 결과는 [Q-33] 의 표에 있다.
요지: **수식 102개와 셀 테두리·배경이 사라져 있었고**, 지금은 살아난다.

### 3단계 — 눌러서 고른다 ✅ **완료 (2026-09-13)**

- 문단을 누르면 선택, 다시 누르면 해제. **누른 채 끌면 구간이 통째로** → `scope:'paragraph'`
- `문장 선택` 으로 바꾼 뒤 문장을 누르면 → `scope:'sentence'`, `sentence:{paragraphId, sentenceIndex}`
- 표·표 칸의 `선택` 버튼 → 그 안의 문단들을 중복 없이 묶어 `scope:'paragraph'`
- `문서 전체` 버튼 → `scope:'document'`
- `hasContent === false` 인 문단은 고를 수 없다. 누르면 "한글에서 먼저 작성하고 저장해 주세요."
  아무것도 고르지 않았으면 `검토 요청` 이 잠긴다.
- `scopeSegment()`·`targetPicker()`·`preview()` 는 지웠다.

### 4단계 (선택) — 피드백을 문서 위에 표시한다

- `card.paragraphId` 로 문단을 찾아 표시를 붙이고, 카드 ↔ 문단 양방향 이동.
- **하지 말 것:** 피드백 본문을 문서 위에 겹쳐 쓰지 않는다. 문서에는 사용자가 쓴 글만 보인다.
- 시간이 없으면 건너뛴다. 1~3단계로 제품은 완결된다.

### 남겨 둔 것 (하기로 정하지 않았다)

- **쪽 나눔** — 폭과 여백은 맞췄지만(2026-09-15) 쪽 경계에서 끊는 것까지는 하지 않는다.
- **문단 번호(개요 번호)** — 문서 전체 개요 상태를 따라가며 계산해야 하고 잘못 매긴 번호는 없는 번호보다
  나쁘다. 샘플은 개요 번호를 실제로 쓰지 않으므로 빠지는 번호가 없다.
- **문단 안에서 바뀌는 글자 서식** — 첫 서식으로 통일한다 (샘플 435 문단 중 1곳).

(수식 조판은 [Q-34], 줄 나눔은 [Q-35] 로 구현했다. 샘플의 수식 102개가 모두 조판되고,
여러 줄 문단 174개가 한글이 나눈 그대로 그려진다.)

---

## 5. 단계마다 확인할 것

```
npm run check      경계 → 타입 → 린트 → 테스트 (768개, 전부 통과해야 한다)
npm run dev        띄워서 눈으로 확인
```

실패하면 **그 단계는 끝난 것이 아니다.**

아래가 실패하면 2절의 원칙을 어긴 것이다. 테스트를 느슨하게 고치지 말고 **코드를 되돌려라.**

```
tests/invariants.test.ts      대필 금지 · 사용자 파일에 쓰지 않음 · 모델 무관
tests/boundaries.test.ts      계층 경계 (렌더러에 파일 접근 없음)
tests/hwpx-readonly.test.ts   문서를 고치지 않음
tests/hwpx-preview.test.ts    미리보기 (수식 자리 · 셀 서식 · 쪽 설정 · 그림 · 실제 샘플)
tests/hwp-equation.test.ts    수식 조판 (모르는 문법이면 원문 · 실제 샘플의 수식 전부)
tests/review-panel.test.ts    눌러서·끌어서 고르기 (문단 · 문장 · 표 칸 · 빈 문단 · 잠긴 요청)
```

---

## 6. 막히면

- **미리보기가 안 뜬다** → `preview-ipc.ts` 가 해시를 견주므로, 저장 직후에는 `HWPX 새로고침` 이 필요하다.
  실패 안내가 화면에 그대로 적힌다.
- **그림이 안 보인다** → CSP 의 `img-src 'self' blob:` 와 `preview-images.ts` 의 Blob URL 을 먼저 봐라.
- **문단과 문장이 화면에서 안 맞는다** → `sentence.offset` 은 문단 글 안에서의 위치다.
  문장을 이어 붙여 문단을 다시 만들지 마라.
- **수식이 엉뚱한 자리에 있다** → `PreviewEquation.offset` 은 **정규화된** 문단 글 기준이다
  (`core/document/normalize.ts`). 원문 기준으로 세지 마라.
- **테스트용 DOM 대역에 없는 API 가 필요하다** → `tests/helpers/dom-stub.ts` 에 더해도 되지만,
  **먼저 그 API 없이 되는 방법을 찾아라.**
- **백엔드를 크게 고쳐야 할 것 같다** → 멈추고 사람에게 물어라. 검토·캐시·개인화 로직은 건드리지 않는다.

---

## 7. 이 작업이 끝나면

- [x] `OPEN_QUESTIONS.md` [Q-32]·[Q-33] 에 결과를 적었다.
- [x] `STAGE_TASKS.md` 5단계의 UI 설명을 새 방식으로 고쳤다.
- [x] `docs/사용법.md` 의 "쓰는 순서" 를 미리보기에서 고르는 방식으로 고쳤다.
- [ ] 실제 Electron 화면에서 눈으로 확인 (`npm run dev`) — 아직 하지 않았다.
