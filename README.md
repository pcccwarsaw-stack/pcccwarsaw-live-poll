# 一起选 Live Poll

完整现场偏好投票应用。主持人、手机和独立只读大屏共享服务端 SQLite 状态。没有正确答案，也没有正确率排名。预置题库是可编辑的真实活动输入，不是模拟投票数据。

**部署到 Cloudflare：请按 [Cloudflare 完整部署步骤](CLOUDFLARE-DEPLOY.md) 操作。** 已提供 Workers + SQLite Durable Objects 版本，支持 5 秒自动截止、首票锁定和持久保存；本地 Node/Docker 版本继续可用。

## 本地启动

需要 Node.js **24 或更高版本**、npm。使用 Node 内置 `node:sqlite`，无需另装数据库服务器。

```powershell
npm ci
Copy-Item .env.example .env
# 编辑 .env，设置 HOST_SECRET（至少 24 字符；建议随机 32 字节）
node --env-file=.env server.js
```

生成随机管理凭证：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。

浏览器打开 `http://localhost:3000/host`，输入管理凭证；参与入口为 `/`；扫码链接是 `/join/六位活动码`；大屏链接为 `/screen/活动ID`。localhost 二维码只适合本机验证，手机现场使用请按下面部署到真实 HTTPS 域名。

数据库、表和 10 道初始题自动初始化。已有题库不会被启动时重置。`npm start` 要求环境变量事先设置；`.env` 不会自动加载，推荐上面的 `--env-file` 命令。

## 公网部署：Docker + Caddy + 持久卷

这是需要运行服务的应用，不能上传到纯静态托管，也不能用浏览器存储替代数据库。建议一台 Linux VPS（1 vCPU / 1 GB RAM 起步），安装 Docker Engine 和 Compose 插件。

需要自行准备：服务器账号、域名和 DNS 管理权限。VPS 和域名通常收费；本应用不需要第三方登录、短信、二维码服务或其他 API 密钥。本次**没有进行公网部署**，也没有配置实际域名或签发证书。

1. 将源码放到服务器；将域名（如 `poll.example.com`）的 A 记录指向服务器公网 IPv4，只有服务器支持 IPv6 时才设置 AAAA。
2. 安全组/防火墙开放 TCP 80、443；如果启用 HTTP/3，可另开 UDP 443。不要暴露应用 3000 端口。
3. 在项目 `.env` 中配置：

```dotenv
DOMAIN=poll.example.com
HOST_SECRET=替换成自己生成的高强度随机凭证
```

4. 执行：

```sh
docker compose up -d --build
docker compose logs --tail=100 app caddy
```

5. 访问 `https://poll.example.com/host`，登录、创建活动、扫描二维码；二维码使用配置的实际域名。Caddy 自动申请及续期 HTTPS 证书，前提是 DNS 和端口正确。生产容器只接受 HTTPS 的 PUBLIC_ORIGIN，并使用 Secure Cookie。

`compose.yaml` 自动设置 PUBLIC_ORIGIN、COOKIE_SECURE、TRUST_PROXY、DB_PATH。Caddy 是唯一受信代理，应用端口仅供 Docker 内部网络访问。**不要把开启 TRUST_PROXY 的服务直接暴露公网**，也不要放到允许客户端自填 X-Forwarded-For 的代理后面。其他代理部署时必须覆盖此头。

更新：上传新源码，运行 `docker compose up -d --build`。固定卷 `together-live-poll-data` 保存数据库，重建容器不会重置题库或活动。不要执行 `docker compose down -v` 或删除数据卷。此方案是单主机部署；不能让多个机器各用独立 SQLite 文件并宣称共享状态。更大规模或高可用部署应迁移 PostgreSQL，并保留事务及唯一约束。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| HOST_SECRET | 必填，至少 24 字符；仅服务端使用，供主持人登录 |
| PUBLIC_ORIGIN | 参与链接及请求来源校验的可信 origin；不能包含结尾 `/`；本地默认 `http://localhost:3000` |
| PORT | 默认 3000 |
| DB_PATH | 默认 `./data/poll.sqlite`；必须放在持久磁盘/卷 |
| COOKIE_SECURE | HTTPS 自动开启；本地 HTTP 可设 false |
| TRUST_PROXY | 默认 false；仅唯一受信反向代理且后端不可公网直连时设 true |
| NODE_ENV | production 时强制 HTTPS origin |
| DOMAIN | Compose/Caddy 公网域名，不带协议和路径 |

修改 HOST_SECRET 会改变新登录凭证，已有登录会话最长仍有效 24 小时；紧急撤销需在维护窗口删除数据库中的 host sessions。不要把 `.env` 提交到 Git。

## 使用流程

- 主持人登录后可管理持久题库：新增、编辑、删除、上下排序、JSON 导入和导出。保存按钮写入数据库；导入仅替换编辑草稿，检查后点击保存。
- 创建活动会复制题库。此后修改全局题库不影响已经创建的活动；可在活动控制台单独编辑未开放题目。
- 已开放的题目永久锁定，不能修改、移动或删除。重新投票必须先公布并确认，生成新轮次，旧结果保留。
- 分享参与二维码或活动码；将**独立大屏链接**投屏，不要将主持人控制台投屏。
- 开始 → 5 秒收集投票（显示倒计时及已投人数）→ 自动结束并公布 → 下一题 → 开始。最后结束活动。直接结束投票中的活动也会关闭并公布当前轮次。
- 每人每轮只有一次投票机会，首次提交成功后立即锁定所有选项，不能改投；相同选项的网络重试不新增票。提交成功显示服务端确认的选择；重连、刷新和锁屏恢复通过服务器恢复状态。投票请求失败时不会宣称成功，重新同步后可重试。
- 控制台“历史结果”列出每个已公布轮次，包含重新投票轮次。结束后仍可访问历史。

