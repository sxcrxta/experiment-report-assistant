-- 7단계: 앱 설정 하나짜리 값 (PRD 5절, [Q-30]).
-- 지금 담는 것은 사용자가 직접 지정한 Claude Code 실행 파일 경로뿐이다.
-- **비밀은 여기에 넣지 않는다.** API 키는 macOS 키체인에만 둔다 (`CLAUDE.md` §4).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
