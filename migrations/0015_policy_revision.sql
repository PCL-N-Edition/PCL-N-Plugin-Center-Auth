-- 1.1 文档归档 1.0 原始字节；hash 对应 Web/public/legal/current/*.zh-CN.md 的 SHA-256。
-- 只切换当前版本。不得将旧条款接受或隐私告知回执伪造为 1.1 接受/回执。
-- Wrangler 的迁移与测试 D1 batch 原子执行。publisher/refunds 继续使用原 1.0。
INSERT INTO policy_documents(id,kind,version,locale,effective_at,content_hash,current) VALUES
  ('terms-1.1','terms','1.1','zh-CN','2026-10-01','9033b50cfb0e14f4f4758adf610bb063529ec2443d879420105479cf067729f5',0),
  ('privacy-1.1','privacy','1.1','zh-CN','2026-10-01','8e45f1f498b955232abc6e149acc5c7f71fb5e70f5e1b1e8b1c5eeb28911520b',0);

UPDATE policy_documents SET current=CASE
  WHEN id IN ('terms-1.1','privacy-1.1') THEN 1 ELSE 0 END
WHERE kind IN ('terms','privacy') AND locale='zh-CN';
