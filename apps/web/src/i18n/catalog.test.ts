import ts from "typescript";
import { expect, it } from "vitest";
import english from "./en.json";
import { localeOptions } from "./locales";

const catalogs = import.meta.glob<Record<string, string>>("./*.json", { import: "default", eager: true });
it("all selectable languages cover the complete UI without corrupting template arguments", () => {
  const keys = Object.keys(english).sort();
  for (const { value: language } of localeOptions) {
    if (language === "zh-CN") continue;
    const catalog = catalogs[`./${language}.json`];
    expect(catalog, language).toBeDefined();
    expect(Object.keys(catalog).sort(), language).toEqual(keys);
    for (const [source, translation] of Object.entries(catalog)) {
      expect(translation.trim(), `${language}: ${source}`).not.toBe("");
      expect(translation.match(/\{[^{}]+\}/g)?.sort() ?? [], `${language}: ${source}`).toEqual(source.match(/\{[^{}]+\}/g)?.sort() ?? []);
      expect(translation, `${language}: ${source}`).not.toMatch(/QZV\d+VZQ|ＱＺＶ/);
    }
  }
});

const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
it("every static UI translation has an English entry", () => {
  const missing: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes(".test.")) continue;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const key = node.arguments[0];
        function checkKey(expression: ts.Expression) {
          if (ts.isStringLiteralLike(expression) && !Object.hasOwn(english, expression.text)) missing.push(`${path}: ${expression.text}`);
          else if (ts.isConditionalExpression(expression)) { checkKey(expression.whenTrue); checkKey(expression.whenFalse); }
          else if (ts.isParenthesizedExpression(expression)) checkKey(expression.expression);
        }
        if (key) checkKey(key);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(missing).toEqual([]);
});
