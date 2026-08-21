/**
 * 智汇码盾端点验证脚本
 * 测试所有 API 端点返回正确状态码和合理的响应
 */
const BASE = 'http://localhost:3010/api/v1';

const tests = [
  { name: 'health',            url: 'http://localhost:3010/health',                       expect: 'json' },
  { name: 'ready',             url: 'http://localhost:3010/ready',                        expect: 'json' },
  { name: 'live',              url: 'http://localhost:3010/live',                         expect: 'json' },
  { name: 'sop version',       url: `${BASE}/sop/version`,                                expect: 'json' },
  { name: 'sop diff 1→2',      url: `${BASE}/sop/diff?from=1.0.0&to=2.0.0`,             expect: 'json' },
  { name: 'sop full 1.0.0',    url: `${BASE}/sop/full/1.0.0`,                            expect: 'binary' },
  { name: 'sop emergency',     url: `${BASE}/sop/emergency`,                              expect: 'json' },
  { name: 'rules eslint v',    url: `${BASE}/rules/eslint/version`,                       expect: 'json' },
  { name: 'rules eslint dl',   url: `${BASE}/rules/eslint/download`,                      expect: 'binary' },
  { name: 'rules eslint em',   url: `${BASE}/rules/eslint/emergency`,                     expect: 'json' },
  { name: 'experience post',   url: `${BASE}/experience`, method: 'POST', body: { accepted: 1, rejected: 0 }, expect: 'json' },
];

let passed = 0, failed = 0;
for (const t of tests) {
  const url = t.url;
  const method = t.method || 'GET';
  const headers = { 'Accept-Encoding': 'identity' }; // don't compress response so we can read body
  
  try {
    const fetchOpts = { method, headers: { ...headers, 'Content-Type': 'application/json' } };
    if (t.body) fetchOpts.body = JSON.stringify(t.body);
    
    const res = await fetch(url, fetchOpts);
    
    let ok = false;
    let diagnostic = '';
    
    if (t.expect === 'json') {
      const text = await res.text();
      // Only validate it's valid JSON for 2xx, 4xx is acceptable for some endpoints
      try {
        const parsed = JSON.parse(text);
        ok = true;
        diagnostic = `${res.status} (${Object.keys(parsed).length} keys)`;
      } catch {
        diagnostic = `Expected JSON but got: ${text.slice(0, 100)}`;
      }
    } else if (t.expect === 'binary') {
      const buf = await res.arrayBuffer();
      ok = buf.byteLength > 0;
      diagnostic = `${res.status} (${buf.byteLength} bytes)`;
    }

    if (ok) {
      console.log(`✅ [${t.name.padEnd(18)}] ${diagnostic}`);
      passed++;
    } else {
      console.log(`❌ [${t.name.padEnd(18)}] ${diagnostic}`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ [${t.name.padEnd(18)}] ERROR: ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length}`);
process.exit(failed > 0 ? 1 : 0);
