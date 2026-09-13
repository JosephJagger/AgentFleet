# 主题截图

[返回项目说明](../README.zh-CN.md) · [英文版](themes.md)

17 套主题的真实界面截图，全部使用虚构模拟数据。主机、项目、会话、模型配置、消耗和天气均为演示内容，不包含生产信息，也不代表真实运行结果。

桌面截图为 1920 × 1080，手机截图为 390 × 1000。点击图片查看原尺寸。当前默认主题为「天空之城」，已有浏览器保留原选择。

## 赛博朋克

[![赛博朋克 桌面模拟截图](assets/themes/cyber-desktop.jpg)](assets/themes/cyber-desktop.jpg)

## 天空之城

[![天空之城 桌面模拟截图](assets/themes/daylight-desktop.jpg)](assets/themes/daylight-desktop.jpg)

## 黑暗骑士

[![黑暗骑士 桌面模拟截图](assets/themes/midnight-desktop.jpg)](assets/themes/midnight-desktop.jpg)

## 龙猫森林

[![龙猫森林 桌面模拟截图](assets/themes/forest-desktop.jpg)](assets/themes/forest-desktop.jpg)

## 彼得兔园

[![彼得兔园 桌面模拟截图](assets/themes/eyecare-desktop.jpg)](assets/themes/eyecare-desktop.jpg)

## 骇客帝国

[![骇客帝国 桌面模拟截图](assets/themes/matrix-desktop.jpg)](assets/themes/matrix-desktop.jpg)

## 冰雪奇缘

[![冰雪奇缘 桌面模拟截图](assets/themes/frozen-desktop.jpg)](assets/themes/frozen-desktop.jpg)

## 哈利波特

[![哈利波特 桌面模拟截图](assets/themes/wizard-desktop.jpg)](assets/themes/wizard-desktop.jpg)

## 星球大战

[![星球大战 桌面模拟截图](assets/themes/starwars-desktop.jpg)](assets/themes/starwars-desktop.jpg)

## 千与千寻

[![千与千寻 桌面模拟截图](assets/themes/spirited-desktop.jpg)](assets/themes/spirited-desktop.jpg)

## 指环王

[![指环王 桌面模拟截图](assets/themes/rivendell-desktop.jpg)](assets/themes/rivendell-desktop.jpg)

## 超级马里奥

[![超级马里奥 桌面模拟截图](assets/themes/mario-desktop.jpg)](assets/themes/mario-desktop.jpg)

## 大闹天宫

[![大闹天宫 桌面模拟截图](assets/themes/wukong-desktop.jpg)](assets/themes/wukong-desktop.jpg)

## 哪吒闹海

[![哪吒闹海 桌面模拟截图](assets/themes/nezha-desktop.jpg)](assets/themes/nezha-desktop.jpg)

## 白蛇传说

[![白蛇传说 桌面模拟截图](assets/themes/whitesnake-desktop.jpg)](assets/themes/whitesnake-desktop.jpg)

## 清明上河

[![清明上河 桌面模拟截图](assets/themes/qingming-desktop.jpg)](assets/themes/qingming-desktop.jpg)

## 千里江山

[![千里江山 桌面模拟截图](assets/themes/jiangshan-desktop.jpg)](assets/themes/jiangshan-desktop.jpg)

## 手机预览

| 天空之城 | 骇客帝国 |
| --- | --- |
| [![天空之城 手机模拟截图](assets/themes/daylight-mobile.jpg)](assets/themes/daylight-mobile.jpg) | [![骇客帝国 手机模拟截图](assets/themes/matrix-mobile.jpg)](assets/themes/matrix-mobile.jpg) |

| 哈利波特 | 彼得兔园 |
| --- | --- |
| [![哈利波特 手机模拟截图](assets/themes/wizard-mobile.jpg)](assets/themes/wizard-mobile.jpg) | [![彼得兔园 手机模拟截图](assets/themes/eyecare-mobile.jpg)](assets/themes/eyecare-mobile.jpg) |

| 白蛇传说 | 千里江山 |
| --- | --- |
| [![白蛇传说 手机模拟截图](assets/themes/whitesnake-mobile.jpg)](assets/themes/whitesnake-mobile.jpg) | [![千里江山 手机模拟截图](assets/themes/jiangshan-mobile.jpg)](assets/themes/jiangshan-mobile.jpg) |

## 重新生成

演示数据和截图脚本位于[截图脚本目录](screenshots)。在本地启动网页开发服务器（端口 22344），通过 Playwright CLI 打开页面，然后依次运行：

```sh
playwright-cli run-code --filename docs/screenshots/demo-fixture.js
playwright-cli run-code --filename docs/screenshots/capture-themes.js
```

演示脚本在本地预览中拦截 API 和 WebSocket 请求，不会在服务器创建主机或会话。截图脚本将 17 张桌面和 6 张手机 JPEG 写入 `docs/assets/themes/`。请使用适合本地环境的无头 Chromium 配置。时间标签反映截图时刻，身份和消息均为虚构。
