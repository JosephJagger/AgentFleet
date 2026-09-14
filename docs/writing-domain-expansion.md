# 视频、哲学与认知词库扩充

新增 164 个双语概念：84 个视频制作概念，80 个哲学与认知概念。每个概念包含中英文名称与原创简释，另含 LUT、CBR、VBR、VFR、J cut、L cut 等常用别名。它是可持续补充的常用词库，不宣称穷尽领域。

视频覆盖剪辑结构、修剪、转场、动画、抠像合成、调色、媒体管理、编码、音频和字幕。哲学与认知覆盖知识、实在、伦理、论证、心灵、记忆、注意、认知偏差和学习方法。偏差名称用于帮助提出问题，不据此判定用户或他人的心理状态。

词条保存在 `apps/control-plane/src/writing-glossary.json`；运行 `node apps/control-plane/scripts/export-writing-terms.mjs` 生成浏览器词表与表达规则。另增加 10 个场景、20 条中英文口语例句，覆盖 J/L 剪辑、音乐闪避、速度渐变、字幕时间、论证前提、实然应然、确认偏误、沉没成本与提取练习。共享场景参与后端匹配；明确例句也可即时匹配。

简释与例句由本项目撰写，并非复制第三方词典。术语核对参考：
- Adobe 剪辑工具：https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html
- Adobe J/L 剪辑：https://helpx.adobe.com/ie/premiere/desktop/edit-projects/trim-clips/perform-j-cuts-and-l-cuts.html
- Stanford Encyclopedia of Philosophy 知识分析：https://plato.stanford.edu/entries/knowledge-analysis/
- Stanford Encyclopedia of Philosophy 先天知识：https://plato.stanford.edu/entries/apriori/

内置词库随版本发布，自动学习内容继续存 SQLite。即时补全在浏览器运行，避免每次按键依赖数据库请求；没有为这次扩充引入额外数据库。
