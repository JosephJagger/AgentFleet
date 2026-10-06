# Temporary reset signals / 临时重置预测

这是公告提示，不是额度计算：不会修改原生周额度、下次重置时间或重置卡数量，也不会编造概率或时间。

- 控制面通过 TikHub 获取 @thsottiaux 的帖子，所有用户和主机共享结果。通常每小时一次，不因浏览器刷新而调用。
- 只分析发布于最近 24 小时的新帖子；DeepSeek Flash 为每条生成简短中文说明，并区分无关消息、将要重置、已完成重置，以及重置卡发放消息。
- 帖子正文和分析详情按发布时间滚动保留 7 天，满 7 天后清除，不在零点统一清空。另存最近 10,000 个已分析帖子 ID 去重，不保存其过期正文；过期帖子即使再次返回也不会重新分析。
- 点击主机右侧“临时重置预测”打开最近 7 天的消息时间轴，最新在上，每页 5 条，可查看原帖。翻页只读取缓存，不触发采集或分析。弹窗限高并在内部滚动。点数大于 0 时仍优先展示点数。
- 历史保留与预测有效期独立：只有最近 24 小时的消息参与预测和分析上下文；旧消息仅供回看，不延长预测。已删除的历史不自动补抓，上线后逐步积累。
- 发现信号后暂停当天采集，次日北京时间或信号满 24 小时失效时恢复，以先到者为准。缓存中已无有效信号时不会继续暂停。暂停期间新帖不会立即显示。账号额度上涨或新增重置卡可以清除该账号提示，但不会修改原生额度或恢复当日采集。
- 正常每天约 24 次 TikHub 请求。补取每轮最多 5 页，全局每天最多 48 次（失败请求也计入）。分析失败可在下小时重试；已成功分析的帖子不会重复分析。
- 按每次 $0.001 估算，基础采集约 $0.024/天、$0.72/30 天；翻页与 Flash 模型费用另算，以提供方实际账单为准。
- 源未配置、采集或分析失败会明确显示，不能当作“无重置信号”。

在服务器未纳入版本管理的 .env 中配置：
AGENTFLEET_TIKHUB_API_KEY、AGENTFLEET_RADAR_DEEPSEEK_KEY，及可选 AGENTFLEET_RADAR_MODEL（默认 deepseek-flash）。
缓存保存在控制面数据目录 reset-radar.json，重启后沿用，不在主机 Agent 中采集。

## English

This feed reports announcements; it never changes native quotas, reset times or reset-card balances. No invented probability or deadline is shown.

The control plane shares one hourly TikHub feed across users and hosts. DeepSeek Flash analyzes only new posts published within the last 24 hours, producing short Chinese summaries and classifying reset announcements versus confirmations. Content is retained for a rolling seven days; a bounded ID-only deduplication index prevents repeated analysis. Clicking the host forecast card opens a newest-first seven-day timeline with original links, five posts per page and a height-limited scrolling body. Pagination reads cached results only. Prediction eligibility and analysis context remain limited to 24 hours; older announcements are historical only. Previously deleted history is not backfilled.

A detected signal pauses collection until the next Beijing calendar day or signal expiry (24 hours), whichever comes first. A stale pause without a valid cached signal never blocks collection. Normal collection is about 24 requests/day; catch-up is capped at five pages per poll and 48 requests/day globally. At $0.001/request, the baseline is approximately $0.72 per 30 days, excluding extra pages and model charges. Provider errors are displayed separately from no signal.

Configure the optional environment variables listed above in the ignored server .env. Persistent cache lives beside the control-plane database; no Agent upgrade is required.

TikHub endpoint documentation: https://docs.tikhub.io/191321711e0