## 题库格式

```json
[
  {
    "title": "你喜欢什么作息？ / What's your daily rhythm?",
    "options": ["早起鸟 / Early bird", "夜猫子 / Night owl"]
  }
]
```

允许仅中文、仅英文及 `中文 / English` 字符串。1–100 道题，title 1–500 字符，2–6 个选项，每项 1–200 字符；去掉首尾空格。JSON、类型、数量均在客户端和服务端校验。示例完整题库见 `questions.json`。

## 实时与计票设计

采用约 **1 秒 GET 轮询**，无需常驻 WebSocket 连接，适配常规反向代理。100 台设备约 100 个轻量读取请求/秒，当前规模易维护；实际 VPS 容量仍应现场验收。后台/锁屏暂停轮询，重新可见、pageshow、网络恢复时立即同步。公网用不同 Wi-Fi 或流量均可。

每轮固定 5 秒，开始或确认重新投票后，将截止时间 closes_at 写入数据库。服务端每 100 毫秒关闭到期轮次并公布结果；每个请求也检查到期，提交事务再次校验实际服务端时间，截止后拒绝收票。即使主持人关闭页面也会结束。服务停机期间到期的轮次，在重新启动时立即公布；重启不会延长投票时间。前端按服务器时间显示倒计时，到零禁用选项，结果通过约 1 秒轮询同步。主持人仍可提前手动公布。已有数据库自动增加截止字段，原来已开放超过 5 秒的轮次会直接公布，原始记录不丢失。

状态为 waiting、voting、results、ended。所有活动、题目、轮次、成员、投票和会话持久保存。SQLite WAL、busy_timeout、`BEGIN IMMEDIATE` 写事务共同保证开始/关闭/提交串行化；表唯一键 `(round_id, session)` 配合写事务保证只插入第一张票。已存在的相同选择视为幂等重试；不同选择返回 409，不修改票数或原选择。刷新、重新连接和重启服务均保持锁定。主持人确认重新投票后，新轮次重新获得一次机会。投票携带活动 ID、题目 ID、轮次 ID，服务端验证成员资格、范围和当前开放轮次。主持人控制还带状态/题号/轮次前置条件，避免双击或旧页面连续执行两次操作。

公布前公共 state **不含 counts、percentages、winners 或 result**；只有当前总有效票数。参与者只能额外看到自己的选择。history/questions/control/bank/events 接口全部验证主持人会话。已公布历史不含个人投票明细。整数比例用最大余数法，总有效票大于零时合计 100%；零票全部 0；并列最大值全部标记领先。

## 身份、安全与隐私边界

- 管理凭证通过 HTTPS 提交，服务端恒时比较哈希；发放 24 小时管理 Cookie，会话令牌仅保存哈希。参与链接和大屏 URL 没有管理凭证。
- 匿名 Cookie 有效 30 天，HttpOnly / SameSite=Strict，HTTPS 下 Secure。服务端记录活动成员，跨活动提交必须先加入相应活动。刷新后身份保持。
- 匿名去重**不能保证一人绝对一票**：更换设备、浏览器、清除 Cookie 都可能获得新身份。活动码和只读大屏是可分享的活动访问方式，不是保密门禁。
- 不收集姓名、邮箱、手机号；不记录原始 IP。限流数据库保存短期 IP/会话哈希计数并定期清理过期窗口；会话、投票为恢复目的持久保存，运营者应制定活动数据保留/清理周期。
- 每分钟登录每 IP 10 次、创建每 IP 10 次、加入每 IP 240 次（允许现场多人共用 Wi-Fi 出口）、投票每匿名会话 60 次。限流持久保存，重启不会绕过同窗口限制。大规模公开攻击需在反向代理/云防火墙补充流量控制。
- 所有写请求校验 Origin；无跨域开放；输入长度限制、参数化 SQL、前端文本转义、CSP、禁止嵌入 iframe。原生 confirm 用于重新投票和结束活动。

## 验证

```sh
npm test
```

测试启动真正 HTTP 服务、临时磁盘数据库，发放 100 个独立 Cookie 并行提交；不是伪造前端计票。详情见 `TEST-RESULTS.md`。测试使用固定本地端口 32187，需空闲；临时库保留在系统临时目录方便审查。

## 备份与恢复

生产数据库含 WAL 文件，不能在写入中仅复制主 `.sqlite` 文件。最简单一致备份：维护时 `docker compose stop app`，对 `together-live-poll-data` 卷完整归档（含 SQLite/WAL/SHM），然后 `docker compose start app`。也可使用 SQLite online backup API 制作一致快照。恢复时先停止 app，把完整备份恢复到同卷，保留 node 用户可写权限，再启动；备份包含会话令牌哈希，应私密存储。Caddy 证书数据也在独立卷。

实现依据：[Node SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)、[Docker 持久卷文档](https://docs.docker.com/engine/storage/volumes/)。
