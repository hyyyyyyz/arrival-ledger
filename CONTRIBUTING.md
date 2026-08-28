# arrival-ledger 开发与提交规范

这份规则适用于人工开发、DeepSeek 生成代码和后续协作者。它比聊天中的临时建议更具体；若与用户当前明确要求冲突，以用户要求为准，并在提交说明中记录变更。

## 1. 工作边界

- P0 收货闭环优先，平台同步不能破坏拍照、离线队列、照片证据和已有数据库。
- 1688 使用后端官方 Open API（见 docs/ALI1688_OPEN_API.md）；PDD 保持 Windows 独立 Chrome 的可见、只读自动化。禁止平台内部接口。
- 不在服务器运行 Chrome/Playwright，不把账号密码、Cookie、profile 或支付数据上传服务器。
- 不绕过验证码、滑块、风控或登录保护；遇到阻断必须停止并报告。
- 不为了“让测试通过”关闭认证、放宽 CORS、删除数据库、跳过权限校验或写入假订单。

## 2. 分支与提交

推荐分支：

```text
codex/1688-open-api-mvp
```

提交使用 Conventional Commits：

```text
feat(sync): add headed browser sync-once command
fix(sync): stop on expired login state
test(sync): cover duplicate batch ingestion
docs(sync): document selector and recovery rules
```

规则：

1. 一个提交只解决一个可验证问题；不要把大规模格式化、重命名和业务改动混在一起。
2. 每个功能提交必须带自动测试或说明为什么只能人工验收。
3. 不使用 `git reset --hard`、`git clean -fd`、强制推送或覆盖他人分支。
4. 提交前必须检查 `git diff --check`、`git status` 和 staged diff。
5. 需要协作署名时使用：`Co-authored-by: Codex <noreply@openai.com>`；不得伪造其他人的署名。
6. 主分支只合并已验证的提交；未完成实验留在功能分支。

DeepSeek 建议按以下最小提交序列交付，便于逐步审查和回滚：

```text
docs(sync): freeze browser sync contract
feat(sync): add worker skeleton and offline doctor
feat(backend): add sync batch migration and ingest
feat(sync): add server-side 1688 Open API sync
feat(sync): add pdd visible-page adapter
test(sync): add sanitized fixtures and contract coverage
```

若某阶段未完成，不要把半成品伪装成“可部署”；提交正文应明确 `status: draft` 或 `status: ready`。

## 3. 代码风格

### Python 后端

- Python 3.11+，类型标注优先，函数保持单一职责；
- 业务解析、浏览器动作、传输、状态存储分层，不在一个函数里混合；
- 使用标准库 `logging`/结构化日志，禁止 `print` 输出凭据；
- 所有外部页面输入先做长度、类型和格式校验；
- 订单号、商品 ID、规格 ID、运单号全部按字符串保存；
- 数据库写入使用参数化 SQL 和事务；
- 新增依赖必须说明用途、版本和许可证，先询问再加入。

### TypeScript/Playwright 同步端

- Node.js 20 LTS，TypeScript strict，Playwright 版本锁定；
- `extract/` 中的解析器必须是纯函数，输入脱敏 DOM fixture，输出统一订单模型；
- `browser/` 只负责页面动作和状态守卫，`transport/` 只负责内部同步接口；
- 不使用无理由的 `any`，不把 selector 散落在 CLI 或服务端；
- 所有超时、重试、分页上限和批次大小显式配置；
- 日志统一 JSON 并自动 redact。

### Vue 前端

- 保持 `strict`，不要用无理由的 `any`；
- API 类型集中在 `frontend/src/types.ts`；
- 继续使用现有 IndexedDB 队列和幂等事件 ID，不另起一套上传逻辑；
- UI 必须区分“本机已保存”“服务器已同步”“待认领”“同步失败”；
- 不把 token、密码或服务器内部路径写进前端 bundle。

### 浏览器适配器

- 只读可见 DOM；选择器集中在平台适配器；
- 每次页面跳转/点击后重新检查登录和阻断状态；
- 页面不符合预期时返回明确错误，不猜字段、不静默跳过；
- 默认 headed；无“隐身/反检测/伪装人类”代码；
- 使用节流、有限重试和单 profile lock。

## 4. 测试门槛

提交前至少运行：

```bash
python -m pytest backend/tests
cd frontend && npm test -- --run
cd frontend && npm run typecheck
cd frontend && npm run build
```

若新增 `sync-agent/`：

```bash
cd sync-agent
npm ci
npm test
npm run typecheck
npm run build
npm run doctor -- --offline
```

真实平台测试不得进入 CI。测试 fixture 必须脱敏，不能包含真实手机号、地址、Cookie、二维码登录信息或完整订单截图。手工测试报告应写明平台、订单数量、成功/跳过/错误数、运行时间和是否出现登录保护。

## 5. 密钥与文件清单

禁止提交：

- `.env`、历史平台 AppSecret/access token、sync worker token、密码；
- Windows Chrome profile、Cookies、登录态、Downloads 原始导出；
- 未脱敏截图、HTML、网络日志、订单 CSV；
- 数据库、照片、备份、私钥和本地日志。

提交前执行：

```bash
git status --short --untracked-files=all
git diff --cached --check
git grep --cached -nE '(BEGIN .*PRIVATE KEY|github_pat_|gh[pousr]_|AKIA[0-9A-Z]{16})' || true
```

发现疑似凭据时立即停止提交，撤销/轮换凭据并报告，不要只删除工作树中的一份副本。

## 6. DeepSeek 交付格式

DeepSeek 每完成一个阶段必须回复并写入提交说明：

1. 改了哪些文件、为什么；
2. 实现了哪个接口/命令/状态；
3. 运行了哪些自动测试及结果；
4. 哪些步骤需要用户在 Windows 上手工操作；
5. 已知限制、风险和下一步；
6. commit hash 和是否可部署。

任何“测试通过”都必须给出实际命令和数量，不能只写“已验证”。

## 7. 合并前检查清单

- [ ] 只改当前任务范围；
- [ ] 无秘密、原始订单或 profile；
- [ ] 无平台 API/OAuth/平台内部接口回归；到货管家内部 sync endpoint 有权限、幂等和大小限制测试；
- [ ] 服务器端点权限、幂等和请求大小有测试；
- [ ] PDD 页面异常会熔断；1688 API 权限、网络和结构错误会 fail closed；
- [ ] 旧收货数据迁移兼容；
- [ ] 文档与命令和实际代码一致；
- [ ] `git diff --check`、后端测试、前端测试、构建均通过；
- [ ] 手工验收报告已附在 PR/提交说明中。
