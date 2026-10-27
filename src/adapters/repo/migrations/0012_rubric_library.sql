-- 평가 지침 모음 ([Q-40], 2026-09-22).
-- 지침을 보고서와 따로 만들어 두고 보고서에 적용한다. 적용하면 그 내용이 보고서의 확정 지침
-- (rubric_version) 으로 **복사**된다. 캐시 키·검토 기록은 지금처럼 보고서의 확정 지침만 본다.
-- 그래서 이 표들은 AI 호출에 직접 쓰이지 않는다. 모음의 내용은 적용(확정)을 거쳐서만 나간다.

CREATE TABLE rubric_template (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (name <> ''),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 모음 지침의 현재 항목. 고치면 통째로 바뀐다. 이력은 적용된 보고서의 확정 버전에 남는다.
CREATE TABLE rubric_template_item (
  template_id TEXT NOT NULL REFERENCES rubric_template(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  -- 적용한 보고서들이 같은 식별자를 쓴다. 반복 관찰이 보고서를 넘어 같은 항목으로 묶인다.
  item_id     TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (title <> ''),
  description TEXT NOT NULL,
  importance  INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
  PRIMARY KEY (template_id, position),
  UNIQUE (template_id, item_id)
);

-- 보고서가 어느 모음 지침을 적용했고, 지금도 따라가는지.
-- following = 0 이면 "보고서에서 고침". 모음을 고쳐도 이 보고서는 바뀌지 않는다.
-- 모음 지침을 지우면 이 행도 지워진다. 보고서의 확정 지침(rubric_version)은 그대로 남는다.
CREATE TABLE document_rubric_link (
  document_id TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES rubric_template(id) ON DELETE CASCADE,
  following   INTEGER NOT NULL DEFAULT 1 CHECK (following IN (0, 1)),
  applied_at  TEXT NOT NULL
);

CREATE INDEX document_rubric_link_by_template ON document_rubric_link(template_id);
