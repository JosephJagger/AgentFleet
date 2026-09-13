async page => {
  const themes = ['cyber','daylight','midnight','forest','eyecare','matrix','frozen','wizard','starwars','spirited','rivendell','mario','wukong','nezha','whitesnake','qingming','jiangshan'];
  const mobile = new Set(['daylight','matrix','wizard','eyecare','whitesnake','jiangshan']);
  const results = [];
  for (const theme of themes) {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://127.0.0.1:22344/sessions/s2');
    await page.locator('.theme-switcher select').selectOption(theme);
    await page.locator('.timeline-event').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const badge = document.createElement('div');
      badge.textContent = '模拟数据 · DEMO';
      badge.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:9999;padding:5px 9px;border-radius:6px;background:#263746;color:#fff;font:12px sans-serif;pointer-events:none';
      document.body.append(badge);
    });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Desktop overflow: ' + theme);
    await page.screenshot({ path: 'docs/assets/themes/' + theme + '-desktop.jpg', type: 'jpeg', quality: 85 });
    if (mobile.has(theme)) {
      await page.setViewportSize({ width: 390, height: 1000 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow: ' + theme);
      await page.screenshot({ path: 'docs/assets/themes/' + theme + '-mobile.jpg', type: 'jpeg', quality: 85 });
    }
    results.push(theme);
  }
  return results;
}
