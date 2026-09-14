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
