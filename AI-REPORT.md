# 主持人 AI 分析报告

活动结束后，在主持人“活动总结”中选择“现场投票”或“模拟测试”，点击 **生成并保存报告**。报告包括整体观察、有题号依据的共同点与差异、下次活动建议。可复制或下载包含原始统计依据的 UTF-8 `.txt` 文件。已有活动也可生成。

每场只保存一份成功报告，刷新、重新登录、重新部署和重复点击均读取数据库缓存，不重新调用模型。生成期间离开页面，可稍后回到总结查看状态。模拟报告明确标注测试数据；生成成功后数据类型固定。

## Cloudflare 网站配置

代码使用真实的 **Cloudflare Workers AI**，默认模型 `@cf/qwen/qwen3-30b-a3b-fp8`。`wrangler.jsonc` 已增加 `"ai": {"binding": "AI"}`，GitHub 自动部署会将绑定配置到同一个 Worker，无需 OpenAI 账号或单独的 AI API 密钥。

1. 等待 Cloudflare 的 GitHub 构建部署成功。
2. 在 `pcccwarsaw-live-poll` 的“绑定”中确认 **Workers AI**，变量名称必须为 **AI**。若未出现，通过“添加绑定 → Workers AI”添加，名称填写 `AI`，保存并部署。不要修改已有 `POLL_STORE`。
3. 打开 `/host` 登录，进入已结束活动的总结，选择数据类型，点击生成。
4. 如账号首次使用 Workers AI 时要求接受服务条款，请在你自己的 Cloudflare 控制台完成。不要为此分享管理密码或 Token。
5. 在 Cloudflare Workers AI 的用量页面查看账号实际 Neuron 消耗。应用不会读取账号账单或宣称有剩余额度。

可选运行时变量 `AI_MODEL` 可以指定另一个支持聊天消息及 JSON 输出的 `@cf/...` 模型；部分模型需要付费权限。正常使用默认值即可。

官方说明：[绑定配置](https://developers.cloudflare.com/workers-ai/configuration/bindings/)、[模型与输入参数](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)、[价格和免费额度](https://developers.cloudflare.com/workers-ai/platform/pricing/)。截至 2026-10-09，免费/付费 Workers 均有每日 10,000 Neurons 免费额度，00:00 UTC 重置；免费方案超额后请求失败，继续使用需自行升级。付费方案超出免费额度的 AI 用量按 $0.011 / 1,000 Neurons 收费。额度按账号使用，报告消耗与题量及实际输出长度有关，不能保证固定报告份数。

## 本地 Node 运行

本地不提供假报告。若未配置真实 AI，投票和原始总结仍正常，AI 区域显示未连接服务。

需要本地测试真实生成时，在未提交 Git 的 `.env` 中设置：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的32位Cloudflare账号ID
CLOUDFLARE_AI_TOKEN=该账号的Workers AI API Token
AI_MODEL=@cf/qwen/qwen3-30b-a3b-fp8
```

然后 `node --env-file=.env server.js`。在 Cloudflare Workers AI 页面选择“Use REST API → Create a Workers AI API Token”，使用官方预填模板；自行创建时，按[官方 REST 指南](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)配置对应账号的 Workers AI Read 和 Edit 权限。本地通过 Cloudflare 官方 HTTPS REST API 调用，同样计入额度。Workers 生产版本直接使用绑定，不使用此 Token。

## 分析与资源边界

- 服务端校验主持人 Cookie 和同源请求，只允许结束活动后生成和查看；参与页及只读大屏接口不暴露报告。
- 只发送各题最后公布一轮的题目、选项、票数、比例、并列第一和匿名加入数。旧重投轮次不重复合计，不发送活动码、参与链接、会话标识、IP 或个人逐题选择。主持人填写的题目/选项本身会发送给 Cloudflare。
- 匿名加入数不等于可验证的独立人数，跨题总票次也不是人数。聚合数据不能得出个体画像、跨题关联、因果关系或代表整个团队的结论。
- 输入 JSON 上限 24,000 字符，输出最多 1,800 tokens；超长题库在调用前拒绝，现有投票结果不受影响。模型输出通过格式、长度和题号校验，并作为转义文本展示；语义准确性仍需主持人核对下方原始结果。
- 数据库持久记录生成状态及任务标识，原子占用防止同时生成。模型超时 60 秒；中断任务两分钟后可以手动重试。不会自动重新调用，每场最多 3 次尝试，主持人每分钟最多 5 次新尝试，全应用每分钟最多 10 次。成功后不支持重新生成，以避免重复消耗。
- 失败、超时或中断可能已消耗平台额度。超时的绑定请求无法保证取消云端推理；本应用不会自动追加调用。报告仅保存在原有 SQLite / Durable Object 持久数据库中。

## 实际验证

新增 15 项自动测试（计入两个父测试）：20 个并发生成仅调用模型一次；只传最后一轮汇总；零票/未进行题与模拟标签；主持人鉴权和同源校验；缓存、进程重建后恢复、两活动隔离；失败冷却/三次上限；中断恢复；输入边界；Cloudflare 绑定和 REST 响应解析、格式校验、内部诊断脱敏；导出鉴权及 UTF-8 内容；结束后新加入的匿名身份不会改写报告生成时的统计依据。

模型与外部传输使用测试替身，未消耗你的 AI 额度。真实 Cloudflare 模型的中文报告质量、线上账号权限和用量尚未验收；需要部署后由主持人点击真实生成核对。`npm test` 全部 44 项通过，Cloudflare dry-run 确认 AI、POLL_STORE、ASSETS 三项绑定。桌面浏览器已核对界面和已保存文本，复制/下载仍需 Chrome 或 Edge 实际验收；详见 [完整测试边界](TEST-RESULTS.md)。
