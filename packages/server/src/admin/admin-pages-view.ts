/** 服务端 HTML 转义（P2-3 硬指标：所有回显字段必须转义，绝不依赖客户端 JS） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 页面骨架：导航 + 主内容区（管理后台所有页面共用） */
export function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - 智汇码盾管理后台</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#f5f6f8;color:#1f2328}
nav{background:#1f2328;color:#fff;padding:10px 20px;display:flex;gap:18px;align-items:center}
nav a{color:#fff;text-decoration:none;font-size:14px}
nav a:hover{text-decoration:underline}
main{max-width:1000px;margin:24px auto;padding:0 16px}
h1{font-size:20px}
h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f0f1f3}
textarea{width:100%;min-height:220px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;box-sizing:border-box}
input[type=text],select{width:100%;padding:5px;box-sizing:border-box;font-size:14px}
label{display:block;margin:12px 0 4px;font-weight:600;font-size:14px}
button{padding:6px 14px;cursor:pointer;font-size:13px}
form.inline{display:inline}
.msg{color:#b35900;font-weight:600}
.muted{color:#57606a;font-size:12px}
</style>
</head>
<body>
<nav>
  <strong>智汇码盾管理后台</strong>
  <a href="/admin-ui/rules">规则</a>
  <a href="/admin-ui/tools">工具</a>
  <form method="post" action="/admin-ui/logout" class="inline" style="margin-left:auto">
    <button type="submit">退出</button>
  </form>
</nav>
<main>
${body}
</main>
</body>
</html>`;
}

/** 登录页（无需鉴权） */
export function loginPageHtml(error?: string): string {
  const msg = error ? `<p class="msg">${escapeHtml(error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 - 智汇码盾管理后台</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f6f8;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#fff;padding:32px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);width:320px}
input[type=password]{width:100%;padding:8px;box-sizing:border-box;font-size:14px}
button{width:100%;padding:8px;margin-top:16px;font-size:14px;cursor:pointer}
h1{font-size:18px;margin-top:0}
.msg{color:#b35900;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <h1>智汇码盾管理后台</h1>
  ${msg}
  <form method="post" action="/admin-ui/login">
    <label for="token">管理令牌</label>
    <input type="password" id="token" name="token" autocomplete="current-password" required>
    <button type="submit">登录</button>
  </form>
</div>
</body>
</html>`;
}

/** 错误页（401/404/400 等） */
export function errorPageHtml(status: number, message: string): string {
  return pageShell(`错误 ${status}`, `<h1>${status}</h1><p>${escapeHtml(message)}</p>`);
}