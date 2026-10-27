-- 0단계 기준선.
-- 도메인 테이블(Document, DocumentVersion, Paragraph, FeedbackItem 등)은
-- IMPLEMENTATION_PLAN.md 2단계부터 새 마이그레이션 파일로 추가한다.

-- 비밀이 아닌 로컬 설정을 담는다. API 키는 여기에 넣지 않는다 (키체인, PRD 5절).
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
