import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
/** Guards against unbalanced blocks, which silently disable every rule that follows. */
for(const file of ['buzhoushan-theme.css','workbench-panels.css']){
 it(`${file} has balanced braces`,()=>{
  const css=readFileSync(new URL(`./${file}`,import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,'""');
  let depth=0;for(const ch of css){if(ch==='{')depth++;if(ch==='}'){depth--;expect(depth).toBeGreaterThanOrEqual(0);}}
  expect(depth).toBe(0);
 });
}
it('the screensaver canvas rule is not nested inside a media query',()=>{
 const css=readFileSync(new URL('./buzhoushan-theme.css',import.meta.url),'utf8');
 const rule=css.indexOf('.buzhou-saver__canvas {');expect(rule).toBeGreaterThan(-1);
 const before=css.slice(0,rule);
 expect((before.match(/{/g)??[]).length).toBe((before.match(/}/g)??[]).length);
});
