# Theme gallery

[Back to README](../README.md) · [Chinese version](themes.zh-CN.md)

Real application screenshots of 17 themes with fictional demo data. Hosts, projects, conversations, model settings, usage and weather are simulated; no production data is shown or real execution results implied.

Desktop captures are 1920 × 1080; mobile captures are 390 × 1000. Click an image for full resolution. Castle in the Sky is the default for new browsers; existing preferences are retained. The screenshots show the Chinese interface.

## Cyberpunk

[![Cyberpunk desktop demo](assets/themes/cyber-desktop.jpg)](assets/themes/cyber-desktop.jpg)

## Castle in the Sky

[![Castle in the Sky desktop demo](assets/themes/daylight-desktop.jpg)](assets/themes/daylight-desktop.jpg)

## The Dark Knight

[![The Dark Knight desktop demo](assets/themes/midnight-desktop.jpg)](assets/themes/midnight-desktop.jpg)

## Totoro Forest

[![Totoro Forest desktop demo](assets/themes/forest-desktop.jpg)](assets/themes/forest-desktop.jpg)

## Peter Rabbit Garden

[![Peter Rabbit Garden desktop demo](assets/themes/eyecare-desktop.jpg)](assets/themes/eyecare-desktop.jpg)

## The Matrix

[![The Matrix desktop demo](assets/themes/matrix-desktop.jpg)](assets/themes/matrix-desktop.jpg)

## Frozen

[![Frozen desktop demo](assets/themes/frozen-desktop.jpg)](assets/themes/frozen-desktop.jpg)

## Harry Potter

[![Harry Potter desktop demo](assets/themes/wizard-desktop.jpg)](assets/themes/wizard-desktop.jpg)

## Star Wars

[![Star Wars desktop demo](assets/themes/starwars-desktop.jpg)](assets/themes/starwars-desktop.jpg)

## Spirited Away

[![Spirited Away desktop demo](assets/themes/spirited-desktop.jpg)](assets/themes/spirited-desktop.jpg)

## The Lord of the Rings

[![The Lord of the Rings desktop demo](assets/themes/rivendell-desktop.jpg)](assets/themes/rivendell-desktop.jpg)

## Super Mario

[![Super Mario desktop demo](assets/themes/mario-desktop.jpg)](assets/themes/mario-desktop.jpg)

## Havoc in Heaven

[![Havoc in Heaven desktop demo](assets/themes/wukong-desktop.jpg)](assets/themes/wukong-desktop.jpg)

## Nezha Conquers the Dragon King

[![Nezha Conquers the Dragon King desktop demo](assets/themes/nezha-desktop.jpg)](assets/themes/nezha-desktop.jpg)

## Legend of the White Snake

[![Legend of the White Snake desktop demo](assets/themes/whitesnake-desktop.jpg)](assets/themes/whitesnake-desktop.jpg)

## Along the River

[![Along the River desktop demo](assets/themes/qingming-desktop.jpg)](assets/themes/qingming-desktop.jpg)

## A Thousand Li of Rivers and Mountains

[![A Thousand Li of Rivers and Mountains desktop demo](assets/themes/jiangshan-desktop.jpg)](assets/themes/jiangshan-desktop.jpg)

## Mobile previews

| Castle in the Sky | The Matrix |
| --- | --- |
| [![Castle in the Sky mobile demo](assets/themes/daylight-mobile.jpg)](assets/themes/daylight-mobile.jpg) | [![The Matrix mobile demo](assets/themes/matrix-mobile.jpg)](assets/themes/matrix-mobile.jpg) |

| Harry Potter | Peter Rabbit Garden |
| --- | --- |
| [![Harry Potter mobile demo](assets/themes/wizard-mobile.jpg)](assets/themes/wizard-mobile.jpg) | [![Peter Rabbit Garden mobile demo](assets/themes/eyecare-mobile.jpg)](assets/themes/eyecare-mobile.jpg) |

| Legend of the White Snake | A Thousand Li of Rivers and Mountains |
| --- | --- |
| [![Legend of the White Snake mobile demo](assets/themes/whitesnake-mobile.jpg)](assets/themes/whitesnake-mobile.jpg) | [![A Thousand Li of Rivers and Mountains mobile demo](assets/themes/jiangshan-mobile.jpg)](assets/themes/jiangshan-mobile.jpg) |

## Reproduce

Demo fixtures and capture scripts are in [screenshots](screenshots). Start the local web development server on port 22344, open it with Playwright CLI, then run:

```sh
playwright-cli run-code --filename docs/screenshots/demo-fixture.js
playwright-cli run-code --filename docs/screenshots/capture-themes.js
```

The fixture intercepts API and WebSocket traffic in a local preview. It creates no hosts or sessions on a server. The capture script writes 17 desktop and 6 mobile JPEGs to `docs/assets/themes/`. Use a headless Chromium profile appropriate for your local environment. Time labels reflect capture time; fixture identities and messages are fictional.
