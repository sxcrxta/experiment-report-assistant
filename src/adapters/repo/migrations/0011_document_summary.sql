-- 보고서 목록에 보여 줄 한 문단 요약 ([Q-36], 2026-09-17).
-- 문서마다 하나만 두고, 어느 버전을 보고 쓴 것인지와 어느 모델이 썼는지를 함께 남긴다.
-- 버전이 바뀌면 덮어쓴다. 요약은 보조 표시일 뿐이므로 이력을 쌓지 않는다.
--
-- **번호가 10 이 아니라 11 인 이유** (2026-09-18):
-- 10 번은 개발 중에 만들었다가 커밋 전에 지운 `document_pdf` 가 이미 쓴 번호다. 그 파일이 있던
-- 동안 앱을 실행한 DB 에는 10 번이 적용된 것으로 남아 있어서, 같은 번호를 다시 쓰면 실행기가
-- "이미 적용됨" 으로 건너뛰고 이 표가 만들어지지 않는다. 실제로 그렇게 되어 보고서 목록을
-- 읽지 못했다. **번호는 한 번 나간 뒤로 다시 쓰지 않는다.**
CREATE TABLE document_summary (
  document_id    TEXT PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  version_id     TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 위에서 말한 그 표를 치운다. 지운 기능의 잔재이고 아무 코드도 쓰지 않는다.
-- 들어 있던 값은 사용자가 고른 PDF 경로뿐이라 잃을 기록이 없다.
DROP TABLE IF EXISTS document_pdf;
