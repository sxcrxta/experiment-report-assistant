-- 8단계. 기존 문서·검토 기록은 변경하지 않는다.
CREATE TABLE user_reaction (
  feedback_id TEXT PRIMARY KEY REFERENCES feedback_item(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('agree','partial','rebuttal','unclear','completed')),
  reason TEXT NOT NULL CHECK(length(reason) <= 2000),
  updated_at TEXT NOT NULL,
  CHECK(kind <> 'rebuttal' OR length(trim(reason)) > 0)
);
CREATE TRIGGER reaction_document_matches BEFORE INSERT ON user_reaction
WHEN NEW.document_id IS NOT (SELECT r.document_id FROM feedback_item f JOIN review_request r ON r.id=f.request_id WHERE f.id=NEW.feedback_id)
BEGIN SELECT RAISE(ABORT, '피드백과 문서가 다릅니다.'); END;
CREATE TABLE self_assessment (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK(phase IN ('before','after')),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000),
  updated_at TEXT NOT NULL
);
CREATE TABLE personal_guideline (
  id TEXT PRIMARY KEY, text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000),
  scope TEXT NOT NULL CHECK(scope IN ('document','subject','global')),
  document_id TEXT REFERENCES document(id) ON DELETE CASCADE, subject TEXT,
  approved_at TEXT NOT NULL CHECK(length(approved_at) > 0), revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK((scope='document' AND document_id IS NOT NULL AND subject IS NULL)
     OR (scope='subject' AND document_id IS NULL AND length(subject)>0)
     OR (scope='global' AND document_id IS NULL AND subject IS NULL))
);
-- 관찰은 저장된 검토/버전/반응을 읽어 결정론적으로 계산한다. 삭제 표식은 재등장을 막는다.
CREATE TABLE observation_annotation (
  feedback_id TEXT PRIMARY KEY REFERENCES feedback_item(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 2000),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1))
);
CREATE TABLE growth_summary (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
