// NCL-011 邮件抽象：业务代码只依赖此接口，具体服务商通过环境变量接入。
// 目前支持 Resend（设置 RESEND_API_KEY）；未配置时降级为日志记录，不阻塞业务流程。
const FROM = 'Nexa Cloud <noreply@pcln.top>';
function nullMailer() {
  const log = (kind, to) => console.info(JSON.stringify({ mail: kind, to: Boolean(to) }));
  return {
    send: async (to, subject) => log(subject, to),
    accountDeletionRequested: (to, at) => log(`account.deletion.requested:${at}`, to),
    accountDeletionCancelled: to => log('account.deletion.cancelled', to),
    accountDeletionCompleted: to => log('account.deletion.completed', to),
    securityNotice: (to, detail) => log(`security:${detail}`, to)
  };
}
export function createMailer(env) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return nullMailer();
  const send = async (to, subject, text) => {
    if (!to) return;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: FROM, to, subject, text })
      });
      if (!response.ok) console.error(JSON.stringify({ mail: 'send.failed', status: response.status }));
    } catch (error) { console.error(JSON.stringify({ mail: 'send.error', error: error.name })); }
  };
  return {
    send,
    accountDeletionRequested: (to, at) => send(to, '你的 Nexa Cloud 账户注销申请已收到', `我们已收到你的注销申请，将于 ${at} 生效。在此期间登录账户即可撤销注销。`),
    accountDeletionCancelled: to => send(to, '你的 Nexa Cloud 账户注销已撤销', '你已撤销注销申请，账户继续保持正常可用。'),
    accountDeletionCompleted: to => send(to, '你的 Nexa Cloud 账户已注销', '账户注销已完成，个人资料已删除或匿名化。依法需要保留的记录将与普通账户分离受限保存。'),
    securityNotice: (to, detail) => send(to, 'Nexa Cloud 账户安全通知', detail)
  };
}
