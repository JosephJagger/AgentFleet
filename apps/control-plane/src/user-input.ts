import { invariant } from "./errors.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateInputAnswers(value: unknown, questions: unknown): void {
  invariant(Array.isArray(questions) && questions.length > 0 && questions.length <= 8 && record(value), 400, "INPUT_ANSWERS_INVALID", "Question answers are required");
  invariant(Object.keys(value).length === questions.length, 400, "INPUT_ANSWERS_INVALID", "Answer every question exactly once");
  const ids = new Set<string>();
  for (const question of questions) {
    invariant(record(question) && typeof question.id === "string" && !["__proto__", "constructor", "prototype"].includes(question.id) && !ids.has(question.id), 400, "INPUT_QUESTIONS_INVALID", "Invalid question identity");
    ids.add(question.id);
    const entry = Object.hasOwn(value, question.id) ? value[question.id] : undefined;
    const answers = record(entry) && Array.isArray(entry.answers) ? entry.answers : undefined;
    // One free-text note may accompany up to 20 selected option labels.
    const limit = question.multi === true ? 21 : 1;
    invariant(record(entry) && Object.keys(entry).length === 1 && answers && answers.length >= 1 && answers.length <= limit && new Set(answers).size === answers.length && answers.every((answer) => typeof answer === "string" && answer.trim().length > 0 && answer.length <= 8000), 400, "INPUT_ANSWERS_INVALID", limit === 1 ? "Each question needs one non-empty answer of at most 8000 characters" : "Each multi-select question needs 1–21 distinct non-empty answers of at most 8000 characters");
  }
}
