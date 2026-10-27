-- 6단계: 검토 결과 캐시 (PRD 4.5).
-- 문단 해시와 지침·프롬프트·모델·관점·단계가 모두 같은 경우에만 재사용한다.
-- 결과는 이미 스키마 검증을 통과한 피드백 템플릿만 저장한다. 원본 모델 응답은 저장하지 않는다.
CREATE TABLE review_cache (
  cache_key       TEXT PRIMARY KEY,
  paragraph_hash  TEXT NOT NULL,
  rubric_version  TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  perspective     TEXT NOT NULL,
  stage           TEXT NOT NULL,
  scope           TEXT NOT NULL,
  sentence_hash   TEXT,
  summary         TEXT NOT NULL,
  items_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX review_cache_by_paragraph_hash ON review_cache(paragraph_hash);
