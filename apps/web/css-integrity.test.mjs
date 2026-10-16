// Lives outside src/ so the browser type-check (tsc -b) does not need Node typings.
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
/** Unbalanced blocks silently disable every rule after them, so check braces in the shipped stylesheets. */
const strip=css=>css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,'""');
const read=name=>readFileSync(new URL(`./src/${name}`,import.meta.url),'utf8');
const balance=css=>{let depth=0;for(const ch of strip(css)){if(ch==='{')depth++;if(ch==='}')depth--;if(depth<0)return -1;}return depth;};
for(const name of ['buzhoushan-theme.css','workbench-panels.css']){
 it(`${name} is non-empty with balanced braces`,()=>{
  const css=read(name);expect(css.length).toBeGreaterThan(1000);expect(balance(css)).toBe(0);
 });
}
it('the screensaver canvas rule is top level, not nested in a media query',()=>{
 const css=read('buzhoushan-theme.css'),rule=css.indexOf('.buzhou-saver__canvas {');
 expect(rule).toBeGreaterThan(-1);expect(balance(css.slice(0,rule))).toBe(0);
});
it('detects the unclosed block that shipped in 0196643',()=>{
 expect(balance('@media (x) { .a { color:red; }\n.b { color:blue; }')).toBe(1);
});

it('every top-bar broadcast button shares the 30px control height of the voice and language controls',()=>{
 const css=read('buzhoushan-theme.css').replace(/\s+/g,' ');
 const rule=(selector)=>{const i=css.indexOf(selector);return i<0?'':css.slice(i,css.indexOf('}',i));};
 for(const sel of ['.topbar-actions .buzhou-focus-toggle {','.topbar-actions > .panel-voice-control > .button:not(.panel-voice-control__floating) {','.topbar-actions > .language-switcher select {','.topbar-actions > .icon-button {']){
  expect(rule(sel),sel).toMatch(/(^|[^-])height:\s*30px/);
 }
 expect(rule('.topbar-actions .buzhou-broadcast-toggle--icon {')).toMatch(/width:\s*30px/);
});
