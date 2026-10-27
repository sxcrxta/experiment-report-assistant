# STAGE_TASKS.md — 단계별 구현 작업 목록

`IMPLEMENTATION_PLAN.md`가 **무엇을 어떤 구조로 만드는지**를 정한다면, 이 문서는 **단계마다 실제로
무슨 파일을 만들고 무엇을 끝내야 다음으로 넘어가는지**를 정한다. 한 번에 한 단계씩 실행한다.

- 요구사항 원천: `experiment-report-assistant-prd.md` (PRD)
- 개발 원칙: `CLAUDE.md`
- 구조·데이터 흐름·테스트 기준: `IMPLEMENTATION_PLAN.md`
- 결정 근거와 이력: `OPEN_QUESTIONS.md`

아래에서 **T-n** 은 `IMPLEMENTATION_PLAN.md` §4.2의 통과 항목 번호다.

---

## 실행 방법

### 자동 실행

```
npm run stages                  다음 미완료 단계부터 이어서 실행
npm run stage -- 3              3단계만 실행
npm run stages -- --dry-run     무엇을 할지만 보여 주고 세션은 부르지 않는다
npm run stage -- 2 --gate-ok    사람이 할 일을 끝냈다고 알리고 진행
npm run stages -- --max-fixes 1 수정 시도 횟수 변경 (기본 2)
```

한 단계는 이렇게 흘러간다.

1. **사전 점검** — Git 루트가 이 프로젝트인지, 작업 트리가 깨끗한지, 브랜치 위인지
2. **사람 확인 필요 여부** — 필요하면 안내를 출력하고 멈춘다
3. **구현 세션** (`claude -p`) — 이 단계의 정의를 주고 구현시킨다
4. **변경 검사** — 중단 조건에 걸리면 커밋하지 않고 멈춘다
5. **`npm run check`** — 경계 → 타입 → 린트 → 테스트
6. **검토 세션** (별도 `claude -p`) — 요구사항 충족과 diff 를 검토해 pass/fail 판정
7. **둘 다 통과해야** 상태를 갱신하고 커밋한다

실패하면 지적 사항을 넘겨 최대 2회 고치고, 그래도 안 되면 멈춘다.
변경은 작업 트리에 그대로 남으므로 직접 확인할 수 있다.

종료 코드: `0` 통과 · `1` 실패 · `2` 사람 확인 필요 · `3` 중단 조건

실행 기록은 `logs/stages/<시각>/` 에 남는다 (커밋하지 않음).
`run.jsonl` 에 사건이, 그 옆에 각 세션의 프롬프트와 응답이 저장된다.

### 자동화가 멈추는 조건

- Git 루트가 이 프로젝트가 아니거나, 작업 트리가 더럽거나, 분리된 HEAD
- 보호 문서 변경 (PRD, CLAUDE.md, IMPLEMENTATION_PLAN.md, OPEN_QUESTIONS.md,
  OPEN_ANSWERS.md, STAGE_TASKS.md, .gitignore) — 상태 갱신은 자동화만 한다
- 비밀 정보 경로, 배포 설정, 파일 삭제, `package-lock.json`/`node_modules` 변경
- 의존성 추가·제거 (무단 패키지 설치)
- 사람이 해야 하는 일: 실제 한글로 HWPX 저장, API 키, 앱 화면 확인,
  사용자 선택, Claude Code 실행 방식 확인

구현 세션은 `--permission-mode acceptEdits` + 허용 도구 목록으로 돌고,
설치·삭제·커밋·push·네트워크 호출은 막혀 있다. 검토 세션은 `--restricted` 라
명령을 실행하지 못한다. 도구 제한과 변경 검사가 두 겹으로 막는다.

### 손으로 실행할 때

자동화를 쓰지 않고 직접 진행할 수도 있다. 순서는 같다.

1. 해당 단계의 **선행 조건**을 확인한다. 충족되지 않으면 시작하지 않는다.
2. **작업** 항목을 순서대로 구현한다. 다음 단계 기능을 앞당겨 만들지 않는다.
3. 새 기능마다 그 기능을 실패시키는 테스트를 함께 넣는다 (`CLAUDE.md` §7).
4. `npm run check` 를 통과시킨다.
5. **완료 조건**을 하나씩 실제로 확인한다. 확인하지 못한 항목은 확인하지 못했다고 보고한다.
6. 그 단계를 커밋한다.

### 모든 단계에 계속 적용되는 규칙

- HWPX는 **읽기만** 한다. `src/adapters/hwpx`에 쓰기 API를 추가하지 않는다 (PRD 4.5).
- 결정론 로직(해시·Diff·캐시·점수·집계)은 `src/core`에 두고 AI를 호출하지 않는다 (`CLAUDE.md` §2).
- 사용자에게 보이는 문자열은 한국어로 쓴다.
- 새 DB 테이블은 새 마이그레이션 파일로 추가한다. **이미 적용된 마이그레이션 파일은 고치지 않는다.**
- 스키마·경계·불변식을 어기는 코드는 테스트로 막는다.

---

## 진행 상황

