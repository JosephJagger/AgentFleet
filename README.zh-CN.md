<p align="center">
  <img src="docs/assets/hero.svg" alt="AgentFleets for Codex — Your hosts. One workspace." width="100%">
</p>

<p align="center">
  <a href="https://github.com/JosephJagger/AgentFleet/actions/workflows/ci.yml"><img src="https://github.com/JosephJagger/AgentFleet/actions/workflows/ci.yml/badge.svg" alt="Build and test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-55def2?labelColor=111e35" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/deployment-self--hosted-a18bff?labelColor=111e35" alt="Self-hosted">
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文<br><br>
  <a href="#自行部署">开始使用</a> · <a href="#围绕原生会话构建">功能一览</a> · <a href="#与-codex-有什么区别">与 Codex 对比</a> · <a href="#我们的愿景">愿景</a> · <a href="CONTRIBUTING.md">参与贡献</a> · <a href="SECURITY.md">安全报告</a>
</p>

<p align="center"><strong>打开浏览器，接着做你的 Codex 工作。</strong><br>
统一查看多台主机的对话，继续同一个原生会话。<br>
任务始终在你自己的环境中执行。</p>

<p align="center">面向 Linux 服务器和个人电脑的 Codex CLI 运维控制台，可自行部署。<br>在同一个中英文网页界面中管理原生会话、提交文件与图片、使用已安装插件技能并查看用量。</p>

![AgentFleets 工作台，展示原生额度、点数余额、会话消耗和运行中的 Codex 对话，全部使用虚构模拟数据](docs/assets/workspace-zh.png)

<p align="center"><sub>真实产品界面，使用虚构演示数据，不包含生产账号、主机或会话。</sub></p>

## 多台主机上的 Codex，一个控制台管理

当多台电脑都运行 Codex 时，管理这些工作本身也需要花时间：会话在哪台主机、哪些任务还在执行、完成的结果去哪里找、模型如何配置、额度消耗在哪里。**AgentFleets 把这些日常操作集中到一个图形化工作台。**

可以把每台接入的主机看作 Codex 执行任务的环境，把 AgentFleets 看作统一管理这些执行环境的控制台。尤其对于**没有桌面环境的 Linux 服务器**，服务器运行 Codex 和 Agent，你在另一台电脑的浏览器里操作即可，执行主机无需安装图形桌面。完成配对后，各主机主动连接控制面，日常会话管理不必逐台打开 SSH 终端。

| 已实现的特色 | 改善的日常体验 |
| --- | --- |
| **Codex 会话图形化管理** | 按主机、项目浏览对话，继续原生会话，在面板调整模型配置与执行权限。 |
| **跨任务复用会话** | 复制会话链接，或从输入框选择源会话。配置面板 AI 模型后，系统分段总结已同步的可读历史，并把固定摘要快照随下一条消息发送；未同步历史会标明，不共享实时上下文或权限。 |
| **文件、文件夹和图片提交到远端会话** | 通过同一个附件菜单粘贴图片或上传受限的文件与文件夹；AgentFleets 安全落盘到所选主机，再发送原生 Codex 路径引用。 |
| **原生目标、计划模式和插件技能** | 设置持续生效的会话目标，将下一轮切换为主机支持的协作模式，并从已安装、已启用的 Codex 插件中选择技能。 |
| **直接查看主机任务产物** | Codex 回复中链接的项目文件可从消息里预览或下载；文件按需从对应主机传输，并限定在该会话登记的项目内。 |
| **多主机任务集中查看** | 跟进运行中的任务，找回已完成但仍接管的会话，排队后续消息，查看已记录 token 和账号上报额度。 |
| **可切换的界面主题** | 提供 17 套主题，新浏览器默认使用天空之城；包括五套中国风主题，配套插画、消息气泡、Markdown、代码框和输入框样式。 |

### Linux 没有桌面，也能方便地提交图片

