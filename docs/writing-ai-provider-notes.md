# AI 优化服务商适配

2026-09-14：设置提供 DeepSeek、OpenAI（ChatGPT）和自定义兼容接口预设。已有配置按官方域名识别，不覆盖用户保存的地址和模型；切换预设清除输入中的密钥，后端更换地址不沿用已保存密钥。只有用户点击 AI 优化才调用模型。

DeepSeek 预设 `https://api.deepseek.com`、`deepseek-flash`。官方地址无需添加 `/v1`。线上旧请求复现 HTTP 200、finish_reason=length，思考内容 1376 字符，正文 316 字符，JSON 被截断。原因是默认思考模式与仅 700 token 输出额度、最多三个改写版本组合不适合短文本优化。

修复：DeepSeek 官方域名显式 `thinking.type=disabled`；请求一个精炼改写、不解释、不扩写需求，最多 500 字符；输出额度 2400 token 是上限，不是目标长度。请求超时 30 秒，检查结束原因，并对截断、超时、鉴权、余额、限流、配置和格式错误提供中英文提示，不透传供应商原始错误内容。

OpenAI 预设 `https://api.openai.com/v1`、`gpt-4.1-mini`（低延迟、无思考步骤），使用 `max_completion_tokens`。自定义兼容接口保留 `max_tokens`，不注入 DeepSeek 参数。模型名可编辑；其他模型的参数支持与账户权限仍由服务商决定。

来源：
- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://api-docs.deepseek.com/guides/json_mode/
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

## 减少调用与输入上下文

相同账号、工作区、会话、配置、原始草稿与词库内容的成功结果缓存 10 分钟，含“暂无建议”的空结果。缓存最多 128 条，仅驻留服务进程内存，重启清空，不写入数据库或浏览器存储。键为上述内容的 SHA-256，不存储原草稿；配置保存清空缓存，词库新增、编辑、删除或来源失效都会改变版本。每次查缓存前仍验证会话访问权限与启用状态。使用次数和排序变化不会使缓存失效。

相同请求在执行期间合并为一个模型调用，失败不缓存。不同草稿仍独立处理；最多 64 个不同请求同时执行。缓存与请求合并目前覆盖单个后端进程，多副本部署需要共享缓存或协调层。

词库从固定前 30 条改为中英文分词相关性筛选：优先术语命中，其次至少两个解释词命中，排除常见泛词，去重后最多 5 条；没有相关词条时省略 vocabulary。该步骤不调用外部 API，也不额外运行模型。词条只是补充上下文，未命中仍会把原始草稿交给 AI 优化。

回归测试验证并发重复请求只调用一次、重复点击复用、失败重试、空结果缓存、10 分钟过期、会话隔离、权限检查、配置与词库变化失效，以及中英文词条选择与数量上限。
