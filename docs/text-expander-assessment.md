# text-expander-element 对输入辅助项目的适配评估

研究日期：2026-09-14。源码核对版本：`bc415feace6e6a862e2d1d499acdca29ba0776f5`；该提交的 package.json 标为 2.2.2。只读取、运行纯匹配函数验证，未引入项目依赖，也未运行其完整浏览器测试套件。

## 结论

有借鉴价值，适合显式触发的快捷片段和引用菜单。目前不建议用它整体替换 AgentFleet 的输入辅助。它解决触发、展示、选择、替换，候选内容由调用方提供；不能提供中文 NLP、语义向量、专业语料或问答自动学习。

| 我们的需求 | 该组件提供什么 | 判断 |
| --- | --- | --- |
| `@` 引用、快捷片段 | keys 触发、multiword 查询、后缀、继续补全 | 适合未来独立入口，需避免冲突现有 Codex 命令 |
| 无触发符的“登录老掉” | 查找指定触发 key 后的文本 | 不是现成方案 |
| 中文专业表达 | 接收调用方的候选 DOM | 不包含分词、语料、消歧、改写或模型 |
| 异步后端建议 | provide 接收 Promise | 可借鉴接口；防抖、超时、取消、会话隔离仍需我们负责 |
| 本地建议立即显示，远端随后追加 | 等待全部 provider，然后取首个匹配 fragment | 不符合现有渐进合并，需要改造 |
| Tab、方向键与辅助技术 | 借助 combobox-nav 管理选择和 ARIA | 值得参考；也要避免与 React 快捷键重复处理 |
| 手机键盘收起仍保留建议 | 普通 blur 会 deactivate 菜单 | 与当前产品要求不同 |
| 桌面不跳动、手机最多四行 | 按输入光标定位菜单，样式由调用方提供 | 不自动解决键盘视口、碰撞避让、四行布局 |
| React 受控输入 | 直接写入原生 input.value，再发 committed 事件 | 要同步 React 草稿状态和选区，不能直接包一层就完成 |
| 历史问答学习 | 无 | 保留我们自己的后端机制 |

## 源码发现

`query.ts` 的词边界接受空白、英文左圆括号、英文左方括号。直接调用原函数的结果：

| 输入（触发符设为 @） | 结果 |
| --- | --- |
| `@登录` | 命中“登录” |
| `请 @登录` | 命中“登录” |
| `请@登录` | 不命中 |
| `请（@登录` | 不命中 |
| `登录老掉` | 不命中 |
| `@log in` | 单词模式不命中，multiword 模式命中 |

这说明它可以承载中文候选，但默认边界规则不是为自然中文连续输入设计的。

`text-expander-element.ts` 的 `onInput` 立即查询 provider；本体未在该入口过滤 composition 输入。锁文件中的 combobox-nav 2.0.2 会在 composition 期间抑制候选提交键，因此不能笼统说它完全不支持中文输入法；不过我们的“合成期间不发送 NLP 请求、不展示半成品候选”仍需要外层控制。

异步有效性检查主要核对旧匹配位置是否仍在当前文本长度内。它没有我们当前账号/会话/完整草稿标识校验，也没有 AbortController。由源码推断，同长度编辑、请求乱序等场景需要增加完整查询身份核验；这项判断不是已执行完整浏览器复现的上游缺陷报告。

菜单激活使用 dom-input-range 获取光标矩形后定位到光标下方，可通过 activate 事件启用 Popover。该组件本体未管理 VisualViewport 或移动端键盘高度，也没有我们已有的桌面输入框上方 Portal 和手机候选布局策略。

React 集成应监听 committed 并更新 state，或在 value 事件取消默认写入、由自身 draft reducer 完成替换；同时要统一选区、撤销、IME、Tab/Enter 事件归属。替换现有实现会增加适配与回归成本。

## 建议采用方式

1. 本轮保留已有 React 补全、桌面浮层、移动端行为和本地 NLP；不引入这个依赖。
2. 借鉴“触发 → provider → 候选 → 提交”的分层接口，逐步统一术语、语义、个人词库和未来历史案例的结果结构。
3. 若后续增加显式快捷片段或 Agent/文件引用入口，再做隔离原型，对比整体组件与仅使用 combobox-nav 的收益。它的价值主要在这一类功能。
4. 引入前必须实测中英文 IME、中文标点、异步乱序、账号/会话切换、移动键盘、Tab/Enter 与草稿撤销。依赖采用 MIT 许可；若复制改造源码需保留许可与版权声明。

来源：[README](https://github.com/github/text-expander-element)、[匹配源码](https://github.com/github/text-expander-element/blob/bc415feace6e6a862e2d1d499acdca29ba0776f5/src/query.ts)、[组件源码](https://github.com/github/text-expander-element/blob/bc415feace6e6a862e2d1d499acdca29ba0776f5/src/text-expander-element.ts)、[键盘依赖 2.0.2](https://unpkg.com/@github/combobox-nav@2.0.2/dist/index.js)、[MIT 许可](https://github.com/github/text-expander-element/blob/bc415feace6e6a862e2d1d499acdca29ba0776f5/LICENSE)。
