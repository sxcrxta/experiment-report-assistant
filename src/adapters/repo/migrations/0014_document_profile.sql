-- [Q-48] 검토·다듬기와 평가 지침을 떼어 낸다.
-- 검토는 이제 "문서 종류" 를 참고한다. AI 가 짐작하고(목차를 나눌 때 함께), 사용자가 고칠 수 있다.
-- 사용자가 고친 종류(source='user')는 AI 가 다시 짐작해도 덮지 않는다.
CREATE TABLE document_profile (
  document_id TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind <> ''),
  source      TEXT NOT NULL CHECK (source IN ('ai', 'user')),
  model_id    TEXT,
  updated_at  TEXT NOT NULL
);

-- 평가 지침은 "제출 양식·필수 내용 점검표" 가 된다. 점검은 사용자가 누를 때만 AI 가 한다.
-- 결과는 보고서마다 마지막 한 번만 둔다. 어느 버전·어느 점검표로 했는지 함께 남긴다.
CREATE TABLE document_check (
  document_id    TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  rubric_version TEXT NOT NULL REFERENCES rubric_version(rubric_version) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  results_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
