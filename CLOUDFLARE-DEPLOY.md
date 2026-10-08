# 一起选 Live Poll：Cloudflare 部署步骤

使用 **Cloudflare Workers + SQLite Durable Objects + Workers Static Assets**。无需 VPS、Docker 或另建 D1 数据库；前端、后端和持久存储一并部署。`wrangler.jsonc` 已配置静态资源、数据库绑定和首次数据库迁移。

本次已通过官方 workerd 本地运行时测试和 Cloudflare 构建检查，**没有登录你的 Cloudflare 账号或进行公网部署**。下面的登录、管理凭证和资源创建由你在自己的账号完成。

## 网站部署：GitHub + Cloudflare 控制台

无需本地命令即可部署：Workers & Pages → Create application → Import a repository → 连接 GitHub → 选择 `pcccwarsaw-stack/pcccwarsaw-live-poll`。

| 设置 | 值 |
| --- | --- |
| Worker 名称 | `pcccwarsaw-live-poll`，与 wrangler.jsonc 一致 |
| 生产分支 | `main` |
| 构建命令 | 留空 |
| 部署命令 | `npx wrangler deploy`，也可用 `npm run deploy:cloudflare` |
| 根目录 | 仓库根目录，保持默认 |
| 构建变量 | `NODE_VERSION=24` |

保存并部署后，在这个 Worker 的 Settings → Variables and Secrets 添加**生产运行时 Secret**：名称 `HOST_SECRET`，值为自己保存的至少 24 字符随机密码，建议 32 字符以上。选择 Secret 并部署。不要只在 Build variables 设置 HOST_SECRET，构建变量不会传给运行时。

Workers Builds 连接 GitHub 后，向 `main` 推送提交会自动构建并部署。查看项目的 Builds / Deployments 确认成功，再刷新网站。域名和现有 Durable Object 数据由同一个 Worker 继续使用，数据库结构升级由应用自动执行。

**AI 报告功能：** Wrangler 已包含名称为 `AI` 的 Workers AI 绑定。部署后在“绑定”中确认已出现 Workers AI，然后在已结束活动的主持人总结中点击生成。无需另设 OpenAI 密钥。[网站配置、用量与测试边界](AI-REPORT.md)。

官方参考：[Git 构建流程](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/)。下面提供可选的命令行部署方式。

## 1. 准备账号和代码

准备 Cloudflare 账号，电脑安装 Node.js 24+ 和 Git。建议先用免费的 `workers.dev` 域名验证，然后再绑定自己的域名。已有项目直接执行：

```powershell
cd 'D:\教会\Game'
git pull --ff-only
npm ci
```

若在另一台电脑：

```sh
git clone https://github.com/pcccwarsaw-stack/pcccwarsaw-live-poll.git
cd pcccwarsaw-live-poll
npm ci
```

无需把 GitHub 仓库导入 Cloudflare Pages。这个项目通过 Wrangler 部署到 **Workers**，不是 Pages 静态网站。

## 2. 登录 Cloudflare

```sh
npx wrangler login
npx wrangler whoami
```

浏览器会打开 Cloudflare 授权页面，登录后授权 Wrangler；返回终端。`whoami` 应显示你要部署的 Cloudflare 账号。多账号时确认选择正确账号，必要时在 `wrangler.jsonc` 顶层填 `account_id`（账号 ID 不是密钥）。不要把 Cloudflare Token 发到聊天里或写进前端。

## 3. 首次部署

```sh
npm run deploy:cloudflare
```

首次使用 Workers 时可能提示设置 `workers.dev` 子域名。按提示完成。命令部署 Worker 并创建 `LivePollStore` 的 SQLite Durable Object namespace。

成功后终端输出类似：

```text
https://pcccwarsaw-live-poll.你的子域名.workers.dev
```

这是示例，不是已经部署成功的地址。以你终端输出为准。此时网页可打开；API 在没有管理凭证时会返回 503，并提示配置 HOST_SECRET。

## 4. 设置主持人管理凭证

