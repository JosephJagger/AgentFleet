// The evidence weighting follows the approach described by Codex Reset Radar:
// https://github.com/JosephJagger/Codex-Reset-Radar
// Only a future, explicit Codex reset announcement is shown as a prediction.
// A normal seven-day quota reset and a low-evidence heuristic are never shown.
export interface ResetPrediction {
  kind: "temporary-reset";
  probability: number;
  expectedAt: string;
  observedAt: string;
  sourceUrl: string;
}

interface Post { id: string; text: string; created_at: string }
interface Account { remainingPercent: number; resetCardsAvailable: number | null }
interface State { checkedAt: number; prediction: ResetPrediction | null; baseline: Account; resolvedSourceUrl: string | null }
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * 24 * HOUR;
const beijingDay = (timestamp:number) => Math.floor((timestamp + 8 * HOUR) / DAY);

export function forecastFromPosts(posts: Post[], now = Date.now()): ResetPrediction | null {
  const candidates = posts.flatMap(post => {
    const published = Date.parse(post.created_at);
    if (!Number.isFinite(published) || published > now || now - published > 120 * HOUR || !/\bcodex\b/i.test(post.text)) return [];
    if (!/\breset(?:s|ting)?\b/i.test(post.text) || /\b(?:weekly|five.hour|5.hour|natural|normal)\s+(?:quota\s+)?reset/i.test(post.text) || !/\b(?:will|going to|plan(?:ning)? to|tomorrow|later today|in\s+\d+\s+hours?|in\s+\d+\s+days?)\b/i.test(post.text)) return [];
    let expected: number | null = null;
    const hours = post.text.match(/\bin\s+(\d{1,2})\s+hours?\b/i);
    const days = post.text.match(/\bin\s+(\d{1,2})\s+days?\b/i);
    if (hours) expected = published + Number(hours[1]) * HOUR;
    else if (days) expected = published + Number(days[1]) * 24 * HOUR;
    else if (/\btomorrow\b/i.test(post.text)) expected = published + 24 * HOUR;
    else if (/\blater today\b/i.test(post.text)) expected = published + 12 * HOUR;
    if (expected === null || expected <= now || expected > now + WEEK) return [];
    const recency = Math.exp(-(now - published) / (42 * HOUR));
    return [{ expected, published, probability: Math.max(92, Math.round(98 * 0.58 * recency + 34)), id: post.id }];
  }).sort((a,b) => a.expected - b.expected);
  const best = candidates[0];
  return best ? { kind:"temporary-reset", probability:best.probability,
    expectedAt:new Date(best.expected).toISOString(), observedAt:new Date(now).toISOString(),
    sourceUrl:`https://x.com/thsottiaux/status/${best.id}` } : null;
}

export class ResetRadar {
  private readonly states = new Map<string, State>();
  private pending: Promise<ResetPrediction | null> | null = null;
  private lastCollectedAt = 0;
  private lastCollected: ResetPrediction | null = null;
  constructor(private readonly token = process.env.AGENTFLEET_X_BEARER_TOKEN ?? "",
    private readonly fetcher: typeof fetch = fetch) {}

  private async fetchForecast(now: number): Promise<ResetPrediction | null> {
    if (!this.token) return null;
    const timeout = AbortSignal.timeout(5_000);
    const headers = { Authorization:`Bearer ${this.token}`, Accept:"application/json" };
    const user = await this.fetcher("https://api.x.com/2/users/by/username/thsottiaux",{headers,signal:timeout});
    if (!user.ok) return null;
    const userId = (await user.json() as {data?:{id?:string}}).data?.id;
    if (!userId || !/^\d+$/.test(userId)) return null;
    const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
    url.search = new URLSearchParams({max_results:"100","tweet.fields":"created_at",exclude:"retweets"}).toString();
    const response = await this.fetcher(url,{headers,signal:timeout});
    if (!response.ok) return null;
    const posts = (await response.json() as {data?:Post[]}).data;
    return forecastFromPosts(Array.isArray(posts) ? posts : [],now);
  }

  private async collect(now:number):Promise<ResetPrediction|null> {
    if (this.lastCollectedAt && now-this.lastCollectedAt<HOUR && beijingDay(now)===beijingDay(this.lastCollectedAt)) return this.lastCollected;
    const prediction=await this.fetchForecast(now).catch(()=>null);
    this.lastCollectedAt=now;
    this.lastCollected=prediction;
    return prediction;
  }

  async read(key: string, account: Account | null, now = Date.now()): Promise<ResetPrediction | null> {
    if (!account) return null;
    const previous = this.states.get(key);
    const increased = previous && account.remainingPercent > previous.baseline.remainingPercent + 0.01;
    const receivedCard = previous && account.resetCardsAvailable !== null &&
      account.resetCardsAvailable > (previous.baseline.resetCardsAvailable ?? 0);
    if (previous?.prediction && beijingDay(previous.checkedAt)===beijingDay(now) && !increased && !receivedCard) return previous.prediction;
    if (increased || receivedCard) {
      this.states.set(key,{checkedAt:now,prediction:null,baseline:account,resolvedSourceUrl:previous?.prediction?.sourceUrl??previous?.resolvedSourceUrl??null});
      return null;
    }
    if (previous && beijingDay(previous.checkedAt)===beijingDay(now) && now - previous.checkedAt < HOUR) return null;
    if (!this.pending) this.pending = this.collect(now).catch(() => null).finally(() => { this.pending = null; });
    const prediction = await this.pending;
    const resolvedSourceUrl=beijingDay(previous?.checkedAt??now)===beijingDay(now)?previous?.resolvedSourceUrl??null:null;
    const current=prediction?.sourceUrl===resolvedSourceUrl?null:prediction;
    this.states.set(key,{checkedAt:now,prediction:current,baseline:account,resolvedSourceUrl});
    return current;
  }
}