| 단계 | 이름 | 상태 |
| --- | --- | --- |
| 0 | 프로젝트 뼈대 | **완료** (`56607d7`) |
| 1 | HWPX 읽기와 문서 모델 | **완료** — 제목 판별은 실제 문서에서 검증했고, 개요 스타일이 없어 제목 0개다. 보강하지 않기로 결정 ([Q-27]) |
| 2 | 저장 감지 · Diff · 버전 | **완료** (자동 실행 2026-09-11) |
| 3 | 평가 지침 | **완료** (자동 실행 2026-09-11) |
| 4 | 모델 어댑터와 빠른 검토 | **완료** (자동 실행 2026-09-11) |
| 5 | 선택적 피드백 UI와 단계 진행 | **완료** (자동 실행 2026-09-12) |
| 6 | 메모이제이션 · 캐시 · 우선순위 큐 | **완료** (2026-09-12) |
| 7 | 심층 검토 (로컬 Claude Code) | **완료** (2026-09-12) — [Q-30] 으로 되살림. 실물 호출·취소·타임아웃 검증 완료 |
| 8 | 자기평가 · 반박 · 개인화 · 성장 요약 | **완료** (2026-09-12) — 단, 실제 모델·화면 미검증 |
| 9 | 개인 사용 마무리 | **완료** (2026-09-12) — T-28 은 7단계에서 채웠다. 화면·성장 요약 실물 확인 남음 |

2026-09-12의 0~6단계 재점검 결과와 수정·미검증 범위는
[구현 점검 기록](docs/2026-09-12-구현점검.md)에 남겼다. 단계 완료 표기는 실제 API·화면 검증이나
MVP 전체 완료를 뜻하지 않는다. 반복 취약점 집계 연결은 8단계에서, 지침 초안 제안은
그 뒤 보조 기능 작업에서 채웠다.

---

## 0단계 — 프로젝트 뼈대 ✅ 완료

**한 일**
- Electron + TypeScript 골격, 계층 디렉터리(shared / core / adapters / app / main / preload / renderer)
- `tools/boundaries.ts` 계층 경계 검사기 — 위반 시 `npm run check` 실패
- SQLite 마이그레이션 실행기 + `0001_baseline.sql`
- `npm run check` = 경계 → 타입 → 린트 → 테스트

**검증한 것**
- 경계 위반을 일부러 넣었을 때 종료 코드 1로 실패, 되돌리면 0
- 마이그레이션 멱등성과 실패 시 롤백 (실제 in-memory SQLite)
- Electron 창 실행 확인

---

## 1단계 — HWPX 읽기와 문서 모델

**선행 조건**
- [ ] 테스트용 실험보고서 HWPX 샘플 최소 2개를 `tests/fixtures/`에 둔다
      (표·그림 포함본 1개, 본문만 있는 것 1개).
      **이 파일들은 개인 문서이므로 커밋하지 않는다** — `.gitignore`가 막는다.

> 한글 for Mac의 **저장 동작**(임시 파일, inode 교체, 잠금) 관찰은 이 단계의 선행 조건이 아니다.
> 1단계는 이미 저장된 HWPX 파일을 읽기만 하므로 저장 과정을 알 필요가 없다.
> 그 관찰은 실제로 감시가 필요한 **2단계의 V-1 통합 테스트**로 옮겼다.

**PRD 근거:** 3절 1번, 4.1, 4.5(해싱), 5절(HWPX만 지원)

**만들 파일**
```
src/adapters/hwpx/reader.ts       ZIP+XML 파싱 (읽기 전용)
src/core/document/normalize.ts    문단 텍스트 정규화
src/core/document/hash.ts         문단 해시
src/core/document/model.ts        Paragraph / Document 타입
tests/fixtures/                   실제 샘플 (커밋하지 않음)
tests/hwpx-reader.test.ts
tests/document-model.test.ts
```

**작업**
- [x] 샘플 HWPX의 ZIP 내부 구조를 먼저 확인하고, 확인된 사실만 코드 전제로 삼았다
- [x] HWPX(ZIP) 열기 → content.hpf 의 spine 순서로 `Contents/sectionN.xml` 에서 문단 추출
- [x] 제목·표·캡션 구분 (header.xml 의 스타일 이름 기준). 표 안 문단은 위치까지 기록
- [x] 문단 텍스트 정규화 규칙 확정, 테스트로 고정
- [x] 문단 해시 계산 (텍스트 + 수식)
- [x] 문단 UUID 부여 (내용과 위치에서 유도, 두 번 읽으면 동일)

**만든 것**
```
src/core/document/sha256.ts     순수 SHA-256 (코어는 node:crypto 를 쓸 수 없다)
src/core/document/normalize.ts  정규화
src/core/document/hash.ts       문단 해시 · 문단 UUID
src/core/document/model.ts      Paragraph · 역할 판정
src/adapters/hwpx/reader.ts     ZIP + SAX 파싱 (읽기 전용)
tests/helpers/make-hwpx.ts      합성 HWPX 생성기
```

**이 단계에서 하지 않는 것**
- 저장 감지, Diff, DB 저장 (2단계)
- 문단 분할·병합 추적 (2단계)
- 어떤 형태의 HWPX 쓰기