例如，在笔记本上截取页面异常，粘贴到面板，选择 Linux 主机上的会话，让 Codex 在那台主机的项目中排查。当前输入框支持粘贴 **PNG、JPEG、WebP 图片，每条消息最多 4 张**，可预览，并自动缩放、压缩。发送图片需要宿主机运行时和所选模型支持图片输入。

Codex CLI 本身支持图片和本地路径输入，AgentFleets 将这些流程带到浏览器，并连接到已配对的远端主机。参见 [Codex CLI 官方文档](https://learn.chatgpt.com/docs/codex/cli)。输入框的 `+` 菜单支持图片、最多 32 个文件，也可选择文件夹并保留相对目录结构；单个文件不超过 4 MB，合计不超过 8 MB。支持经过结构校验的 PDF、无宏 XLSX、UTF-8 文本、常见源码、配置和结构化数据。浏览器、控制面和主机 Agent 都会校验内容，二进制文件改后缀也不能通过；其他 Office 格式、压缩包、音视频和可执行文件会被拒绝。通过校验的文件会落到所选项目中，再以原生路径引用交给 Codex。Codex 在回复中链接的项目文件，也可以按需从执行主机预览或下载。

## 不必先懂术语，也能说清楚想做什么

知道自己想解决什么，却想不起专业名称，或不知道怎样描述，往往会打断工作。**输入辅助把找词和整理表达放在对话旁边，让你先用熟悉的语言提出需求，再决定怎样发送。**

- **边输入，边找到合适的词。** 中英文术语建议覆盖编程、Agent、办公、工程、游戏、视频剪辑、哲学与认知。无论是“波纹剪辑”还是“元认知”，都可以在输入时寻找，不必为了一个名称中断对话。
- **口语也能成为清晰的问题。** “先听到下个镜头的声音再切画面”可以得到声音先入的剪辑表达；“我是否只找支持自己观点的证据”可以得到检查确认偏误的建议。建议帮助你把问题说清楚，不替你预先下结论。
- **需要时，主动优化表达。** 点击 **“优化表达”**，获得一个力求保留原意与约束的精炼改写。AI 生成的结果带有来源标签，你可以采用、继续编辑，或保留原文。
- **常用表达逐渐积累。** 从已同步对话中自动积累符合条件的术语与明确改写，不必手工维护词库，也不必逐条审核。
- **手机和电脑都顺手。** 手机点选建议，桌面可用 Tab 接受输入补全；移动端较长的表达建议最多显示四行，为输入保留空间。

在设置中选择默认输入辅助选项，各会话可以继承，也可以单独调整。基础补全与本地表达建议无需外部 AI 账号；可选的 **“优化表达”** 使用你配置的模型服务。

我们希望减少找词和组织语言造成的中断，让专业用户与非专业用户都更容易提出清晰的请求。词库会持续扩充，建议帮助表达，但不代表能够理解所有说法。

### 看看输入辅助如何使用

输入术语的一部分，找到需要的专业名称，再点选建议，不必离开当前对话。

![中文术语补全：在虚构的视频剪辑对话中输入“波纹剪”，显示“波纹剪辑”建议](docs/assets/features/completion-zh.jpg)

| 手机上整理表达 | 选择适合自己的辅助方式 |
| --- | --- |
| ![中文移动端表达优化：为对白期间的背景音乐调整提供带 AI 标签的改写建议](docs/assets/features/rewrite-zh.jpg) | ![中文输入辅助设置：选择术语补全、表达建议与自动积累等选项](docs/assets/features/settings-zh.jpg) |
| 点击 **“优化表达”**，先阅读精炼改写，再决定是否填入草稿。 | 设置一次默认选项，各会话可以继承，也可以单独调整。 |

*截图来自真实界面，使用虚构对话与模拟建议，不包含生产账号数据或真实模型返回。*

## 我们的愿景

**每一台电脑，无论什么系统，都以 Codex 为统一操作入口，由 AgentFleets 统一连接、调度和管理。**

我们希望，从编写代码、管理文件，到使用应用、维护系统，都可以通过 Codex 完成。AgentFleets 将这些电脑连接成一个工作台，让你在一处下达任务、查看进度和管理权限，不必反复切换设备，也不必为不同操作系统学习另一套操作方式。

Codex 负责在每台电脑上执行，AgentFleets 负责统筹所有电脑，而你决定它们可以做什么。

目前 AgentFleets 已支持在受支持的 Linux、macOS 和 Windows 主机上管理 Codex 原生会话。接下来希望逐步走向更广泛的 Codex 运维入口：

- **统一的电脑操作入口：** 从单个编程会话，扩展到不同操作系统上的日常应用管理与系统维护。
- **跨主机协同工作：** 探索带有任务依赖和进度跟踪的多主机工作流。当前面板管理的是各主机上的会话，尚未提供一个任务自动跨主机调度，也不会迁移会话及 Git 状态。
- **更丰富的远端输入：** 在当前受限文件、文件夹、图片、目标、计划模式和已安装插件能力上继续扩展，同时保留宿主机校验。

这些是未来方向，并非已交付功能或发布时间承诺。支持任意操作系统、覆盖电脑上的所有操作，仍是长期愿景。目前提供的是 Codex 会话运维，尚不是通用的服务器监控、系统补丁管理或多人权限平台。

## 围绕原生会话构建

<table>
<tr>
<td width="33%" valign="top"><h3>快速找到当前工作</h3>点击运行中、已接管或在线主机，再选择目标，直接回到对应会话或主机，省去跨项目逐层查找。</td>
<td width="33%" valign="top"><h3>接着原来的会话工作</h3>接管、发送消息，再释放回宿主机。重命名只改变标题，保留原生会话身份。</td>
<td width="33%" valign="top"><h3>让任务继续推进</h3>实时跟进输出，给当前轮次补充指令，或排队下一条消息。按会话配置执行权限。</td>
</tr>
<tr>
<td valign="top"><h3>有把握地恢复</h3>结果不确定时冻结写入。核验宿主机后手动解冻，不自动重放可能产生副作用的操作。</td>
<td valign="top"><h3>看清存储占用</h3>按文件类型和会话查看暂存附件，先预览再确认受支持的清理，保留对话文字和原生会话身份。</td>
<td valign="top"><h3>沿用模型与思考深度</h3>继承 Codex 的模型和推理强度，统一设置主机默认值，再按会话单独调整，不必为每段对话重复配置。</td>
</tr>
<tr>
<td valign="top"><h3>读取原生账号额度</h3>展示宿主机 Codex 上报的周额度、5 小时额度和当前点数余额。</td>
<td valign="top"><h3>追踪已记录 token</h3>按项目和会话比较总消耗、本周消耗，并查看单轮与本周缓存命中率。</td>
<td valign="top"><h3>为一轮任务补充完整上下文</h3>添加受支持的文件、文件夹和图片；通过 <code>+</code> 或 <code>@</code> 选择已安装插件；在输入框持续显示目标和计划模式。</td>
</tr>
</table>

### 快速回到正在推进的工作

左侧状态计数也是快捷入口：点击分类，再选择对应主机或会话，就能直接进入。任务分散在多台主机、多个项目时，不必记住对话在哪个项目，也不必逐层展开查找。

| 快捷入口 | 可以找到什么 |
| --- | --- |
| **运行中** | 存在活动轮次的会话，包括等待你回答或确认的任务 |
| **已接管** | 当前仍由 AgentFleets 接管的会话，尤其是已经执行完成、需要查看结果或继续追问的会话 |
| **在线主机** | 当前已连接的主机，可直接进入对应工作台 |

**运行中看进度，已接管找结果。** 任务完成后会退出“运行中”；只要没有释放接管，就仍可从“已接管”快速找回，检查执行结果或继续发送下一条指令，无需重新翻找主机和项目。“已接管”也包含仍在运行的会话，并非仅显示已完成任务。

计数和已打开的列表会随上报状态更新。**“已接管”表示当前仍在接管，不是“最近访问”或“曾经接管”**；释放后的会话不会作为接管历史留在这里。这让跨主机、多任务之间的切换更直接，把查找会话的时间留给处理任务。

### 模型与思考深度，按工作习惯继承

输入框上方显示已保存的模型与推理强度，点击即可直接定位模型配置。未保存或保存失败的修改不会更新消息栏或发送配置；正在运行的任务保持原配置。

没有设置面板覆盖时，沿用 Codex 自身配置；也可以为主机统一保存默认值，再为特定会话单独调整。已有的项目配置同样参与继承，优先级从高到低为：

**会话配置 → 项目配置 → 主机默认 → Codex 自身配置。**

例如，主机保持日常使用的模型和推理强度（思考深度），复杂任务单独选择受支持的模型或更深的推理；任务结束后清除该会话的覆盖，即可恢复适用的默认配置。宿主机运行时支持时，还可选择计划／执行模式、服务档位和沟通风格。

保存按钮会按当前选择的保存范围判断状态。表单与已保存的主机、项目或会话配置一致时，按钮保持灰色禁用；修改任一配置后恢复可用，保存成功或改回已保存值后再次禁用，让下一次发送前是否存在待保存修改一目了然。

- **减少重复设置：** 保存的配置可在多个会话中复用，不必每次重新选择模型和思考深度。
- **看得清配置来源：** 查看当前选用的配置来源、最近读取的运行时值，以及主机上次接受的设置；保存了偏好不等于已确认供应商最终使用的模型。
- **修改边界明确：** 保存的默认值用于后续发送，不改写宿主机的 `config.toml`，也不改变已经运行的轮次。可选项根据宿主机上报能力校验。

结合“运行中看进度、已接管找结果”、原生会话连续性、消息队列和明确的恢复流程，这些都是 AgentFleets 着重改善的日常操作体验。这些是产品特色，不代表其他 Codex 客户端没有类似能力。

### 让较长的原生会话继续可用

AgentFleets 始终继续同一个 Codex 原生 Thread，保留它的历史和身份。对话变长后，Codex 会使用自身的自动上下文管理；需要主动控制时，也可从会话工具请求原生上下文压缩，无需另建会话。面板会分别显示请求已受理和最终结果，因为受理不代表压缩已经完成。

输入框附近会持续显示当前目标、计划模式、插件、模型和思考深度。插件既可从 `+` 菜单选择，也可输入 `@` 搜索；只展示当前在线主机实际声明可用的能力。

### 适合不同工作环境的主题

现有 **17 套主题**，新浏览器默认使用「天空之城」。中国风包括大闹天宫、哪吒闹海、白蛇传说、清明上河和千里江山；其他主题包括赛博朋克、骇客帝国、冰雪奇缘等。主题覆盖场景插画、组件边框、消息气泡、Markdown 表格与引用、代码框和输入框。

桌面端可在左侧栏“已接管”下方切换主题；窄屏和移动端可从导航菜单切换，设置页也提供完整主题选择。布局会随移动端宽度调整，选中的主题会保存在当前浏览器中。

以下均为模拟截图，使用虚构数据。查看 **[全部 17 套桌面主题与 6 张手机预览](docs/themes.zh-CN.md)**。

| **大闹天宫**<br>[![大闹天宫 模拟截图](docs/assets/themes/wukong-desktop.jpg)](docs/themes.zh-CN.md) | **千里江山**<br>[![千里江山 模拟截图](docs/assets/themes/jiangshan-desktop.jpg)](docs/themes.zh-CN.md) |
| --- | --- |
| **白蛇传说**<br>[![白蛇传说 模拟截图](docs/assets/themes/whitesnake-desktop.jpg)](docs/themes.zh-CN.md) | **骇客帝国**<br>[![骇客帝国 模拟截图](docs/assets/themes/matrix-desktop.jpg)](docs/themes.zh-CN.md) |
| **哈利波特**<br>[![哈利波特 模拟截图](docs/assets/themes/wizard-desktop.jpg)](docs/themes.zh-CN.md) | **彼得兔园**<br>[![彼得兔园 模拟截图](docs/assets/themes/eyecare-desktop.jpg)](docs/themes.zh-CN.md) |

### 知道额度还剩多少，消耗在哪里

![消耗页面，使用虚构的额度、点数、token 和缓存数据](docs/assets/features/usage-zh.png)

打开顶部的**消耗**页面，或点击主机、项目、会话里的用量摘要，可以同时查看三类数据：

- **官方账号额度：** 宿主机原生 Codex 上报的周额度、5 小时额度、重置时间和当前点数余额。同一账号由多台主机上报时会去重，不会把额度相加。
- **已记录 token：** 按主机、项目、会话展示总消耗和当前周额度周期内消耗；Codex 有上报时，会话时间线还会标出每个已完成 Turn 的 token。
- **缓存效率：** 单轮和本周缓存命中率都按“缓存输入 token ÷ 输入 token”计算；排名可定位主要消耗来自哪些项目和会话，列表较长时支持分页。

账号额度和点数由同一 Codex 账号共享；项目与会话数据是 AgentFleets 已记录到的观测值，不是官方额度比例或点数余额的分摊。系统不会反推接入前历史，也不会补录未被管理的独立 CLI 请求；缺失、部分覆盖和过期数据都会明确标识。账号额度通过连接后的首次查询、原生事件和手动刷新更新，浏览器只读取已保存快照，不会每分钟轮询所有主机。统计范围和计算方式见[用量说明](docs/usage.md)。

*上图来自真实界面，但主机、项目、会话、额度与点数全部为虚构模拟数据。*

## 与 Codex 有什么区别

**AgentFleets 为 Codex 提供自行部署的管理界面。** 真正执行任务的仍是宿主机上的 Codex；本项目不提供模型、订阅或额外使用额度。

[Codex CLI](https://learn.chatgpt.com/docs/cli) 是终端入口，[官方桌面版](https://learn.chatgpt.com/docs/app)提供图形工作台。AgentFleets 侧重用自己的浏览器面板，统一管理已配对主机及其原生会话。

| 对比项 | 官方桌面版 Remote Control | AgentFleets |
| --- | --- | --- |
| 使用入口 | 受支持的桌面端、移动端应用 | 自行部署的网页面板 |
| 设备身份 | 同一 ChatGPT **账号和工作区**，另需设备授权 | 独立面板账号，一次性配对主机 |
| 连接方式 | 已授权设备通过官方中继连接 | 每台主机上的 Agent 主动连接你的控制面 |
| 继续工作 | 远程继续对话、补充当前任务指令 | 继续原生会话，明确接管与释放写入权 |
| 管理重点 | 官方应用的连接设置 | 主机／项目／会话总览、队列、手动解冻、保留策略和受支持的图片清理 |
| 运维责任 | 配置官方客户端 | 自己管理 HTTPS、存储、备份和更新 |

**这三种接入方式，账号和授权要求有什么区别？**

- **官方 Remote Control：配对两台设备。** 例如用笔记本控制家里的电脑，两端应用需要登录同一个 ChatGPT 账号，并选择同一个 ChatGPT 工作区（不是项目文件夹）。还要在被控制的电脑上开启远程访问，并完成两台设备的配对授权；只登录同账号，不能直接控制另一台电脑。
- **官方 SSH：连接服务器上的项目。** 例如从桌面应用连接一台 Linux 开发服务器，你需要能通过 SSH 登录那台服务器，并在服务器上安装、认证 Codex，再添加远程项目。这走的是 SSH 登录流程，不是上面的设备配对流程；官方 SSH 配置说明没有列出“两端同一 ChatGPT 账号和工作区”这一要求。详见[官方远程连接说明](https://learn.chatgpt.com/docs/remote-connections)。
- **AgentFleets：把主机接入自己的网页面板。** 每台主机安装 Agent，用面板签发的一次性凭据配对。面板账号负责管理主机，主机上的 Codex 账号负责执行任务：各主机的 Codex 账号可以不同，也不必与面板邮箱一致，但每台主机都要有可用的 Codex 认证及权限。

AgentFleets 通过 Django 和 Resend 邮箱验证码支持多用户；首次登录自动创建独立工作区，机器、项目和会话按用户隔离。各主机的 Codex 账号与额度保持独立，暂不提供团队共享权限。平台管理员专属的“管理”页集中提供用户管理、托管升级和系统信息；普通用户保留自己主机与会话的管理能力。[权限与账号管理说明](docs/administration.md#中文)。

官方远程功能已满足需求时，直接使用官方应用即可。希望自行掌握部署、定制和多主机网页管理时，再选择 AgentFleets。两者功能有重叠，“远程继续会话”并非本项目独有。AgentFleets 在原主机上管理会话，目前不提供将对话及 Git 状态整体迁移到另一台主机的功能；换其他客户端打开同一原生会话前，需先释放面板写入权。

## 自行部署

AgentFleets 使用 Docker Compose 运行。开始前需要：

- 一台安装了 Git、Docker 和 Docker Compose 的 Linux 服务器
- 供其他设备访问时使用的 HTTPS 域名
- 至少一台已经登录 Codex 的 Linux、macOS 或 Windows 主机

源码构建会下载依赖和各平台运行时，因此部署服务器需要能够访问网络。

### 1. 下载项目

```sh
git clone https://github.com/JosephJagger/AgentFleet.git
cd AgentFleet
cp .env.example .env
```

### 2. 配置面板

打开 `.env`，至少修改下面几项：

```dotenv
ADMIN_EMAIL=you@example.com
AUTH_MODE=email
DJANGO_AUTH_URL=http://identity:8000
DJANGO_AUTH_SERVICE_TOKEN=独立生成至少32位随机密钥
DJANGO_SECRET_KEY=再独立生成一个至少32位随机密钥
RESEND_API_KEY=你的Resend密钥
RESEND_FROM_EMAIL=login@你的已验证域名
RESEND_FROM_NAME=AgentFleets
PUBLIC_ORIGIN=https://panel.example.com
ALLOWED_ORIGINS=https://panel.example.com
COOKIE_SECURE=true
PUBLISH_HOST=127.0.0.1
```

将邮箱、发件地址和示例域名换成自己的值，分别运行 `openssl rand -hex 48` 生成两个 Django 密钥。登录只需要邮箱收到的 6 位验证码，无需密码；发件地址必须使用 Resend 已验证的域名。升级时保留原 `ADMIN_EMAIL`，原工作区及数据会继续归属该邮箱。两个 origin 都不要包含路径或末尾斜杠。API Key 仅在 `.env` 配置，已被 Git 和镜像构建忽略。详见 [Django 用户服务说明](apps/identity/README.md)，备份时需同时保存控制面和用户服务两个数据卷。

如果反向代理会转发客户端地址，只把已经核实的直接代理地址填入 `TRUSTED_PROXIES`；不需要识别真实客户端地址时可以不设置。

主机用量弹窗可根据公开的明确预告显示**临时 Codex 额度重置预测**。在不提交到 Git 的 `.env` 中填写 `AGENTFLEET_X_BEARER_TOKEN`（X API Bearer Token）并重启控制面后，系统最多每小时检查一次；没有可靠信号时显示“暂无预测”。这不是官方承诺，也不把自然周重置算作临时重置。重置卡何时发放无法可靠预测；原生 Codex 上报可用卡数时，弹窗会显示实际数量。公开信号的处理思路参考 [Codex Reset Radar](https://github.com/JosephJagger/Codex-Reset-Radar)。

### 3. 构建并启动

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3215/ready
```

健康检查成功时会返回包含 `"status":"ok"` 的 JSON。查看服务状态和日志：

```sh
docker compose ps
docker compose logs -f control-plane
```

### 4. 配置 HTTPS

将 HTTPS 反向代理指向 `http://127.0.0.1:3215`，并开启 WebSocket 代理。以 Caddy 为例，只需：

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:3215
}
```

打开 `PUBLIC_ORIGIN` 配置的地址，输入邮箱并使用收到的验证码登录。`ADMIN_EMAIL` 指定的账号可进入“管理”页；其他邮箱注册为独立工作区的普通用户。

只在服务器本机试用且没有域名时，可把两个 origin 都设为 `http://127.0.0.1:3215`，并设置 `COOKIE_SECURE=false`，然后从本机打开该地址。不要把这套 HTTP 配置暴露到局域网或公网。

### 5. 连接 Codex 主机

1. 在 Linux、macOS 或 Windows 主机上，用实际拥有项目和原生会话的系统账号登录 Codex。
2. 在 AgentFleets 点击**添加主机**，选择对应操作系统。
3. 复制面板生成的一次性安装命令，仍用同一个系统账号在目标主机执行。
4. 回到面板；主机上线后，添加或选择项目，即可打开原有会话或创建新会话。

配对票据只能使用一次且有效期很短，请勿分享。Agent 主动向控制面发起连接，因此日常使用不需要在 Codex 主机上开放入站端口。只有通过操作系统、凭据保护和 Codex 协议检查后，面板才会开放写入能力。

### 6. 更新、排错与备份

如果搭建时遇到的问题已经在 GitHub 修复，不需要重新克隆项目。在原项目目录执行：

```sh
cd AgentFleet
git status --short
git rev-parse --short HEAD
git pull --ff-only
docker compose up -d --build
curl --fail http://127.0.0.1:3215/ready
```

`git pull` 只更新 Git 管理的项目文件，不会替换已被忽略的 `.env`，也不会清空 Docker 命名卷。`docker compose up -d --build` 会用刚拉取的源码重新构建，并只重建需要更新的容器。

如果 `git pull --ff-only` 提示存在本地代码改动，先安全暂存再更新：

```sh
git stash push -u -m "before AgentFleets update"
git pull --ff-only
docker compose up -d --build
```

使用 `git stash list` 和 `git stash show -p` 查看暂存内容。确认仍然需要时再执行 `git stash pop`；旧代码改动可能与新版本冲突。被 Git 忽略的 `.env` 不会被这条暂存命令收走。

更新后检查实际代码版本、容器状态和日志：

```sh
git rev-parse --short HEAD
docker compose ps
docker compose logs --tail=200 control-plane
```

健康检查仍然失败时，可以把这些结果用于反馈问题，但应先删除密码、配对票据、令牌、私有主机名和会话正文。

面板源码更新和宿主机 Agent 更新是两件事。上面的命令更新控制面和网页；面板恢复正常后，再进入对应主机使用更新或恢复功能升级 Agent。Agent 已经离线时，可能需要在该主机本地执行面板给出的修复命令。

Compose 使用 `agentfleet-data` 和 `agentfleet-runtime-releases` 两个命名卷保存控制面数据和已验证运行时。升级前请备份 `.env` 和这两个数据卷。除非确定要清空数据，否则不要执行 `docker compose down -v`。

需要在升级网页的同时保留现有 Agent 下载文件时，请查看[发布说明](docs/web-only-release.md)。

### 连接 AppleFleets iPhone App

AppleFleets 可以把 Apple Watch 跑步摘要提交给这台 Linux 主机上的 Codex，再把小红书和抖音文案返回手机。手机只上传距离、用时、配速、心率摘要和公里分段，不上传 GPS 坐标。

1. 登录 AgentFleets 网页面板，确认 Linux 主机显示为在线。
2. 在这台主机下添加一个项目，项目名称填写 `iwatch`，宿主机目录填写 `/root/iwatch`。
3. 打开该项目的内容同步。这个开关用于把 Codex 最终回答送回 iPhone。
4. 在 Linux 终端进入 AgentFleet 项目目录，生成连接令牌：

```sh
openssl rand -hex 32
```

5. 复制终端显示的 64 位字符，编辑 AgentFleet 的 `.env`，在末尾加入：

```dotenv
APPLEFLEETS_API_TOKEN=刚才生成的64位字符
APPLEFLEETS_PROJECT=iwatch
```

6. 重新构建并启动：

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3215/ready
```

7. 在 iPhone 打开 AppleFleets，地址填写你的 AgentFleets HTTPS 地址，例如 `https://panel.example.com`；“连接令牌”填写第 4 步生成的字符。
8. 打开一条跑步记录，点击“用 Linux Codex 生成文案”。看到“文案已返回”即配置成功。

每次生成会在 AgentFleets 中新建一个独立会话，标题以 `AppleFleets` 开头，方便查看执行过程。接口令牌只能提交这类固定格式的跑步任务和读取对应结果，不能代替管理员网页登录。令牌泄露时，重新执行第 4 步、替换 `.env` 并重启即可使旧令牌失效。

## 进一步了解

<details>
<summary><strong>会话接管、恢复与图片清理</strong></summary>

## 接管、恢复与冻结

同一个原生会话只能有一个写入进程。面板接管期间，不要在宿主机对同一会话执行 `codex resume`。先在面板释放接管，等宿主机确认后再本地恢复。回到面板前，先退出本地写入进程，再接管。重命名只改变标题，不改变原生会话 ID。

断连或重启可能让操作结果不确定，即使对话中已经出现回复。系统会冻结写入，不会自动重发可能产生副作用的动作。请先核验宿主机及原生会话，再手动点击解除冻结。解冻不代表上一条操作失败，也不会撤销它；确定结果前不要重复发送。

## 数据与图片

控制面保存账号和主机注册信息、同步的对话内容、操作记录和上传图片。Codex 执行及模型凭据保留在宿主机。控制面不是无存储转发器，需要保护控制面数据卷和宿主机数据。

默认图片配额为每主机 50 MB。主机页将图片与上传文件按会话合并清理；删除前，Agent 会逐项核对暂存路径、大小、内容哈希、目录成员和符号链接边界。Linux、macOS 和 Windows 均可清理通过核验的主机暂存文件，同时保留文字与原生会话身份。原生历史图片清理目前限已验证的 Linux/Codex 适配器，需要 Python 3；不支持或来源不明的数据会被拒绝。不会清理供应商云端数据或独立备份。清理后原生历史文件字节数可能不缩小，存储大小也不等于 token 用量。详见[附件清理说明](docs/panel-image-cleanup.md)。


</details>

<details>
<summary><strong>开发与项目结构</strong></summary>

## 开发

使用 Node.js 24 和 npm：

```sh
npm ci --prefix apps/control-plane
npm ci --prefix apps/local-agent
npm ci --prefix apps/web
npm run check
npm test
npm run build
```

`apps/control-plane` 是 API 与 SQLite 控制面，`apps/local-agent` 是宿主机 Agent，`apps/web` 是 React 工作台，`packaging` 提供安装器和构建脚本，`experiments` 包含隔离的原生历史兼容性工具。

参阅[贡献指南](CONTRIBUTING.md)、[安全问题报告](SECURITY.md)和[打包说明](packaging/README.md)。涉及会话所有权、操作重放或原生历史的修改，需要针对恢复行为进行测试。


</details>

---

<p align="center">为在自己主机上使用 Codex 的开发者构建。<br>
<a href="LICENSE">MIT 开源</a> · <a href="THIRD_PARTY_NOTICES.md">第三方声明</a> · <a href="CONTRIBUTING.md">欢迎贡献</a></p>

<sub>本项目独立开发，并非 OpenAI 官方产品。请自行部署并使用自己的 Codex 凭据；不提供共享站点或默认登录账号。</sub>

主机不可达时，主机页会显示**恢复主机连接**卡片，按 Windows、macOS、Linux 提供修复命令。请在故障主机上使用原安装账号执行；修复保留配对和会话数据，复制命令不等于远程执行。关机、断网或系统自身故障仍需在本机处理。
