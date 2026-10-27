# 실험보고서 학습 보조 Agent

한글(HWPX)로 쓰는 실험보고서를 **대신 써 주지 않고**, 사용자가 스스로 고치도록 단계별 AI 피드백을 주는 macOS 데스크톱 앱입니다.

- 저장할 때마다 문단 해시와 **Myers Diff**로 바뀐 문단만 찾아냅니다.
- 이미 검토한 문단은 **해시 기반 캐시**로 다시 묻지 않습니다.
- 피드백은 질문 → 약한 힌트 → 강한 힌트 → 설명 → 수정 예시 순서로만 열리고, **최소 힙 Top-K**로 중요한 5개만 먼저 보여 줍니다.
- 동의·반박 같은 사용자 판단을 기록해 반복되는 약점을 **후보**로 보여 줍니다.
- HWPX 파일은 읽기만 하고 절대 고치지 않습니다.

| 핵심 알고리즘 | 위치 |
| --- | --- |
| SHA-256 문단 해시 | `src/core/document/hash.ts`, `sha256.ts` |
| Myers Diff | `src/core/diff/myers.ts` |
| 문단 추적 (분할·병합) | `src/core/diff/track.ts` |
| 캐시 키 (메모이제이션) | `src/core/cache/key.ts` |
| 우선순위 점수 · Top-K 최소 힙 | `src/core/priority/score.ts`, `topk.ts` |

기술 스택: TypeScript · Electron · SQLite · Vitest · OpenRouter(Gemma) · Claude Code CLI

## 실행

```
npm install
npm run dev
```

자세한 사용법은 [`docs/사용법.md`](docs/사용법.md), 요구사항은 [`experiment-report-assistant-prd.md`](experiment-report-assistant-prd.md)에 있습니다.

> 개인 실험보고서 샘플(`tests/fixtures/*.hwpx`)은 공개하지 않아, 이를 쓰는 테스트 3개는 이 저장소만으로는 실패합니다.
> 이 저장소는 공개용 사본이라 개발 커밋 기록은 담지 않았습니다.