**완료 조건**
- [x] 실제 한글 for Mac 파일에서 문단 목록을 재현 가능하게 추출한다
      (문단 121 · 표 2 · 표 안 문단 120 — XML 을 직접 뜯어 센 값과 일치. 두 번 읽어 동일)
- [x] `src/adapters/hwpx`에 쓰기 API가 없다 (tests/hwpx-readonly.test.ts 가 강제)
- [x] 읽어도 파일의 바이트와 mtime 이 변하지 않는다

**남은 것**
- [ ] **제목(개요 N) 판별을 실제 문서로 검증하지 못했다.** 검증에 쓴 실제 파일이 전부 `바탕글`
      스타일이라 개요 수준이 등장하지 않았다. 합성 테스트로만 확인된 상태다.
      개요 스타일을 쓴 실험보고서를 `tests/fixtures/`에 두면 `tests/real-sample.test.ts` 가 켜진다.

**테스트:** T-10, T-13 + HWPX 파싱·정규화·해시 단위 테스트

---

## 2단계 — 저장 감지 · Diff · 버전

**선행 조건:** 1단계 완료

**PRD 근거:** 3절 3~4번, 4.5(Myers Diff, 문단 추적, 체크포인트), 5절(경로 유실, 권한, iCloud)

> **V-1 통합 테스트가 이 단계에 포함된다.** 한글 for Mac의 저장 동작은 문서로만 확인하고 넘어가지 않고,
> 실제 저장을 감시하는 통합 테스트로 검증한다. 관찰과 구현을 한 단계 안에서 함께 한다.

**만들 파일**
```
src/adapters/watcher/fsevents-watcher.ts   FSEvents 감시, 디바운스, 경로 유실 감지
src/adapters/checkpoint/index.ts           원본 HWPX 복사 보관 (편집 없음)
src/core/diff/myers.ts                     Myers Diff
src/core/diff/track.ts                     문단 UUID 추적, 분할·병합 관계
src/adapters/repo/migrations/0002_documents.sql
src/adapters/repo/documents.ts
src/app/document-session.ts                문서 등록·저장 처리 유스케이스
docs/V1-hwpx-저장동작.md                    V-1 관찰 기록 (통합 테스트의 근거)
tests/myers.test.ts / track.test.ts / documents.test.ts
tests/watcher.test.ts                      저장 동작을 재현한 파일 조작 테스트
tests/integration/v1-hangul-save.test.ts   V-1 통합 테스트 (수동 실행)
```

**0002 마이그레이션에 들어갈 테이블** (`IMPLEMENTATION_PLAN.md` §1.8)
`Document`, `DocumentVersion`, `Paragraph`, `ParagraphLineage`, `DiffEntry`, `Checkpoint`

**작업**
- [x] **V-1 관찰 완료** (2026-09-10). 결과는 `docs/V1-hwpx-저장동작.md` 에 있다.
      `.BAK` 생성 → 원본 truncate(8KB) → 20ms 뒤 재작성 → `.BAK` 삭제. inode 유지. 파일 이름은 NFD.
- [ ] 관찰한 동작을 그대로 재현하는 **자동 테스트**(임시 파일 생성 → 교체 → 이름 변경 → 삭제)를 만든다.
      자동 테스트는 한글 없이도 돌아야 한다
- [ ] **V-1 통합 테스트**를 만든다. 실제 한글로 저장했을 때 감시가 `saved`를 정확히 한 번 내고
      변경 문단이 맞게 추출되는지 확인한다. 한글이 필요하므로 기본 `npm run check`에서는 제외하고
      `npm run test:v1` 같은 별도 명령으로 수동 실행한다
- [ ] FSEvents 감시. 크기가 안정될 때까지 대기(디바운스)하고 ZIP·mimetype 온전성을 확인한 뒤 `saved` 이벤트
- [ ] **파일 이름 비교는 NFC 정규화 후에 한다** (macOS 는 NFD 로 돌려준다). 테스트로 못박는다
- [ ] `.BAK` 등 대상 외 파일 무시
- [ ] **경로 기준 추적.** inode 를 추적 근거로 삼지 않는다
- [ ] 경로 유실(다른 이름·다른 폴더·삭제) 감지 → `path-lost` 이벤트 → 사용자 재선택으로 같은 문서에 재연결
- [ ] HWPX 외 형식이 감지되면 처리하지 않고 안내
- [ ] Myers Diff로 추가·삭제·수정 문단 추출
- [ ] 문단 UUID 추적. 분할·병합 시 새 UUID + `ParagraphLineage` 기록
- [ ] 해시가 같은 문단은 분석 대상에서 제외 (메모이제이션의 1단계)
- [ ] 버전 저장, 최초본 자동 체크포인트, 사용자 지정 체크포인트
- [ ] 문서 선택 다이얼로그와 경로 저장 (전체 디스크 권한 요청 금지)
- [ ] iCloud 미다운로드 파일 안내

**이 단계에서 하지 않는 것**
- AI 호출 (이 경로에는 AI가 전혀 없다)
- 지침·피드백·캐시

