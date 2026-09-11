-- writeback 回扫索引：强杀补投递（finalizeForcedRuntimeReclaim）与「run 结束的未消费回写回扫」
-- 都按 (session_id, message_kind, created_at) 过滤 messages。
-- 归属：packages/domain/src/session/runtime.ts 的 findStrandedWritebacks / findUnconsumedWritebacks。
-- 注意：messages 表由 0001 创建（总是已存在），索引由 init.ts 的 ensureMessagesWritebackIndex
-- 在每次启动时无条件 CREATE INDEX IF NOT EXISTS，本文件仅作 schema 变更记录。
CREATE INDEX IF NOT EXISTS idx_messages_session_kind_time ON messages(session_id, message_kind, created_at);
