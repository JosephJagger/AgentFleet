import { AgentError } from "./errors.js";
import { inputAnswers, inputQuestions, type InputAnswers, type InputQuestion } from "./user-input.js";
import { isRecord } from "./util.js";
const fail = (): never => { throw new AgentError("MCP_FORM_UNSUPPORTED", "MCP form contains unsupported or sensitive fields"); };
export interface ElicitationField { type: string; required: boolean; enum?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }
export function elicitationForm(params: Record<string, unknown>): { questions: InputQuestion[]; fields: Record<string, ElicitationField> } {
  const schema = params.requestedSchema;
  if (params.mode !== "form" || !isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties) || typeof params.message !== "string") return fail();
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields: Record<string, ElicitationField> = Object.create(null);
  const questions = Object.entries(schema.properties).map(([id, value]) => {
    if (!isRecord(value) || !["string", "integer", "number", "boolean"].includes(String(value.type)) || value.format != null || value.isSecret === true || /password|secret|token|credential|密码|密钥|口令/i.test(`${id} ${value.title ?? ""} ${value.description ?? ""}`)) return fail();
    if (Object.keys(value).some(key => !["type", "title", "description", "default", "enum", "enumNames", "minimum", "maximum", "minLength", "maxLength", "format", "isSecret"].includes(key))) return fail();
    if (value.enum != null && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 18 || value.enum.some(v => typeof v !== "string" || !v || v.length > 512 || v === "[omit]"))) return fail();
    const field: ElicitationField = { type: String(value.type), required: required.includes(id), ...(Array.isArray(value.enum) ? { enum: value.enum as string[] } : {}) };
    for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) if (value[key] != null) { if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return fail(); field[key] = value[key]; }
    fields[id] = field;
    const options = (field.enum ?? (field.type === "boolean" ? ["true", "false"] : [])).map(label => ({ label, description: "" }));
    if (!field.required) options.push({ label: "[omit]", description: "不提供此可选字段" });
    return { id, header: String(value.title ?? id), question: `${params.message}\n${value.description ?? id}${field.required ? "" : "（可选；选择 [omit] 可跳过）"}`, isOther: !field.enum && field.type !== "boolean", options };
  });
  if (required.some(id => typeof id !== "string" || !Object.hasOwn(fields, id))) return fail();
  return { questions: inputQuestions(questions), fields };
}
export function elicitationContent(answers: InputAnswers, questions: InputQuestion[], fields: Record<string, ElicitationField>): Record<string, unknown> {
  const validated = inputAnswers(answers, questions);
  const content: Record<string, unknown> = Object.create(null);
  for (const [id, field] of Object.entries(fields)) {
    const answer = validated[id]?.answers[0]; if (answer === undefined) return fail();
    if (!field.required && answer === "[omit]") continue;
    if (field.enum && !field.enum.includes(answer)) return fail();
    let value: unknown = answer;
    if (field.type === "boolean") { if (!["true", "false"].includes(answer)) return fail(); value = answer === "true"; }
    if (["number", "integer"].includes(field.type)) {
      value = Number(answer); if (!Number.isFinite(value) || field.type === "integer" && !Number.isSafeInteger(value) || field.minimum !== undefined && Number(value) < field.minimum || field.maximum !== undefined && Number(value) > field.maximum) return fail();
    }
    if (field.type === "string" && (field.minLength !== undefined && answer.length < field.minLength || field.maxLength !== undefined && answer.length > field.maxLength)) return fail();
    content[id] = value;
  }
  return content;
}