**완료 조건**
- [ ] `docs/V1-hwpx-저장동작.md`에 실제 관찰 결과가 기록돼 있고, 코드가 그 사실에 근거한다
- [ ] V-1 통합 테스트가 실제 한글 저장에서 통과한다 (수동 실행 결과를 보고한다)
- [ ] 저장할 때마다 변경 문단만 정확히 추출된다
- [ ] 파일이 원자적으로 교체돼도 감시가 유지된다
- [ ] 경로를 잃으면 감시를 멈추고 알린 뒤, 재선택으로 같은 문서에 이어진다
- [ ] 최초본·지정 체크포인트로 복구가 가능하다
- [ ] 원본 HWPX 바이트가 변하지 않는다

**테스트:** T-9, T-13, T-14, T-15, T-16, T-22, T-31

---

## 3단계 — 평가 지침

**선행 조건:** 2단계 완료

**PRD 근거:** 3절 2번, 4.1, 4.4(과목), 4.5(지침 버전)

**만들 파일**
```
src/core/rubric/model.ts            Rubric / RubricItem, 항목별 중요도
src/core/rubric/version.ts          rubricVersion 계산
src/adapters/repo/migrations/0003_rubric.sql
src/adapters/repo/rubric.ts
src/app/rubric.ts
src/renderer/src/views/rubric-editor.ts
tests/rubric.test.ts
```

**작업**
- [ ] 지침 입력·수정·삭제 UI (문서 상태와 무관한 **단일 경로**. 양식/빈 문서 분기 없음)
- [ ] 항목별 중요도 입력 (6단계 우선순위 점수의 입력값)
- [ ] 확정 시 `rubricVersion` 부여, 변경 시 새 버전
- [ ] 과목 입력 (문서 등록 시)
- [x] 문서 구조 기반 지침 **초안 제안**은 보조 기능으로 자리만 만든다 (실제 생성은 4단계 이후)
      → 자리만 두었다가 9단계 뒤에 실제 생성을 채웠다 (`core/rubric/outline.ts`,
      `app/rubric-suggest.ts`, `prompts/rubric-draft.v1.ts`, `tests/rubric-suggest.test.ts`)
- [ ] **확정 전 지침은 어떤 AI 요청에도 실리지 않도록** 타입·런타임 양쪽에서 막는다

**완료 조건**
- [ ] 사용자가 확정하기 전 지침으로는 AI 호출이 일어나지 않는다 (테스트로 증명)
- [ ] 지침을 바꾸면 새 `rubricVersion`이 생기고 이전 버전이 남는다

**테스트:** T-5

---

## 4단계 — 모델 어댑터와 빠른 검토

**선행 조건:** 3단계 완료 / OpenRouter 계정과 API 키

**PRD 근거:** 4.2, 4.3, 5절(키체인, 오프라인)

**만들 파일**
```
src/adapters/model/schema.ts             공통 요청/응답 스키마 + 검증
src/adapters/model/openrouter-gemma.ts
src/adapters/model/prompts/               버전이 붙은 프롬프트 템플릿
src/adapters/secret/keychain.ts
src/adapters/net/online.ts                온라인 여부
src/adapters/repo/migrations/0004_reviews.sql
src/app/review-request.ts
src/renderer/src/views/settings.ts        키 등록
tests/model-schema.test.ts / gemma.test.ts (고정 응답)
```

**작업**
- [ ] `IMPLEMENTATION_PLAN.md` §1.5의 `ReviewRequest` / `ReviewResponse` / `FeedbackItem` 타입 확정
- [ ] 스키마 검증: 통과해야만 저장·표시. 재시도 횟수 제한 후 실패 보고
- [ ] `stage != example`인데 `example`이 온 항목은 **버린다**
- [ ] 요청에 없던 `paragraphId`를 가리키는 항목은 **버린다**
- [ ] OpenRouter Gemma 호출. **외부 전송 지점을 코드에서 한 곳으로 모은다**
- [ ] 전송 페이로드를 대상 문단 + 지정된 문맥으로 제한
- [ ] 키 등록 UI, macOS 키체인 보관 (설정 파일 평문 금지)
- [ ] 오프라인·키 미등록·API 오류 → **검토 요청만** 차단하고 안내. 나머지 기능은 그대로

**이 단계에서 하지 않는 것**
- 캐시와 우선순위 선별 (6단계) — 이 단계에서는 매번 호출해도 된다
- Claude 심층 검토 (7단계에서 채웠다)

**완료 조건**
- [ ] 스키마를 어긴 응답이 저장·표시되지 않는다
- [ ] 오프라인·키 미등록에서 문서 등록·저장 감지·버전 기록이 계속 동작한다
- [ ] 빌드 산출물과 저장소에 키가 없다

**테스트:** T-3, T-11, T-27, T-29, T-30, T-32, T-33

---

## 5단계 — 선택적 피드백 UI와 단계 진행

**선행 조건:** 4단계 완료

**PRD 근거:** 3절 5~6번, 4.2

**디자인**

이 단계의 화면은 `docs/UI-개편.md` 의 "구현 스펙" 을 따른다.
Stitch 원본은 `docs/design/3-피드백탭.html` 에 있으나 **그대로 복사하지 않는다.**
외부 글꼴·CDN 을 쓰면 CSP(`default-src 'self'`)에 막혀 화면이 깨진다.

