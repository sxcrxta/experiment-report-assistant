-- 5단계: 문장 앵커 · 보고서 항목 경계 · 단계 진행 (PRD 4.2)
-- 여기 들어오는 값은 모두 프로그램이 정한 것이다. 모델은 대상도 단계도 정하지 못한다 (CLAUDE.md §2).

-- 문장 범위 피드백이 가리키는 문장.
-- 수정 뒤 이 문장을 다시 찾지 못하면 임의로 다른 문장에 붙이지 않고 'unresolved' 로 둔다 (PRD 4.2).
CREATE TABLE sentence_anchor (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  -- 앵커를 만든 시점의 문서 버전.
  version_id      TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  paragraph_uuid  TEXT NOT NULL,
  sentence_index  INTEGER NOT NULL CHECK (sentence_index >= 0),
  text            TEXT NOT NULL CHECK (text <> ''),
  -- 문단 텍스트 안에서의 위치 (문자 기준).
  char_offset     INTEGER NOT NULL CHECK (char_offset >= 0),
  -- core/document/sentence-anchor.ts 의 문장 해시. 다시 찾을 때 이 값만 본다.
  hash            TEXT NOT NULL,
  -- 'linked'        그 문장을 다시 찾았다
  -- 'unresolved'    찾지 못했다. 사용자 확인을 기다린다
  -- 'confirmed-lost' 사용자가 "찾지 못한 채로 두겠다" 고 확인했다
  status          TEXT NOT NULL CHECK (status IN ('linked', 'unresolved', 'confirmed-lost')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX sentence_anchor_by_document ON sentence_anchor(document_id);

-- 문장 범위 피드백은 앵커를 통해 문장에 연결된다. 문단 범위 피드백은 NULL.
ALTER TABLE feedback_item ADD COLUMN sentence_anchor_id TEXT REFERENCES sentence_anchor(id);

-- 사용자가 고친 보고서 항목 경계. 추정값은 저장하지 않는다 (매번 다시 추정한다).
-- 위치(번호)가 아니라 문단 UUID 로 저장해, 다음 저장에서 문단이 밀려도 경계가 따라오게 한다.
CREATE TABLE section_boundary (
  document_id          TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 1),
  title                TEXT NOT NULL CHECK (title <> ''),
  start_paragraph_uuid TEXT NOT NULL,
  end_paragraph_uuid   TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (document_id, ordinal)
);

-- 대상마다 어디까지 단계를 열었는가. 순서를 건너뛰지 못하게 하는 근거다 (PRD 4.2).
-- target_key 는 프로그램이 만든다 (app/review-stage.ts): 문단·문장·항목·전체가 각각 다른 키를 받는다.
CREATE TABLE review_stage_grant (
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  target_key  TEXT NOT NULL,
  stage       TEXT NOT NULL
              CHECK (stage IN ('question', 'weak_hint', 'strong_hint', 'explanation', 'example')),
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (document_id, target_key, stage)
);
