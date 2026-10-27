-- 3단계: 평가 지침 (PRD 3절 2번, 4.1, 4.5)
-- 확정 전 초안과 확정한 지침을 다른 테이블에 둔다. 초안은 어떤 AI 호출에도 쓰이지 않는다 (CLAUDE.md §1).

-- 확정 전 초안. 문서마다 하나. 확정하면 지운다.
CREATE TABLE rubric_draft (
  document_id TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  updated_at  TEXT NOT NULL
);

CREATE TABLE rubric_draft_item (
  document_id TEXT NOT NULL REFERENCES rubric_draft(document_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  item_id     TEXT NOT NULL,
  -- 초안은 쓰는 중이므로 이름이 비어 있을 수 있다. 확정할 때 검사한다.
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  importance  INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  PRIMARY KEY (document_id, position),
  UNIQUE (document_id, item_id)
);

-- 사용자가 확정한 지침. 지침을 바꾸면 새 행이 생기고 이전 행은 그대로 남는다.
CREATE TABLE rubric_version (
  -- core/rubric/version.ts 가 계산한 값. 캐시 키에 들어간다.
  rubric_version TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 1),
  content_hash   TEXT NOT NULL,
  confirmed_at   TEXT NOT NULL,
  UNIQUE (document_id, ordinal)
);

CREATE TABLE rubric_item (
  rubric_version TEXT NOT NULL REFERENCES rubric_version(rubric_version) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  item_id        TEXT NOT NULL,
  title          TEXT NOT NULL CHECK (title <> ''),
  description    TEXT NOT NULL,
  -- 6단계 우선순위 점수의 "평가 기준 중요도" 입력값
  importance     INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  PRIMARY KEY (rubric_version, position),
  UNIQUE (rubric_version, item_id)
);

-- 확정한 지침은 고치지 않는다. 바꾸려면 새 버전을 확정한다.
CREATE TRIGGER rubric_version_immutable BEFORE UPDATE ON rubric_version
BEGIN
  SELECT RAISE(ABORT, '확정한 지침은 고칠 수 없습니다. 새 버전으로 확정해 주세요.');
END;

CREATE TRIGGER rubric_item_immutable BEFORE UPDATE ON rubric_item
BEGIN
  SELECT RAISE(ABORT, '확정한 지침은 고칠 수 없습니다. 새 버전으로 확정해 주세요.');
END;

-- 항목을 덧붙이거나 지우는 것은 트리거로 막지 않는다. 그렇게 바뀐 지침은 내용 해시가 맞지 않아
-- 다시 읽을 때 확정 지침으로 인정되지 않는다 (core/rubric/model.ts 의 restoreConfirmedRubric).
