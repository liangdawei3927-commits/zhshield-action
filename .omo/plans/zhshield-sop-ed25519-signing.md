# Plan: SOP 规则包签名 Ed25519 非对称化迁移

来源：8/30 项目评估报告 P2-2（Ed25519 规则包签名链路定稿未开发）。经 oracle 评审确认 GO，本计划为决策完整版，执行者无需再访谈。

## Objective
将 SOP 规则包签名从对称 HMAC-SHA256 迁移为 Ed25519 非对称签名：服务端持 Ed25519 私钥签名，桌面端持公钥验签。消除"`resolveSopPublicKey` 分发可伪造签名的对称密钥"这一信任模型漏洞，同时保持旧缓存包（无 `alg` 字段）仍可验证。

## Background（现状核实）
- `packages/kernel/src/sop/security/sop-signer.ts`：`signPackage(rules, secretKey, version)` 排序→sha256 hash→`HMAC-SHA256(secretKey, `${hash}:${timestampISO}`)`；`verifyPackage(pkg, secretKey)` 校验时间戳窗口 + hash + 签名；`verifyPackageWithKey(pkg, key)` 当前只是 `verifyPackage` 别名（"publicKey" 实为对称密钥）。
- `packages/kernel/src/sop/_meta/sop-types.ts` `SignedSopPackage{version,rules,signature,hash,timestamp}` **无 alg 字段**。
- `packages/kernel/src/sop/cache/sop-signature-verifier.ts`：ctor 收 `publicKey`；`verifySignature` → 无 publicKey 则放行（fail-open），否则 `SopSigner.verifyPackage(pkg,key)`。
- `packages/desktop/electron/ipc-context.ts` `resolveSopPublicKey()`：env `ZH_SOP_PUBLIC_KEY` > fetch `SOP_BASE/public-key`（返回 `{publicKey}`）。桌面经 SopCacheManager 与 `ipc/sync.ts` 的 `verifyPackageWithKey(pkg, publicKey)` 使用。
- `packages/server/src/sop/sop.service.ts`：`signPackage(secretKey)`/`verifyPackage(signedPkg, secretKey)`；**未发现**私钥 env 接线与 `/public-key` 路由实现。
- 独立关注点（**不要改动**）：`signRequest`/`verifyRequest`（API 请求 HMAC）、`encryptRules`/`decryptRules`（AES-256-GCM）。

## Constraints
- 不执行 git commit（本计划只产出改动，提交由用户确认）。
- 不使用 `as any` / `@ts-ignore` / 非空断言 `!`。
- `signRequest`/`verifyRequest` 与 `encryptRules`/`decryptRules` 逻辑保持不变（清单外连动禁止）。
- 现有 29 个签名测试必须保持绿（它们走 HMAC 旧路径，默认-缺省路径）。
- 保持 `pnpm typecheck`（19 包）、`pnpm --filter @zh/kernel exec vitest`、`pnpm --filter @zh/desktop exec vitest`、`pnpm --filter @zh/server exec vitest` 全绿。

## 决策（经 oracle 确认）
1. **算法**：node:crypto `generateKeyPairSync('ed25519')`；`sign(privateKey, data)` / `verify(publicKey, data, sig)`。
2. **编码**：全部 **PEM**。私钥 `{type:'pkcs8',format:'pem'}`，公钥 `{type:'spki',format:'pem'}`。签名 `signature` 字段 base64。
3. **签名输入（规范）**：签名 `${hash}:${timestamp.toISOString()}` —— 与现 HMAC 输入逐字节一致，仅替换 MAC 原语。`timestamp` 用 `Date` 对象，但**签名与验签必须用同一规范字符串**（`toISOString()`）；JSON 往返后不得重序列化 Date（否则破坏签名）。
4. **兼容 / alg 分发**：`SignedSopPackage` 增加**可选** `alg?: 'hmac-sha256'|'ed25519'`。`verifyPackage` 分发：`alg==='ed25519'` → Ed25519 路径；`!alg || alg==='hmac-sha256'` → 旧 HMAC 路径；**其它值 → fail-closed 抛错/返回 invalid（绝不静默降级 HMAC）**。新 `signPackage` 默认设 `alg:'ed25519'`，但保留可调用 HMAC 路径（显式 alg 参数）以兼容旧验证/回滚/测试。
5. **密钥管理**：服务端 `ZH_SOP_PRIVATE_KEY` = PEM PKCS8 Ed25519 私钥（`createPrivateKey(env)`）；桌面保留 `ZH_SOP_PUBLIC_KEY` env pin + `/public-key` 返回 SPKI PEM 公钥。**绝不在 `/public-key` 暴露 HMAC 对称密钥**。
6. **重放窗口拆分（连带修复潜在 bug）**：`verifyPackage` 现对缓存规则包强制 ±5min 窗口，离线缓存的合法陈旧规则会验签失败。拆分：请求路径保留 5min（`requestWindowMs`）；规则包路径改为**不做过期检查或大窗口 `cacheWindowMs`**（签名证真伪，新鲜度归缓存层 TTL）。
7. **`verifyPackageWithKey` 重命名语义**：改为收 **公钥** 而非对称密钥；`ipc/sync.ts` 调用点传公钥。改成 `verifyPackageWithPublicKey`，杜绝"把私钥/对称密钥当公钥传"的信任模型错误。
8. **未知 alg fail-closed**；**不在生产把无 publicKey 当放行**（SopSignatureVerifier 当前 fail-open，加 strict 开关）。

