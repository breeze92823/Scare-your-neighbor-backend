// Rewarded-ad verification (docs.bloxity.io, "Reward verification"): the client's Legion.SDK.ads
// .showRewarded() resolves { status: "completed", rewardToken }; the game server must verify that token
// with Bloxity before it pays anything. POST {apiUrl}/v1/ads/reward/verify { gameSlug, rewardToken } ->
// { valid, userId?, placement?, test?, reason? }. A token verifies once, for this game, within 5 minutes
// of the ad. userId is null for a guest.

export interface RewardCheck {
  valid: boolean;
  userId?: string | null;
  test?: boolean;
  reason?: string;
}

export type RewardVerifier = (token: string) => Promise<RewardCheck>;

const apiUrl = () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
// The slug the game is registered under on bloxity.io (the client's GAME_SLUG); Legion injects the
// hosting id as BLOXITY_GAME_ID, which is normally the same string.
const gameSlug = () => process.env.BLOXITY_GAME_SLUG || process.env.BLOXITY_GAME_ID || "";

async function verifyWithBloxity(token: string): Promise<RewardCheck> {
  // Local development (npm start, NODE_ENV unset): the client's simulated ad has no real token.
  if (process.env.NODE_ENV !== "production" && token === "dev-token") return { valid: true, userId: null, test: true };
  const slug = gameSlug();
  if (!slug) return { valid: false, reason: "unconfigured" };
  const res = await fetch(`${apiUrl()}/v1/ads/reward/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameSlug: slug, rewardToken: token }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { valid: false, reason: `http-${res.status}` };
  const body = (await res.json()) as RewardCheck;
  return { valid: body?.valid === true, userId: body?.userId ?? null, test: body?.test === true, reason: body?.reason };
}

let verifier: RewardVerifier = verifyWithBloxity;

export function verifyReward(token: string): Promise<RewardCheck> {
  return verifier(token).catch((err) => {
    console.warn("[ads] reward verification failed", err);
    return { valid: false, reason: "unreachable" };
  });
}

// Test-only seam: a fake Bloxity.
export function __setRewardVerifierForTest(fn: RewardVerifier | null): void {
  verifier = fn ?? verifyWithBloxity;
}
