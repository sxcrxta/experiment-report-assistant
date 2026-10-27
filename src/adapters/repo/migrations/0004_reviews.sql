-- 4단계: 검토 요청과 피드백 (PRD 4.2, 4.3, 4.5)
-- AI 응답은 프로그램이 스키마를 검증한 뒤에만 여기에 들어온다 (CLAUDE.md §2, §5).
-- 검증을 통과하지 못한 응답의 원문은 저장하지 않는다. 실패했다는 사실과 이유만 남긴다.
-- 캐시(6단계)와 문장 앵커(5단계)는 각 단계의 마이그레이션이 더한다.

CREATE TABLE review_request (
  id                    TEXT PRIMARY KEY,
  document_id           TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  -- 검토한 문서 버전. 피드백은 이 버전의 문단에 연결된다 (PRD 4.5).
  version_id            TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  -- 요청에 실린 확정 지침. 초안은 rubric_version 에 없으므로 여기에 올 수 없다 (CLAUDE.md §1).
  rubric_version        TEXT NOT NULL REFERENCES rubric_version(rubric_version),
  scope                 TEXT NOT NULL CHECK (scope IN ('sentence', 'paragraph', 'section', 'document')),
  stage                 TEXT NOT NULL
                        CHECK (stage IN ('question', 'weak_hint', 'strong_hint', 'explanation', 'example')),
  -- JSON 배열
  perspectives          TEXT NOT NULL,
  -- 외부로 보낸 문단(JSON 배열). 무엇이 나갔는지 보여 줄 수 있어야 한다 (CLAUDE.md §4).
  target_paragraph_ids  TEXT NOT NULL,
  context_paragraph_ids TEXT NOT NULL,
  -- 응답한 모델과 프롬프트 판. 기록만 하고 로직 분기에 쓰지 않는다 (CLAUDE.md §5).
  model_id              TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  requested_at          TEXT NOT NULL,
  completed_at          TEXT NOT NULL,
  -- 모델을 부른 횟수. 형식을 어긴 응답 때문에 다시 물은 횟수를 포함한다.
  attempts              INTEGER NOT NULL CHECK (attempts >= 1),
  status                TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  -- 성공했을 때만 있다.
  summary               TEXT,
  -- 규칙을 어겨 버린 항목 수. 사용자에게 몇 개를 버렸는지 알린다.
  dropped_count         INTEGER NOT NULL DEFAULT 0 CHECK (dropped_count >= 0),
  -- 실패했을 때만 있다. 사용자에게 보인 문구 그대로다.
  failure_reason        TEXT,
  failure_message       TEXT,
  CHECK (
    (status = 'succeeded' AND summary IS NOT NULL AND failure_reason IS NULL AND failure_message IS NULL)
    OR (status = 'failed' AND summary IS NULL AND failure_reason IS NOT NULL AND failure_message IS NOT NULL)
  )
);

CREATE INDEX review_request_by_document ON review_request(document_id, requested_at);

CREATE TABLE feedback_item (
  id                      TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL REFERENCES review_request(id) ON DELETE CASCADE,
  position                INTEGER NOT NULL,
  paragraph_uuid          TEXT NOT NULL,
  perspective             TEXT NOT NULL
                          CHECK (perspective IN ('format', 'figures', 'references', 'scientific_accuracy',
                                                 'logic', 'structure', 'expression')),
  stage                   TEXT NOT NULL
                          CHECK (stage IN ('question', 'weak_hint', 'strong_hint', 'explanation', 'example')),
  -- 6단계 우선순위 점수의 입력값일 뿐이다. 순위와 표시 여부는 프로그램이 정한다.
  severity                INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  body                    TEXT NOT NULL CHECK (body <> ''),
  rationale               TEXT NOT NULL CHECK (rationale <> ''),
  -- JSON 배열
  applied_rubric_item_ids TEXT NOT NULL,
  -- 예시는 사용자가 예시 단계를 요청했을 때만 있다 (PRD 4.2). 코드의 검증과 별개로 한 번 더 막는다.
  example                 TEXT,
  CHECK ((stage = 'example') = (example IS NOT NULL)),
  UNIQUE (request_id, position)
);

CREATE INDEX feedback_item_by_paragraph ON feedback_item(paragraph_uuid);

-- 실패한 요청에는 피드백이 달리지 않는다.
CREATE TRIGGER feedback_item_requires_success BEFORE INSERT ON feedback_item
WHEN (SELECT status FROM review_request WHERE id = NEW.request_id) IS NOT 'succeeded'
BEGIN
  SELECT RAISE(ABORT, '성공하지 않은 검토 요청에는 피드백을 저장할 수 없습니다.');
END;

-- 피드백의 단계는 요청한 단계와 같다. 모델이 단계를 올리지 못한다.
CREATE TRIGGER feedback_item_stage_matches BEFORE INSERT ON feedback_item
WHEN NEW.stage IS NOT (SELECT stage FROM review_request WHERE id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, '요청한 단계와 다른 피드백은 저장할 수 없습니다.');
END;

-- 피드백은 요청의 검토 대상 문단에만 달린다. AI 가 대상을 새로 만들지 못한다.
CREATE TRIGGER feedback_item_targets_request BEFORE INSERT ON feedback_item
WHEN NOT EXISTS (
  SELECT 1 FROM review_request r, json_each(r.target_paragraph_ids) t
  WHERE r.id = NEW.request_id AND t.value = NEW.paragraph_uuid
)
BEGIN
  SELECT RAISE(ABORT, '요청의 검토 대상이 아닌 문단에는 피드백을 저장할 수 없습니다.');
END;
