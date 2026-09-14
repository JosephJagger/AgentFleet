import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env } from "@huggingface/transformers";
import corpus from "./writing-corpus.json" with { type: "json" };

env.allowRemoteModels = false;
env.useFSCache = false;
const extract = await pipeline("feature-extraction", String(workerData.modelPath), {
  dtype: "q8", device: "cpu", session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
});
async function embed(text: string[]) {
  const output = await extract(text, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}
const examples = corpus.intents.flatMap(intent => [...intent.examples.zh, ...intent.examples.en].map(text => ({ id: intent.id, text })));
const vectors: number[][] = [];
for (let index = 0; index < examples.length; index += 8) vectors.push(...await embed(examples.slice(index, index + 8).map(example => example.text)));
parentPort!.postMessage({ ready: true });
// Serialize inference. The parent admits at most four outstanding requests.
let chain = Promise.resolve();
parentPort!.on("message", ({ id, text }: { id: number; text: string }) => {
  chain = chain.then(async () => {
    const [query] = await embed([text]);
    const scores = new Map<string, number>();
    for (let i = 0; i < examples.length; i++) {
      const score = vectors[i]!.reduce((sum, value, j) => sum + value * query![j]!, 0);
      scores.set(examples[i]!.id, Math.max(scores.get(examples[i]!.id) ?? -1, score));
    }
    parentPort!.postMessage({ id, matches: [...scores].map(([intent, score]) => ({ intent, score })).sort((a, b) => b.score - a.score).slice(0, 3) });
  }).catch(() => { parentPort!.postMessage({ id, matches: [] }); });
});