꼭 지킬 것 (스펙에 근거가 적혀 있다)
- 색 토큰을 한 곳에 CSS 변수로 정의하고 화면은 변수만 쓴다. 값은 스펙 표 그대로
- 글꼴은 시스템 한글 스택. 아이콘은 인라인 SVG
- 그림자를 쓰지 않는다. 경계는 1px 선으로만
- **반응 버튼 4개는 같은 크기·색·테두리.** '반박' 을 경고색으로 칠하지 않는다
- **'수정 예시' 단계는 더 흐리게** 하고 "직접 요청해야 열립니다" 를 붙인다
- 상위 5개만 보이고 나머지는 "나머지 N개 더 보기"
- **앱 껍데기(사이드바·탭)는 이 단계에서 만들지 않는다.** 아래 "UI 통합" 항목이 맡는다

**만들 파일**
```
src/core/rubric/section-boundary.ts     항목 경계 추정
src/core/document/sentence-anchor.ts    문장 앵커 (문단 UUID + 문장 + 위치 + 해시)
src/app/review-stage.ts                 단계 진행 제어
src/adapters/repo/migrations/0005_anchors.sql
src/renderer/src/views/review-panel.ts  범위·관점·단계 선택
src/renderer/src/views/feedback-card.ts 요약 카드 + 펼침 상세
tests/section-boundary.test.ts / sentence-anchor.test.ts / review-stage.test.ts
```

> **2026-09-13 개정 ([Q-32]·[Q-33]):** 대상을 고르는 방법이 바뀌었다. 드롭다운이 아니라
> **왼쪽 HWPX 미리보기에서 눌러서** 고른다 — 문단·문장·표·표 칸(여러 개 가능)과 `문서 전체` 버튼.
> 범위(`ReviewScope`)와 요청 모양(`StagedReviewInput`)은 그대로이고, 무엇을 고른 것으로 볼지는
> 프로그램이 판정한다. 미리보기는 `src/adapters/hwpx/preview.ts` → `src/main/preview-ipc.ts` →
> `src/renderer/src/views/document-page.ts` 를 지나며, 서식을 읽지 못해도 고르기는 그대로 된다.
> 절차와 확인 결과는 [CODEX_PLAN.md](CODEX_PLAN.md) 에 있다.

**작업**
- [ ] 범위 선택: 문장 / 문단 / 보고서 항목 / 전체
- [ ] 관점 선택: 양식 준수, 표·그림 설명, 참고문헌·출처, 과학적 정확성, 내용의 논리, 글의 구조, 문장 표현
- [ ] 항목 경계를 제목 스타일 + 지침 항목으로 **추정**하고 사용자가 수정
- [ ] 문장 앵커 연결. **재해석 실패 시 임의 연결 금지 → "찾지 못했습니다" 상태로 두고 사용자 확인 요청**
- [ ] 단계 순서 강제: 질문 → 약한 힌트 → 강한 힌트 → 설명 → 예시
- [ ] **예시는 명시 요청이 있을 때만** 진입
- [ ] 선행 작성 확인: 내용이 없는 대상은 요청 자체를 만들지 않는다
- [ ] 카드 목록 + 펼침(적용 지침·근거·전체 피드백·사용자 반응·수정 전후)

**완료 조건**
- [ ] 예시를 요청하지 않은 **어떤 경로에서도** 수정 예시가 나오지 않는다
- [ ] 문장 앵커를 잃으면 자동 연결 없이 사용자 확인 요청 상태가 된다
- [ ] 빈 문단에 대한 검토 요청이 생성되지 않는다
- [ ] 색 토큰이 한 곳에 정의되고 화면이 그 변수만 쓴다. 하드코딩된 색이 없다
- [ ] 외부 글꼴·CDN 을 부르지 않는다 (CSP 에 막히지 않는다)
- [ ] 반응 버튼 4개가 같은 크기·색·테두리다

**테스트:** T-1, T-2, T-4, T-23

---

## 6단계 — 메모이제이션 · 캐시 · 우선순위 큐

**선행 조건:** 5단계 완료

**PRD 근거:** 4.5

**만들 파일**
```
src/core/cache/key.ts          캐시 키 생성
src/core/priority/score.ts     가중치 상수 + 점수 계산
src/core/priority/topk.ts      우선순위 큐 Top-K
src/adapters/repo/migrations/0006_cache.sql
src/adapters/repo/cache.ts
tests/cache-key.test.ts / priority.test.ts
```

**작업**
- [ ] 캐시 키 = (문단 해시, `rubricVersion`, `promptVersion`, `modelId`, `perspective`, `stage`)
- [ ] 키 구성 요소 중 하나라도 바뀌면 재사용하지 않는다
- [ ] 변경 없는 문단은 AI 호출 0회
- [ ] 점수 = 0.35×평가기준 중요도 + 0.30×오류 심각도 + 0.20×반복 취약점 + 0.15×관점 일치도
- [ ] **가중치와 K(기본 5)는 상수 한 곳에서만 정의**
- [ ] 심각도는 AI 응답의 입력값일 뿐, **순위와 표시 여부는 프로그램이 정한다**
- [ ] 나머지 항목은 사용자가 요청할 때만 반환

