-- 보고서 목차 ([Q-47]). AI 가 제안한 제목 문단과 급. 범위는 저장하지 않는다 — 프로그램이 매번 계산한다.
-- 문단은 uuid 로 가리키므로 본문을 고쳐도 제목 문단이 그대로면 목차가 이어진다.
-- signature 는 짧은 문단(제목 후보)들의 해시다. 제목이 바뀌면 달라져 "다시 분석" 을 권한다.
CREATE TABLE document_outline (
  document_id    TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  signature      TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  items_json     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
