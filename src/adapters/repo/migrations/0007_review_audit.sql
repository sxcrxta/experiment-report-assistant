-- 이미 적용한 마이그레이션은 고치지 않는다. 과거의 attempts>=1 제한을 교체한다.
ALTER TABLE review_request RENAME COLUMN attempts TO legacy_attempts;
ALTER TABLE review_request ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
UPDATE review_request SET attempts = legacy_attempts;
ALTER TABLE review_request DROP COLUMN legacy_attempts;
-- 대상은 피드백을 연결할 전체 범위, sent_*는 실제 외부 전송 범위다. 캐시 적중이면 빈 배열.
-- 과거 기록에는 실제 전송 내역이 없으므로 추정값을 채우지 않고 NULL(알 수 없음)로 둔다.
ALTER TABLE review_request ADD COLUMN sent_target_paragraph_ids TEXT;
ALTER TABLE review_request ADD COLUMN sent_context_paragraph_ids TEXT;
-- 구 캐시는 문단 정체성을 구분하지 않아 신뢰할 수 없다. 원본 검토 기록은 보존한다.
DELETE FROM review_cache;
