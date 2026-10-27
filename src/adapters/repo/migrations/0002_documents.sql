-- 2단계: 문서 · 버전 · 문단 · 계보 · 변경 · 체크포인트
-- IMPLEMENTATION_PLAN.md §1.8 의 저장 모델 중 이 단계에 해당하는 부분만 만든다.
-- 지침(Rubric)·피드백·캐시·개인화는 각 단계에서 새 마이그레이션으로 추가한다.

-- 사용자가 직접 고른 문서. 경로는 NFC 로 정규화해서 저장한다 (macOS 는 이름을 NFD 로 준다).
CREATE TABLE document (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  -- 과목은 사용자가 등록할 때 입력한다 (PRD 4.4). 3단계 UI 가 채운다.
  subject       TEXT,
  created_at    TEXT NOT NULL,
  -- 경로를 잃으면 1. 재선택으로 같은 문서에 다시 이어 붙인다 (PRD 5절).
  path_lost     INTEGER NOT NULL DEFAULT 0 CHECK (path_lost IN (0, 1))
);

-- 저장을 감지한 시점의 스냅샷 메타.
CREATE TABLE document_version (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  detected_at     TEXT NOT NULL,
  -- 그 시점에 문서가 있던 경로. 재선택으로 경로가 바뀌어도 이력이 남는다.
  source_path     TEXT NOT NULL,
  byte_size       INTEGER NOT NULL,
  -- 파일 바이트의 sha256. 같은 내용이 다시 저장되었는지 보는 데 쓴다.
  content_hash    TEXT NOT NULL,
  paragraph_count INTEGER NOT NULL,
  UNIQUE (document_id, ordinal)
);

-- 버전 안의 문단. uuid 는 버전 사이에서 이어진다 (core/diff/track.ts).
CREATE TABLE paragraph (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id    TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  uuid          TEXT NOT NULL,
  para_index    INTEGER NOT NULL,
  section_index INTEGER NOT NULL,
  role          TEXT NOT NULL,
  heading_level INTEGER,
  style_name    TEXT,
  table_index   INTEGER,
  table_row     INTEGER,
  table_col     INTEGER,
  text          TEXT NOT NULL,
  -- 수식 스크립트 JSON 배열. 해시에 반영되므로 함께 남긴다.
  equations     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  UNIQUE (version_id, para_index)
);

CREATE INDEX paragraph_by_uuid ON paragraph(uuid);
CREATE INDEX paragraph_by_hash ON paragraph(hash);

-- 문단이 나뉘거나 합쳐졌을 때의 관계 (PRD 4.5, [Q-4]).
CREATE TABLE paragraph_lineage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  child_uuid  TEXT NOT NULL,
  parent_uuid TEXT NOT NULL,
  relation    TEXT NOT NULL CHECK (relation IN ('split', 'merge')),
  UNIQUE (version_id, child_uuid, parent_uuid)
);

CREATE INDEX paragraph_lineage_by_parent ON paragraph_lineage(parent_uuid);

-- 버전 사이의 변경. 해시가 같아 분석에서 빠진 문단은 여기에 들어오지 않는다.
CREATE TABLE diff_entry (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id          TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  previous_version_id TEXT REFERENCES document_version(id) ON DELETE CASCADE,
  change              TEXT NOT NULL
                      CHECK (change IN ('added', 'modified', 'deleted', 'split', 'merged')),
  paragraph_uuid      TEXT NOT NULL,
  previous_paragraph_uuid TEXT,
  -- 삭제된 문단은 새 버전에 자리가 없으므로 NULL.
  para_index          INTEGER
);

CREATE INDEX diff_entry_by_version ON diff_entry(version_id);

-- 복구용 원본 사본. 프로그램은 이 파일을 만들 때만 쓰고, 원본에는 쓰지 않는다.
CREATE TABLE checkpoint (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id   TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('initial', 'user')),
  file_path    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL
);

-- 최초본 체크포인트는 문서마다 하나뿐이다.
CREATE UNIQUE INDEX checkpoint_initial_once ON checkpoint(document_id) WHERE kind = 'initial';
CREATE INDEX checkpoint_by_document ON checkpoint(document_id);