## TODOs
- [ ] 1. `packages/kernel/src/sop/_meta/sop-types.ts`: `SignedSopPackage` 增加 `alg?: 'hmac-sha256'|'ed25519'`（可选，注释说明缺省=hmac-sha256）；新增 `SignedSopAlg` 联合类型。

- [ ] 2. `packages/kernel/src/sop/security/sop-signer.ts` 新增 Ed25519 原语与 alg 分发：
   - 新增 `static signEd25519(rules, privateKey, version?)` 与 `static verifyEd25519(pkg, publicKey)`。
   - `signPackage` 默认 alg='ed25519'（私钥），保留 HMAC 路径（显式 alg='hmac-sha256' / legacy 重载）兼容旧验证与回滚；产出包设 `alg`。
   - `verifyPackage` 按 `pkg.alg` 分发（缺省→hmac；'ed25519'→ed25519；其它→invalid/fail-closed，绝不静默降级）。
   - `verifyPackageWithKey` 重命名为 `verifyPackageWithPublicKey`（Ed25519 公钥），旧名保留为 HMAC 兼容别名（标注 deprecated）。
   - 拆分重放窗口：请求 `requestWindowMs`(5min) 与规则包 `cacheWindowMs`(大值/跳过) 分离；`verifyPackage`(规则包) 用 cache 窗口。
   - 统一 timestamp 规范字符串工具，避免 JSON 往返重序列化 Date 破坏签名。

- [ ] 3. `packages/kernel/src/sop/cache/sop-signature-verifier.ts`: `verifySignature` 透传 `verifyPackage`（其内部已按 alg 分发）；可选新增 `strict` 开关（无 publicKey 时 fail-closed 而非放行）。

- [ ] 4. `packages/desktop/electron/ipc-context.ts` `resolveSopPublicKey()`: 保留 `ZH_SOP_PUBLIC_KEY` pin；支持 PEM/raw 归一化；`/public-key` 期望返回 SPKI PEM。

- [ ] 5. `packages/desktop/electron/ipc/sync.ts` `verifySopPackage`: 改用 `verifyPackageWithPublicKey(pkg, publicKey)`（传公钥，非对称密钥）。

- [ ] 6. `packages/server/src/sop/sop.service.ts`: 从 `ZH_SOP_PRIVATE_KEY`(PEM PKCS8) 加载私钥，`signPackage` 用 Ed25519 签名；新增 `/public-key` 路由返回 SPKI PEM 公钥（**绝不返回 HMAC 对称密钥**）。

- [ ] 7. 保持 `sop-signer.test.ts`(14) 与 `sop-cache-manager-verify.test.ts`(15) 现 29 绿（HMAC 旧路径不变）。

- [ ] 8. 新增兼容矩阵测试：
   - 旧 HMAC 包（无 alg）仍可验签
   - 新 Ed25519 包（alg='ed25519'）用公钥验签通过
   - 篡改 rules/hash/timestamp → 验签失败
   - 错误公钥 → 失败
   - `alg:'unknown'` → fail-closed（抛错/无效），非静默 HMAC
   - 跨算法负例：HMAC 包不能走 Ed25519 路径通过，反之亦然（无算法混淆）
   - PEM 私钥→签名 / PEM 公钥→验签往返；base64 签名 JSON 往返
   - 重放配置：缓存包旧时间戳在新 cache 窗口下通过；请求超窗失败

## 恢复路径
- 若引入回归导致 kernel/desktop/server typecheck 或签名测试失败，回退到 `git checkout -- <改动文件>`；本计划涉及文件均在单仓内，原状为 HMAC 全通（29 测试绿）。
- 兼容设计保证旧缓存包头（无 alg）在迁移后仍可验证，故不破坏既有部署。

## Final Verification Wave
- [ ] F1. `node scripts/typecheck.mjs` 19/19 全绿
- [ ] F2. `pnpm --filter @zh/kernel exec vitest run src/__tests__/sop-signer.test.ts src/__tests__/sop-cache-manager-verify.test.ts` 全绿（含新增矩阵）
- [ ] F3. `pnpm --filter @zh/desktop exec vitest run` 全绿
- [ ] F4. `pnpm --filter @zh/server exec vitest run` 全绿
- [ ] F5. lint 干净（`pnpm lint` error 级零阻断）
- [ ] F6. 确认 `/public-key` 只返回 Ed25519 公钥，绝无对称密钥