**완료 조건**
- [ ] 문단 하나만 바뀐 저장에서 AI 호출이 (변경 문단 + 문맥) 범위를 넘지 않는다
- [ ] 지침 버전을 올리면 캐시가 무효화된다
- [ ] 화면 항목 수가 5개를 넘지 않는다

**테스트:** T-12, T-17, T-18, T-19, T-20, T-21

---

## 7단계 — 심층 검토 (로컬 Claude Code) ✅ 완료 (2026-09-12)

[Q-29] 로 한 번 보류했다가 **[Q-30] 으로 되살려 정식 범위로 만들었다.**

**선행 확인:** [V-2] 완료. 설치된 2.1.269 에서 인자·출력 봉투·오류 판별을 실제로 확인해
[docs/V2-claude-code-확인.md](docs/V2-claude-code-확인.md) 에 적었다. **추측한 플래그는 넣지 않았다.**

**만든 파일**
```
src/adapters/model/claude-path.ts            로그인 셸로 경로 해결 · 로그인 확인 · 캐시
src/adapters/model/claude-code.ts            비대화형 호출 · 단일 실행 큐 · 타임아웃 · 취소
src/adapters/model/prompts/deep-review.v1.ts 심층 검토 프롬프트 판 (system + render)
src/adapters/repo/settings.ts                사용자가 지정한 CLI 경로 (비밀 아님)
src/adapters/repo/migrations/0009_app_settings.sql
tests/claude-path.test.ts / claude-code.test.ts / review-depth.test.ts / reaction-view.test.ts
tests/integration/v2-claude-code.test.ts     실물 호출 (npm run test:v1)
```

**한 일**
- [x] `ReviewDepth`(빠른/심층)를 **사용자 선택**으로 두고, 깊이로 어댑터를 고르는 지점을 한 곳(`modelFor`)에 모았다.
      코어·앱·화면에는 `modelId` 분기가 없다. T-26 이 그대로 통과한다
- [x] 경로 해결은 로그인 셸(`$SHELL -l -c 'command -v claude'`)을 거친다. GUI 앱의 PATH 에는
      `~/.local/bin` 이 없기 때문이다. 못 찾으면 설정에서 사용자가 직접 지정한다
- [x] 로그인 확인은 `claude auth status` 의 `loggedIn` 만 읽는다. 이메일·조직은 읽지 않는다
- [x] 성공 판정은 **종료 코드 0 + `is_error` 아님 + 읽을 수 있는 구조화 출력** 셋을 모두 만족할 때뿐이다
- [x] 단일 실행 큐. 타임아웃·취소가 SIGTERM → SIGKILL 로 자식 프로세스를 정리한다
- [x] 검토 화면의 깊이 선택과 '심층 검토 중단' 버튼. 쓸 수 없는 깊이는 잠그고 이유를 보여 준다
- [x] **반박의 '심층 재검토' 버튼을 열었다.** 원 피드백과 사용자 판단을 함께 보내고,
      그 둘은 저장소에 그대로 남는다. 단계를 새로 열지 않고, 예시 단계였으면 설명 단계로 낮춘다
- [x] 성장 기록의 '심층 분석 요청' (PRD 4.6). Claude 모드가 없으면 잠기고 빠른 요약은 그대로 쓴다
- [x] 첫 실행 안내의 Claude 모드 감지 단계 (선택). 없어도 `ready` 는 true 다
- [x] 설정 화면의 상태 표시 · 다시 확인 · 경로 직접 지정 · 지정 해제
- [x] **Claude API 를 부르는 코드를 넣지 않았다.** 어댑터에 주소도 키도 없다 (테스트가 막는다)

**완료 조건**
- [x] Claude 모드가 없어도 빠른 검토 흐름 전체가 그대로 돈다
      (`review-depth.test.ts` 의 "심층을 쓸 수 없으면 그 요청만 막힌다")
- [x] 심층 검토가 한 번에 하나만 실행되고, 타임아웃·취소에서 자식 프로세스가 남지 않는다
      — **실물로 확인했다.** 취소 전 1개 → 취소 후 0개, 타임아웃 뒤에도 0개
- [x] 실제 호출이 스키마 검증을 통과한다 — opus 로 18.5초, 피드백 3건, 버린 항목 0건,
      질문 단계라 수정 예시 없음

**테스트:** T-24, T-25, T-26, T-28 (모두 통과)

**남은 검증 (사람이 눈으로):** 실제 Electron 창에서 깊이 선택·심층 재검토 버튼을 눌러 본 확인.
개발 맥북에 화면 기록 권한이 없어 창을 캡처하지 못했다.

---

## 8단계 — 자기평가 · 반박 · 개인화 · 성장 요약

**선행 조건:** 6단계 완료

**PRD 근거:** 3절 7~9번, 4.4, 4.5(개인화 데이터), 4.6

