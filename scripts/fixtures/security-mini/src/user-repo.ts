// A12 观测夹具：故意含一处拼接 SQL（semgrep 内联规则应命中），
// 让安全域的工具通道真实派发，从而观测"完整一次运行"的工具派发序列。
// 注意：此处**不放**任何形似真实密钥的字符串——仓库 push protection 会拦下
// 夹具里的假密钥（见 AGENTS.md「提交纪律」），而这条夹具也不需要密钥。
export function findUser(db: { query: (sql: string) => unknown }, id: string): unknown {
  const sql = `SELECT * FROM users WHERE id = '${id}'`;
  return db.query(sql);
}