本机生成一个新的随机凭证，保存到密码管理器：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

然后运行：

```sh
npx wrangler secret put HOST_SECRET
```

在终端提示时粘贴刚生成的凭证。输入通常不会显示，这是正常的。Wrangler 保存到 Cloudflare 的 Secret 并发布更新；无需写进仓库。该字符串就是主持人登录页面使用的管理凭证。不要使用 README 中的占位符或先前本地测试凭证。

通过控制台也可设置：在 Cloudflare 的 **Workers & Pages** 打开 `pcccwarsaw-live-poll`，在设置的 Variables and Secrets 处添加名称 `HOST_SECRET`、类型 Secret 的值并保存/部署。控制台标签可能随版本调整，CLI 是本指南的主要流程。

## 5. 验证公网应用

把以下示例域名替换成终端输出的真实地址：

```text
https://pcccwarsaw-live-poll.你的子域名.workers.dev/health
https://pcccwarsaw-live-poll.你的子域名.workers.dev/host
```

`/health` 应显示 `{"ok":true}`。主持人登录后创建一场活动。二维码和参与链接自动使用 Cloudflare 接收到的实际 HTTPS 域名；默认无需配置 PUBLIC_ORIGIN，也没有 localhost 地址写在前端。

用手机流量扫描二维码，再用另一台手机 Wi-Fi 加入同一活动。先设置并保存投票时长（1–300 秒，默认 5 秒），然后开始投票 → 显示对应倒计时 → 首次投票成功后锁定 → 自动公布 → 下一题 → 结束并自动打开总结看板。打开独立大屏验证同步。手机刷新后检查已选项仍锁定；最后重新部署一次，检查题库、时长设置、历史和总结仍在。

**本地测试活动不会自动搬到云端**。Cloudflare 的数据库独立于 `data/poll.sqlite`。需要沿用本地题库时，从本地主持人页面导出 JSON，再在云端题库导入并保存。已有活动、投票和浏览器 Cookie 不通过 JSON 题库导入迁移。

## 6. 可选：绑定自己的域名

自己的域名需要已加入同一 Cloudflare 账号并由 Cloudflare 管理 DNS。比如你想使用 `poll.example.com`，在 `wrangler.jsonc` 顶层加入：

```json
"routes": [
  { "pattern": "poll.example.com", "custom_domain": true }
]
```

再运行 `npm run deploy:cloudflare`。也可以在 Worker 的 Settings → Domains & Routes → Add → Custom Domain 添加同一子域名。Cloudflare 为 Custom Domain 处理 DNS 和 HTTPS 证书；不要把这个域名 CNAME 到 localhost。

默认每个域名都用自身作为参与链接 origin。若你希望所有二维码固定指向这个正式域名，可在配置顶层加入：

```json
"vars": { "PUBLIC_ORIGIN": "https://poll.example.com" }
```

保存后重新部署。此时主持人和参与者统一使用正式域名；从原 workers.dev 地址发起写操作会因 Origin 不一致被拒绝。这是预期行为。也可将 `workers_dev` 改为 false，仅提供正式域名。不要把 HOST_SECRET 放入 vars。

换域名后浏览器需要重新登录/加入，因为 Cookie 按域名隔离；数据库仍是同一个。部署期间始终保留 Worker 名称、`LivePollStore` 类名、`POLL_STORE` 绑定、`v1` 迁移和 `live-poll-v1` 实例名称，常规更新才能复用已有持久状态。

## 7. 更新代码

```sh
git pull --ff-only
npm ci
npm run deploy:cloudflare
```

Secret 保存在 Cloudflare，不在 GitHub，普通更新不需重新设置。不要删除 Worker、Durable Object namespace 或把数据库实例名称改掉，否则会得到新的空数据库。自动建表使用 `IF NOT EXISTS`，已有题库不会被预置 10 题覆盖。

若已经在 Cloudflare 控制台连接 GitHub 的 Workers Builds，更新 `main` 会自动部署。只采用上述命令行方式、未连接 Git 构建时，需要自己运行部署命令。无需另配 GitHub Actions 令牌。