**만들 파일**
```
src/core/personalization/observation.ts   WeaknessObservation 집계
src/core/personalization/growth.ts        반복 횟수·개선 여부·관점별 분포 (AI 없음)
src/adapters/repo/migrations/0008_personalization.sql
src/app/personalization.ts
src/renderer/src/views/reaction.ts        자기평가·반응·반박 입력
src/renderer/src/views/growth.ts          개인화·성장 기록 화면
tests/personalization.test.ts / growth.test.ts
```

**작업**
- [x] 자기평가 기록 (AI 피드백 전/후 모두)
- [x] 반응 상태: 동의 / 부분 동의 / 반박 / 이해되지 않음 / 수정 완료
- [x] 반박 사유 입력 → 심층 재검토 요청 (원 피드백 + 반박을 함께 전달)
      사유는 원 피드백·AI 판단과 함께 저장하고 성장 기록에서 다시 본다.
      **재검토 요청 버튼은 7단계에서 열었다** ([Q-30]). 재검토는 원 피드백과 내 판단을 지우지 않는다
- [x] 수정 후 저장을 2단계 흐름과 연결해 **수정 전후 기록** 완성
- [x] `WeaknessObservation` 갱신 (관찰된 문제, AI 판단, 사용자 판단, 반박, 실제 수정, 반복 횟수, 개선 여부)
- [x] **사용자 승인 UI를 거쳐야만** `PersonalGuideline` 생성. 적용 범위(이번 문서 / 특정 과목 / 전체)
- [x] 개인화 지침 조회·수정·삭제
- [x] 통계 집계는 프로그램이, 요약 문장만 AI가 작성
- [x] 성장 요약은 **Gemma** 가 작성한다. 심층 분석은 7단계에서 더했다 (Claude 모드가 있을 때만)
- [x] 성장 요약에 근거 문서 버전·수정 기록을 함께 표시. **능력을 단정하는 문장 금지**
- [x] 성장 요약은 이 화면에만 둔다. 다른 화면·파일로 내보내지 않는다

**완료 조건**
- [x] 사용자 승인 없이 개인화 지침이 생기는 경로가 없다
- [x] 개인화 지침을 조회·수정·삭제할 수 있다
- [x] Gemma 만으로 성장 요약이 나온다
- [x] 취약점 출력에 반복 관찰 근거가 항상 붙는다

**테스트:** T-6, T-7, T-8, T-25

**남은 검증:** 실제 OpenRouter 응답으로 성장 요약을 받아 본 적이 없다(고정 응답으로만 검증).
실제 Electron 창에서 성장 기록 탭을 눈으로 본 확인도 남아 있다. 9단계에서 함께 처리한다.

---

## 9단계 — 개인 사용 마무리

**선행 조건:** 8단계 완료

**PRD 근거:** 5절, 6절(MVP 완료 기준)

**만들 파일**
```
docs/사용법.md                   실행·백업·복구 절차
src/app/first-run.ts             첫 실행 설정
tests/e2e-flow.test.ts           종단 시나리오 (모델은 고정 응답)
```

**작업**
- [x] 첫 실행 설정: 문서 선택, 과목 입력, 키 등록
      (`app/first-run.ts` 순수 함수 + `app:first-run` IPC + 빈 문서 화면의 안내 카드.
      **키 등록은 선택**이다. 없어도 나머지는 준비된 것으로 본다)
- [x] 데이터 위치 안내 (`~/Library/Application Support/experiment-agent`)
      — 설정 화면과 첫 실행 안내 양쪽에 적는다
- [x] 백업·복구 절차 (SQLite 파일 + 체크포인트 폴더) — `docs/사용법.md` 3·4절
- [x] 로컬 실행·업데이트 절차 문서화 — `docs/사용법.md` 1·5절
- [x] **개인용 `.app` 묶기** ([Q-31], 2026-09-12) — `npm run package`,
      설정은 `electron-builder.yml`, 애드혹 재서명은 `build/after-pack.cjs`.
      묶은 앱이 기존 `data.sqlite` 를 그대로 여는 것까지 확인했다.
      설정이 어긋나지 않는지는 `tests/packaging.test.ts` 가 지킨다
- [x] **종단 시나리오 테스트** (`IMPLEMENTATION_PLAN.md` §4.3): `tests/e2e-flow.test.ts`
      HWPX 선택 → 지침 설정 → 저장 감지 → 해시·Diff 변경 처리 → 우선순위 선별 →
      범위·관점·단계 선택 → Gemma 빠른 검토 →
      자기평가·반박 → 개인화 축적 → 성장 요약 표시
- [x] 예외 경로 테스트 (`IMPLEMENTATION_PLAN.md` §4.4) 전부 채우기
      — 마지막으로 비어 있던 "표만 있는 문서"를 `tests/table-only-document.test.ts` 로 채웠다.
      어디에서 무엇을 검증하는지는 `docs/사용법.md` 6절 표에 모았다

**이 단계에서 하지 않는 것**
- 공개 배포, 인증서 코드 서명, 공증, App Store, 자동 업데이트 (범위 밖, [Q-22]~[Q-24])
  — 개인용 `.app` 의 **애드혹** 서명은 이 맥에서 실행하기 위한 것이지 배포가 아니다 ([Q-31])

