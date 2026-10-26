/** The deliberately bounded SQL dialect used by the control plane. Values never enter this compiler. */
interface Token { text: string; kind: "word" | "string" | "space" | "symbol" }

export function sqlTokens(sql: string): Token[] {
  const parts = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s+|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|<=|>=|<>|!=|\|\||::|./g) ?? [];
  if (parts.join("") !== sql) throw new Error("Unsupported SQL token");
  return parts.map(text => ({ text, kind: /^\s|^--|^\/\*/.test(text) ? "space" : text[0] === "'" ? "string" : /^[A-Za-z_]/.test(text) ? "word" : "symbol" }));
}

const numericPaths = new Set(["$.archived", "$.ok", "$.response.delivered", "$.totalTokens"]);
const unquote = (value: string) => value.slice(1, -1).replaceAll("''", "'");

export function postgresSql(sql: string, values: readonly unknown[] = []): string {
  let parameter = 0;
  const tokens = sqlTokens(sql).filter(token => token.kind !== "space");
  const aliases = new Set(tokens.filter((t, i) => t.kind === "word" && /[A-Z]/.test(t.text) && /[a-z]/.test(t.text) && tokens[i - 1]?.text.toUpperCase() === "AS").map(t => t.text));
  const output: string[] = [];
  function expression(start: number, end: number): string {
    const result: string[] = [];
    for (let i = start; i < end; i++) {
      const token = tokens[i]!;
      const name = token.text.toLowerCase();
      if (token.kind === "word" && tokens[i + 1]?.text === "(" &&
          ["json_extract", "json_type", "json_set", "json", "strftime", "max", "min"].includes(name)) {
        const args: Array<[number, number]> = [];
        let depth = 1, from = i + 2, j = from;
        for (; j < end; j++) {
          if (tokens[j]!.text === "(") depth++;
          if (tokens[j]!.text === ")") depth--;
          if (!depth) { args.push([from, j]); break; }
          if (depth === 1 && tokens[j]!.text === ",") { args.push([from, j]); from = j + 1; }
        }
        if (depth) throw new Error("Unbalanced SQL function");
        const values = args.map(([a, b]) => expression(a, b));
        if (name === "json_extract") {
          if (values.length !== 2) throw new Error("Unsupported json_extract arity");
          const path = tokens[args[1]![0]]!;
          if (path.kind !== "string") throw new Error("JSON paths must be SQL literals");
          result.push(`${numericPaths.has(unquote(path.text)) ? "af_json_number" : "af_json_text"}(${values.join(",")})`);
        } else if (name === "json_type") result.push(`af_json_type(${values.join(",")})`);
        else if (name === "json") result.push(`(${values[0]})::jsonb`);
        else if (name === "json_set") {
          if (values.length < 3 || values.length % 2 !== 1) throw new Error("Unsupported json_set arity");
          let value = `(${values[0]})::jsonb`;
          for (let a = 1; a < values.length; a += 2) {
            const raw = args[a + 1]!;
            const isJson = tokens[raw[0]]!.text.toLowerCase() === "json";
            value = `jsonb_set(${value},af_json_path(${values[a]}),${isJson ? values[a + 1] : `coalesce(to_jsonb((${values[a + 1]})::text),'null'::jsonb)`},true)`;
          }
          result.push(`(${value})::text`);
        } else if (name === "strftime") {
          if (values.length !== 2 || unquote(values[0]!) !== "%Y-%m-%dT%H:%M:%fZ" || unquote(values[1]!) !== "now") throw new Error("Unsupported strftime expression");
          result.push("af_now()");
        } else result.push(`${values.length > 1 ? name === "max" ? "greatest" : "least" : name}(${values.join(",")})`);
        i = j;
      } else if (token.text === "?") {
        const value = values[parameter];
        result.push(`$${++parameter}${typeof value === "bigint" || typeof value === "number" && Number.isInteger(value) ? "::bigint" : typeof value === "number" ? "::double precision" : ""}`);
      }
      else if (token.kind === "word" && aliases.has(token.text)) result.push(`"${token.text}"`);
      else result.push(token.text);
    }
    return result.join(" ");
  }
  output.push(expression(0, tokens.length));
  let result = output.join("").replace(/;\s*$/, "");
  result = result.replace(/(\$\d+)\s+IS (NOT )?NULL/gi, '$1::text IS $2NULL');
  // Case folding is ASCII-only, matching SQLite NOCASE (not locale-dependent lower()).
  result = result.replace(/([\w.]+)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, "af_ascii_fold($1) = af_ascii_fold($2)");
  if (/\bCOLLATE\s+NOCASE\b/i.test(result)) throw new Error("Unsupported NOCASE expression");
  if (/^INSERT OR IGNORE /i.test(result)) result = result.replace(/^INSERT OR IGNORE /i, "INSERT ") + " ON CONFLICT DO NOTHING";
  // PostgreSQL requires the target qualifier for ambiguous UPSERT right-hand sides.
  const upsert = result.match(/^INSERT\s+INTO\s+([\w"]+)[\s\S]*?\bDO UPDATE SET\s+([\s\S]*)$/i);
  if (upsert) {
    const tail = upsert[2]!;
    const assigned = new Set([...tail.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map(m => m[1]!.toLowerCase()));
    const ts = sqlTokens(tail);
    const significant = ts.map((t, i) => t.kind === "space" ? -1 : i).filter(i => i >= 0);
    for (let n = 0; n < significant.length; n++) {
      const index = significant[n]!, token = ts[index]!;
      if (token.kind !== "word" || !assigned.has(token.text.toLowerCase())) continue;
      const previous = ts[significant[n - 1] ?? -1]?.text;
      const next = ts[significant[n + 1] ?? -1]?.text;
      if (previous === "." || next === "." || ((previous === undefined || previous === ",") && next === "=")) continue;
      token.text = `${upsert[1]}.${token.text}`;
    }
    result = result.slice(0, result.length - tail.length) + ts.map(t => t.text).join("");
  }
  return result;
}