## 配额和费用

截至 2026-10-08，SQLite Durable Objects 可用于 Workers Free 和 Paid。免费计划有每日请求、SQL 行读取/写入和存储上限，超过后相应操作会失败；不能保证正式活动永远免费。

当前手机在前台约每秒轮询一次。100 台设备保持页面前台 30 分钟，仅轮询约 180,000 次，还不含主持人、屏幕和提交；这超过 Durable Objects 免费计划 100,000 请求/日。SQL 免费行读取额度也可能更早耗尽。30–100 人正式活动请提前核对账号用量，考虑 Workers Paid，并在控制台查看请求数与读写用量。域名本身另行收费；若使用 workers.dev 可先不购买域名。没有替你开通付费计划。

官方参考：[Durable Objects 计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)。

## 平台实现与验证边界

`src/app.js` 共用所有业务规则：身份、题库、活动、轮次、投票及服务器验证。Node 使用本地 SQLite 写事务；Cloudflare 使用 Durable Objects `transactionSync`。云端全部活动放在一个持久 SQLite Object 中，通过活动 ID 完全隔离；适合当前规模，不宣称大量活动的水平扩容已经验收。

截止时间持久写入 rounds。云端 Alarm 记录最早截止时间，处理到期轮次后预约下一次，避免依赖 Workers 的进程内 setInterval。Alarm 可能受平台调度延迟影响，但每次状态读取也关闭过期轮次，提交事务按实际服务端截止时间拒绝迟到票，因此延迟不会增加有效投票时间。展示仍由约 1 秒轮询同步。

云端建表无需单独执行 D1 migration。SQLite Durable Objects 与 D1 是两种不同的 Cloudflare 存储产品。本方案没有 D1 binding，也不要执行 D1 初始化命令。

本地 Cloudflare 预览（独立于 3000 端口版本）：

```powershell
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars，把 HOST_SECRET 换为自己的测试凭证
npm run dev:cloudflare
```

访问 `http://localhost:8787/host`。本地 Cloudflare 状态位于忽略提交的 `.wrangler` 目录，重新启动可恢复。`.dev.vars` 不会上传到公网，生产 Secret 必须按步骤 4 单独配置。

测试和构建：

```sh
npm run test:node
npm run test:cloudflare
npm run build:cloudflare
```

Cloudflare 测试启动真正的 workerd 和 SQLite Durable Object，发放 100 个独立匿名 Cookie、并行提交，并在没有 HTTP 轮询时直接读取持久数据库验证 Alarm 公布；还重启 workerd 检查题库、身份和历史恢复。这不是云端公网负载测试，也不是 100 台真实手机测试。结果见 `cloudflare-test-results.txt` 和 `TEST-RESULTS.md`。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| API 503，提示 HOST_SECRET | 执行 `npx wrangler secret put HOST_SECRET`，至少 24 字符，保存后等待部署完成 |
| 登录提示凭证错误 | 输入生产 Secret，不能使用本机测试凭证 |
| 请求来源不匹配 | 确认浏览器域名与 PUBLIC_ORIGIN 一致，无结尾 `/`；不需要固定域名时移除该变量 |
| 找不到 POLL_STORE 或 SQL API | 保留 wrangler 的 durable_objects 绑定、new_sqlite_classes 迁移和类名；通过 Wrangler 部署 |
| 免费额度耗尽 | 查 Workers 和 Durable Objects Analytics；升级前自己确认价格或等额度重置 |
| 题库部署后变空 | 检查是否部署到另一个账号/Worker，或改了 namespace / 类 / 实例名称 |
| 需要备份 | Cloudflare SQLite Durable Objects 支持平台 PITR，可恢复过去 30 天内状态；生产恢复需按官方文档在维护窗口操作，本任务未执行或验证云端恢复 |

官方依据：[SQLite Durable Object 存储与事务](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[Secret](https://developers.cloudflare.com/workers/configuration/secrets/)、[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