**완료 조건**
- [x] 개발 맥북에서 1~8단계 흐름이 처음부터 끝까지 한 번에 동작한다
      — 로컬 `data.sqlite` 에 실제 사용 기록이 있다: 문서 2건, 지침 3판,
      **실제 OpenRouter Gemma 검토 8건 전부 succeeded**, 피드백 10건, 마이그레이션 8까지 적용됨
- [x] 위 흐름이 Gemma 빠른 검토만으로 완결된다 — 심층 검토 없이 종단 테스트가 끝까지 돈다.
      Claude 모드가 붙은 뒤에도 이 성질은 그대로다 ([Q-30])
- [x] `IMPLEMENTATION_PLAN.md` §4.2의 T-1 ~ T-33이 모두 통과한다
      — **33개 전부 통과한다.** T-28(Claude Code CLI 단일 실행·타임아웃 정리)은 7단계를 살리며
      채웠고, 고정 응답 테스트와 실물 통합 테스트 양쪽으로 확인했다
      (`tests/claude-code.test.ts`, `tests/integration/v2-claude-code.test.ts`)

**남은 검증 (사람이 눈으로)**
- 성장 기록 탭과 첫 실행 안내를 **실제 Electron 창**에서 본 적이 없다.
  `npm run dev` 로 띄워 네 탭과 안내 카드를 확인해야 한다
- **실제 OpenRouter 로 성장 요약**을 받아 본 적이 없다. 빠른 검토는 실제 응답으로 8건 돌았지만,
  `summarizeGrowth` 경로는 고정 응답으로만 검증했다 (로컬 DB에 반응·지침·요약 기록이 아직 0건이다)

**테스트:** T-1 ~ T-33 전체

---

## UI 통합 — 앱 껍데기 (단계 사이 작업)

**선행 조건:** 5단계 완료. 8단계 뒤에 하면 성장 기록 화면까지 한 번에 맞출 수 있다.

**진행 (2026-09-12):** 사용자 제공 `stitch_codex` 세 화면을 기준으로 문서·평가 지침·검토 피드백과
설정을 공통 틀로 통합했다. 실제 저장된 문단·버전 표시용 읽기 IPC와 명시적 새로고침을 연결했다.
브라우저의 분리된 예시 데이터로 세 탭과 편집 흐름을 검증했다. 성장 기록(8단계) 및
실제 Electron 창의 수동 E2E 확인은 남아 있다. 상세는 `docs/UI-개편.md` 참고.

**하는 일**

지침 편집기·설정·피드백을 Stitch 디자인의 공통 껍데기로 묶는다.
네 화면(문서 / 평가 지침 / 검토 피드백 / 성장 기록)을 같은 틀에 연결했다.

- 왼쪽 사이드바 240px — 보고서 목록. 선택 표시, 경로 유실 배지와 "다시 선택", 맨 아래 설정
- 머리말 — 문서 제목, 메타 한 줄, 밑줄 탭 4개 (문서 / 평가 지침 / 검토 피드백 / 성장 기록)
- 기존 화면들을 탭 안으로 옮긴다
- 색 토큰과 글꼴을 5단계에서 만든 것으로 통일한다

**이 작업에서 하지 않는 것**
- 새 기능. 화면 배치와 모양만 다룬다

**손길 줄이기 ([Q-39], 2026-09-22):** 불러오면 바로 검토 화면, 지침 확정은 요청 자리에서,
반응은 누르면 저장, 체크포인트 이름은 선택, 다시 읽기·심층 중단 버튼은 필요할 때만,
성장 기록은 요약 외 접기. 실제 Electron 창에서 눈으로 보는 확인은 아직이다

**완료 조건**
- [ ] 모든 화면이 같은 사이드바와 머리말을 쓴다
- [x] 현재 구현된 문서 / 평가 지침 / 검토 피드백과 설정 화면을 공통 틀에 연결
- [x] 성장 기록 탭 연결 (8단계 구현과 함께)
- [ ] `npm run dev` 로 띄워 네 탭을 오갈 수 있다 (사람이 눈으로 확인)
- [x] 하드코딩된 색·글꼴이 없다 — 색은 `styles.css` 의 `:root` 에만 있다 (2026-09-22 확인).
      미리보기가 HWPX 에 적힌 글꼴을 그대로 쓰는 것(`document-page.ts`)은 문서 재현이라 예외

---

## 단계 사이에 다시 확인할 것

- **2단계 중:** V-1 (한글 for Mac 저장 동작) — 관찰과 통합 테스트를 함께 수행
- **V-2 완료 (2026-09-12):** Claude Code 비대화형 실행 방식. `docs/V2-claude-code-확인.md`
- 새로 모호한 점이 나오면 추측하지 말고 `OPEN_QUESTIONS.md`에 올린 뒤 멈춘다 (`CLAUDE.md` §0)
- 결정이 PRD와 어긋나면 순서를 지킨다: `OPEN_QUESTIONS.md` 기록 → 사용자 승인 아래 PRD 반영 →
  `IMPLEMENTATION_PLAN.md`·이 문서 갱신
