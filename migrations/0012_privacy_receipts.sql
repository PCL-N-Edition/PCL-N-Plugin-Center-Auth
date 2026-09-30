-- v1.0 登录/接受界面使用同一个勾选项：接受条款并知悉隐私政策。
-- 仅修复该明确版本已有的接受记录，不替用户确认任何后续政策版本。
INSERT OR IGNORE INTO privacy_notice_receipts(user_id,policy_id,provided_at)
SELECT ta.user_id, pd.id, ta.accepted_at
FROM terms_acceptances ta
JOIN policy_documents td ON td.id=ta.policy_id AND td.id='terms-1.0'
JOIN policy_documents pd ON pd.id='privacy-1.0'
WHERE ta.accepted_at>=pd.effective_at;
