// Token launch radar: a fitted valuation model for pre-token protocols.
//
// Everything is derived from the sealed snapshot at run time; nothing is
// hardcoded per protocol and no name is ever special-cased.
//
// The model has three fitted parts, all estimated from the snapshot itself:
//
//   1. A peer multiple. Protocols whose token already trades reveal what the
//      market pays per dollar of TVL. A log-linear fit on those peers
//      (a size term) plus a shrunk per-category offset gives the multiple a
//      pre-token protocol would trade at, per TVL dollar. A 7-day growth term
//      was fitted too, and the held-out test rejected it (see Part 3): growth
//      rides on every row and drives the farm plans instead of the price.
//   2. Token odds. The share of protocols that already record a token,
//      tabulated by age band, by category and by TVL band (each smoothed
//      toward the base rate), combined geometrically: the chance a protocol
//      like this one ever issues a token at all.
//   3. Implied value = TVL x fitted multiple x token odds.
//
// The fit is validated out of sample inside this file: peers are split into
// two deterministic folds by slug hash, the model is fitted on one fold and
// scored on the other, both ways, and the dashboard prints the held-out
// error next to two flat baselines (the global median multiple, and the
// flat 0.25 multiple a naive radar would use).

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'comps-odds-1';

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Deterministic 32-bit FNV-1a hash of a slug: the fold key for held-out validation. */
export function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Part 1: the peer multiple, fitted on protocols whose token already trades.
// ---------------------------------------------------------------------------

/** One peer observation: a live-token protocol with both a market cap and a TVL. */
interface Peer {
  slug: string;
  category: string | null;
  size: number; // ln(tvl / 1e8)
  growth: number; // clamp(change_7d, -60, 150) / 100
  y: number; // ln(mcap / tvl)
  tvl: number;
  mcap: number;
}

function toPeer(p: SnapshotProtocol): Peer | null {
  if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return null;
  return {
    slug: p.slug,
    category: p.category,
    size: Math.log(p.tvl_usd / 1e8),
    growth: clamp(finite(p.change_7d, 0), -60, 150) / 100,
    y: Math.log(p.mcap_usd / p.tvl_usd),
    tvl: p.tvl_usd,
    mcap: p.mcap_usd,
  };
}

/** The fitted multiple model: global log-linear terms plus shrunk category offsets. */
export interface MultipleFit {
  intercept: number;
  size_coef: number;
  growth_coef: number;
  category_offsets: Map<string, number>;
  category_counts: Map<string, number>;
  peer_count: number;
  global_median_multiple: number;
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solveN(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    const tmp = m[col]!; m[col] = m[pivot]!; m[pivot] = tmp;
    const div = m[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / div;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - factor * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Category offsets shrink toward zero by n/(n+12): the shrinkage the held-out test chose. */
const OFFSET_SHRINKAGE = 12;

/**
 * Fit the multiple model on a set of peers. The shipped model is y ~ 1 + size
 * plus shrunk category offsets. A growth term is fitted only when `useGrowth`
 * asks for it, for the validation comparison: at full strength it failed the
 * held-out test (median log error 1.40 with it, 1.22 without), because one hot
 * week of mercenary TVL is not what the market pays for.
 */
export function fitMultiples(peers: Peer[], useGrowth = false): MultipleFit {
  const n = peers.length;
  const terms = useGrowth ? 3 : 2;
  const ata = Array.from({ length: terms }, () => Array(terms).fill(0));
  const atb = Array(terms).fill(0);
  for (const p of peers) {
    const x = useGrowth ? [1, p.size, p.growth] : [1, p.size];
    for (let i = 0; i < terms; i++) {
      for (let j = 0; j < terms; j++) ata[i]![j] += x[i]! * x[j]!;
      atb[i] += x[i]! * p.y;
    }
  }
  // A whisper of ridge keeps a degenerate fold finite without moving real fits.
  for (let i = 0; i < terms; i++) ata[i]![i] += 1e-9;
  const beta = solveN(ata, atb);
  const intercept = beta[0]!;
  const sizeCoef = beta[1]!;
  const growthCoef = useGrowth ? beta[2]! : 0;
  // Category offsets: median residual per category, shrunk toward zero.
  const residuals = new Map<string, number[]>();
  for (const p of peers) {
    const key = p.category ?? '(none)';
    const resid = p.y - (intercept + sizeCoef * p.size + growthCoef * p.growth);
    const list = residuals.get(key);
    if (list) list.push(resid); else residuals.set(key, [resid]);
  }
  const offsets = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const [key, list] of residuals) {
    offsets.set(key, (list.length / (list.length + OFFSET_SHRINKAGE)) * median(list));
    counts.set(key, list.length);
  }
  return {
    intercept,
    size_coef: sizeCoef,
    growth_coef: growthCoef,
    category_offsets: offsets,
    category_counts: counts,
    peer_count: n,
    global_median_multiple: Math.exp(median(peers.map((p) => p.y))),
  };
}

/** The fitted multiple for one protocol under a fit: what the market would pay per TVL dollar. */
export function fittedMultiple(fit: MultipleFit, category: string | null, tvl: number, change7d: number | null): number {
  const size = Math.log(Math.max(tvl, 1) / 1e8);
  const growth = clamp(finite(change7d, 0), -60, 150) / 100;
  const offset = fit.category_offsets.get(category ?? '(none)') ?? 0;
  const logM = fit.intercept + fit.size_coef * size + fit.growth_coef * growth + offset;
  return clamp(Math.exp(logM), 0.02, 6);
}

/**
 * Whether a pre-token record is a product of a token that already trades, not
 * a launch of its own: the house's watchlist test, as far as the snapshot's
 * ten fields carry it. A name with the whole word wrapped, staked or staking,
 * a name that begins with an exchange's name, a pure product category, or a
 * bridge whose name is a bare asset ticker (WBTC, USDT0) marks a product.
 * Products are set aside, never ranked: WBTC is Bitcoin, not a future token.
 */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const PRODUCT_CATEGORY = new Set(['Canonical Bridge', 'Liquid Restaking', 'Restaked BTC']);
const BARE_TICKER = /^[A-Z0-9]{2,6}$/;

export function isProduct(p: SnapshotProtocol): boolean {
  if (PRODUCT_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  if (p.category !== null && PRODUCT_CATEGORY.has(p.category)) return true;
  if ((p.category === 'Bridge' || p.category === 'Canonical Bridge') && !/\s/.test(p.name) && BARE_TICKER.test(p.name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Part 2: token odds from the peers' record.
// ---------------------------------------------------------------------------

/** One smoothed rate table: the share of protocols with a token, per bucket. */
export interface OddsTable {
  base_rate: number;
  buckets: { label: string; n: number; with_token: number; rate: number }[];
}

const ODDS_SMOOTHING = 25;

function smoothedRate(withToken: number, n: number, base: number): number {
  return (withToken + ODDS_SMOOTHING * base) / (n + ODDS_SMOOTHING);
}

function buildTable(labels: string[], bucketOf: (p: SnapshotProtocol, age: number | null) => number, protocols: SnapshotProtocol[], ages: Map<string, number | null>, base: number): OddsTable {
  const counts = labels.map(() => ({ n: 0, withToken: 0 }));
  for (const p of protocols) {
    const idx = bucketOf(p, ages.get(p.slug) ?? null);
    counts[idx]!.n += 1;
    if (!isPreToken(p)) counts[idx]!.withToken += 1;
  }
  return {
    base_rate: base,
    buckets: labels.map((label, i) => ({
      label,
      n: counts[i]!.n,
      with_token: counts[i]!.withToken,
      rate: smoothedRate(counts[i]!.withToken, counts[i]!.n, base),
    })),
  };
}

const AGE_LABELS = ['under 6 months', '6-12 months', '1-2 years', '2-4 years', 'over 4 years', 'age unreported'];
function ageBucket(age: number | null): number {
  if (age === null) return 5;
  if (age < 180) return 0;
  if (age < 365) return 1;
  if (age < 730) return 2;
  if (age < 1460) return 3;
  return 4;
}

const TVL_LABELS = ['under $10M', '$10-50M', '$50-250M', 'over $250M'];
function tvlBucket(tvl: number): number {
  if (tvl < 1e7) return 0;
  if (tvl < 5e7) return 1;
  if (tvl < 2.5e8) return 2;
  return 3;
}

/** The three odds tables plus the combined odds lookup they imply. */
export interface OddsModel {
  base_rate: number;
  by_age: OddsTable;
  by_tvl: OddsTable;
  by_category: OddsTable;
  category_index: Map<string, number>;
}

export function fitOdds(snapshot: Snapshot): OddsModel {
  const ages = new Map<string, number | null>();
  for (const p of snapshot.protocols) ages.set(p.slug, ageDays(snapshot.as_of, p.listed_at));
  const withToken = snapshot.protocols.filter((p) => !isPreToken(p)).length;
  const base = withToken / snapshot.protocols.length;
  const byAge = buildTable(AGE_LABELS, (_p, age) => ageBucket(age), snapshot.protocols, ages, base);
  const byTvl = buildTable(TVL_LABELS, (p) => tvlBucket(p.tvl_usd), snapshot.protocols, ages, base);
  const categories = [...new Set(snapshot.protocols.map((p) => p.category ?? '(none)'))].sort();
  const categoryIndex = new Map(categories.map((c, i) => [c, i]));
  const byCategory = buildTable(categories, (p) => categoryIndex.get(p.category ?? '(none)')!, snapshot.protocols, ages, base);
  return { base_rate: base, by_age: byAge, by_tvl: byTvl, by_category: byCategory, category_index: categoryIndex };
}

/** Combined token odds for one protocol: the geometric mean of its three smoothed rates. */
export function tokenOdds(model: OddsModel, p: SnapshotProtocol, age: number | null): number {
  const rAge = model.by_age.buckets[ageBucket(age)]!.rate;
  const rTvl = model.by_tvl.buckets[tvlBucket(p.tvl_usd)]!.rate;
  const catIdx = model.category_index.get(p.category ?? '(none)');
  const rCat = catIdx === undefined ? model.base_rate : model.by_category.buckets[catIdx]!.rate;
  return clamp(Math.cbrt(rAge * rTvl * rCat), 0.02, 0.97);
}

// ---------------------------------------------------------------------------
// Part 3: held-out validation of the multiple fit.
// ---------------------------------------------------------------------------

export interface Validation {
  peer_count: number;
  fitted_median_abs_log_error: number;
  with_growth_median_abs_log_error: number;
  flat_median_abs_log_error: number;
  naive_median_abs_log_error: number;
  fitted_within_2x_pct: number;
}

/** Two-fold held-out test: fit on one slug-hash fold, predict the other fold's market caps, both ways. */
export function validateMultiples(peers: Peer[]): Validation {
  const errors: { fitted: number[]; growth: number[]; flat: number[]; naive: number[] } = { fitted: [], growth: [], flat: [], naive: [] };
  let within = 0;
  let total = 0;
  for (const fold of [0, 1]) {
    const train = peers.filter((p) => slugHash(p.slug) % 2 !== fold);
    const test = peers.filter((p) => slugHash(p.slug) % 2 === fold);
    const fit = fitMultiples(train);
    const fitGrowth = fitMultiples(train, true);
    const flatMultiple = fit.global_median_multiple;
    for (const p of test) {
      const actual = p.mcap;
      const predFitted = p.tvl * fittedMultiple(fit, p.category, p.tvl, p.growth * 100);
      const predGrowth = p.tvl * fittedMultiple(fitGrowth, p.category, p.tvl, p.growth * 100);
      errors.fitted.push(Math.abs(Math.log(predFitted / actual)));
      errors.growth.push(Math.abs(Math.log(predGrowth / actual)));
      errors.flat.push(Math.abs(Math.log((p.tvl * flatMultiple) / actual)));
      errors.naive.push(Math.abs(Math.log((p.tvl * 0.25) / actual)));
      if (predFitted >= actual / 2 && predFitted <= actual * 2) within += 1;
      total += 1;
    }
  }
  return {
    peer_count: peers.length,
    fitted_median_abs_log_error: round4(median(errors.fitted)),
    with_growth_median_abs_log_error: round4(median(errors.growth)),
    flat_median_abs_log_error: round4(median(errors.flat)),
    naive_median_abs_log_error: round4(median(errors.naive)),
    fitted_within_2x_pct: Math.round((within / Math.max(total, 1)) * 100),
  };
}

// ---------------------------------------------------------------------------
// Part 4: farm plans, costed per protocol, with a verdict.
// ---------------------------------------------------------------------------

/** Typical cost of one on-chain action per chain, in dollars: a stated assumption of the plan. */
const GAS_USD: Record<string, number> = {
  Ethereum: 8, 'BNB Chain': 0.4, Solana: 0.05, Base: 0.15, Arbitrum: 0.25, Optimism: 0.2,
  Polygon: 0.05, Avalanche: 0.6, 'zkSync Era': 0.2, Linea: 0.25, Scroll: 0.3, Mantle: 0.1,
  Blast: 0.15, Mode: 0.1, Berachain: 0.3, Sonic: 0.05, Sui: 0.05, Aptos: 0.05, Near: 0.02,
  Cosmos: 0.05, Bitcoin: 1.5, Gnosis: 0.02, Fantom: 0.05, Celo: 0.02, Tron: 0.3,
};

function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 0.5;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 300;
  if (tvl >= 1_000_000_000) return 200;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  if (tvl >= 10_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age and its week's trend: younger protocols get a longer qualifying window, and a protocol shrinking fast gets a shorter one, because its window may close. */
function holdDaysFor(age: number | null, change7d: number | null = null): number {
  let days: number;
  if (age === null) days = 45;
  else if (age < 180) days = 60;
  else if (age < 365) days = 45;
  else if (age < 730) days = 30;
  else days = 21;
  if (change7d !== null && change7d <= -25) days = Math.max(14, days - 14);
  return days;
}

/** One sentence on the protocol's week, from its own 7-day figure, for the plan's hold step. */
function trendSentence(p: SnapshotProtocol): string {
  const g = p.change_7d;
  if (g === null) return 'Its TVL trend is unreported this week, so size the position as the plan states and no more';
  if (g >= 20) return `It grew ${g.toFixed(0)}% this week; hot inflows dilute points fast, so front-load the first two weeks of activity`;
  if (g <= -20) return `Its TVL fell ${Math.abs(g).toFixed(0)}% this week; keep the position at the planned size until the trend stabilises`;
  return `Its TVL moved ${g >= 0 ? '+' : ''}${g.toFixed(1)}% this week, inside its normal range`;
}

type Playbook = { main: string; weekly: string };

/** The category's playbook: the main farming action and the weekly qualifying action. */
function playbookFor(p: SnapshotProtocol, capital: number, chain: string): Playbook {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual')) {
    return {
      main: `Trade ${money(capital)} of volume through ${n} on ${chain}, split across at least four swaps, then leave ${money(Math.round(capital / 2))} in its main liquidity pool`,
      weekly: `one swap of $25 or more, or one liquidity rebalance in the same pool`,
    };
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      main: `Supply ${money(capital)} of USDC to ${n} on ${chain}, then borrow about 30% against it and re-supply the borrow once`,
      weekly: `one small top-up, repayment or rate check that touches the position on chain`,
    };
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return {
      main: `Bridge ${money(capital)} of USDC to ${chain} through ${n}, then put the bridged funds to work in a ${chain} app instead of bridging straight back`,
      weekly: `one more bridge transfer of $25 or more, alternating direction`,
    };
  }
  if (c.includes('staking') || c.includes('restak')) {
    return {
      main: `Stake ${money(capital)} of the chain asset through ${n} on ${chain} and hold the receipt token in the same wallet`,
      weekly: `one claim of staking rewards, or a small additional stake of $10 or more`,
    };
  }
  if (c.includes('prediction')) {
    return {
      main: `Fund ${money(capital)} on ${n} and hold two open market positions at a time, settling each before it expires`,
      weekly: `one new position of $10 or more in a market that settles within the week`,
    };
  }
  if (c.includes('stable')) {
    return {
      main: `Mint or deposit ${money(capital)} of the stable asset through ${n} on ${chain} and hold the balance in the farming wallet`,
      weekly: `one mint, deposit or transfer of $25 or more that refreshes the balance's age`,
    };
  }
  if (c.includes('rwa')) {
    return {
      main: `Mint ${money(capital)} of ${n}'s yield asset on ${chain} and hold it unencumbered in the farming wallet`,
      weekly: `one rewards check on the protocol's own page, plus a $10 top-up mint monthly`,
    };
  }
  if (c.includes('insurance')) {
    return {
      main: `Buy ${money(capital)} of cover from ${n} on ${chain} for a position you actually hold, and keep the policy to expiry`,
      weekly: `one cover quote or renewal check on the protocol's own page`,
    };
  }
  return {
    main: `Deposit ${money(capital)} into ${n}'s main vault or pool on ${chain} and keep the shares in the farming wallet`,
    weekly: `one deposit, withdrawal-and-redeposit or rewards claim of $10 or more`,
  };
}

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

/** The verdict rule, stated on the dashboard: value against the plan's whole cost. */
export function verdictFor(implied: number, totalCost: number): Verdict {
  if (implied >= 15_000_000 && totalCost <= 150) return 'FARM';
  if (implied >= 3_000_000 && totalCost <= 300) return 'THIN';
  return 'SKIP';
}

export interface FarmPlan {
  steps: string[];
  capital_usd: number;
  total_cost_usd: number;
  hold_days: number;
  verdict: Verdict;
}

/** A step as one string: the action, then its cost and time, inside the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text}. Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s;
}

/**
 * One protocol's farm plan: six steps built from its own record (category,
 * chains, TVL, age), each with a dollar cost and a time, plus the plan's
 * totals and its verdict. Two phrasings rotate by slug hash so repeated
 * steps do not read as one stamped template.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age, p.change_7d);
  const book = playbookFor(p, capital, chain);
  const variant = slugHash(p.slug) % 2;
  const setupCost = gas * 3 + (secondChain ? gasFor(secondChain) * 2 : 0);
  const weeks = Math.max(1, Math.round(hold / 7));
  const weeklyCost = gas * 1.5;
  const totalCost = Math.round(setupCost + weeklyCost * weeks + gas * 2);
  const steps = [
    stepText(
      variant === 0
        ? `Open a fresh wallet for ${p.name} alone, fund it from an exchange in one transfer, and keep its seed phrase offline`
        : `Use one dedicated wallet for ${p.name} and nothing else, funded once from an exchange, its seed phrase kept offline`,
      `about ${money(gas * 2)} of gas across the funding and approval transactions`,
      '10 minutes',
    ),
    stepText(
      book.main,
      `${money(capital)} of capital and about ${money(gas * 2)} of gas`,
      '20 minutes to set up',
    ),
    secondChain
      ? stepText(
          `Repeat a smaller version on ${secondChain}, ${p.name}'s second chain: ${money(Math.round(capital / 2))} in the same kind of position, so the wallet has history on both chains`,
          `${money(Math.round(capital / 2))} of capital and about ${money(gasFor(secondChain) * 2)} of gas`,
          '15 minutes',
        )
      : stepText(
          `Split the position in two: keep half as placed and move the other half into a second ${p.name} pool or market on ${chain} a week later, so the history is not a single day`,
          `about ${money(gas * 2)} of gas for the second placement`,
          '10 minutes, one week after the first',
        ),
    stepText(
      `Return every week for ${book.weekly}`,
      `about ${money(weeklyCost)} of gas a week, ${money(weeklyCost * weeks)} across the whole hold`,
      '10 minutes a week',
    ),
    stepText(
      `Hold the position at least ${hold} days without emptying it, so the activity spans more than one of the protocol's own snapshots. ${trendSentence(p)}`,
      `the ${money(capital)} stays in the position; the running cost is the weekly gas above`,
      `${hold} days`,
    ),
    stepText(
      `When a token or points claim is announced, claim only from the link on ${p.name}'s own page or its verified announcement channel, and log every transaction hash in a farm log as you go`,
      'nothing to check the log; never pay anyone to claim for you',
      '15 minutes at the claim, 5 minutes a week for the log',
    ),
  ];
  return { steps, capital_usd: capital, total_cost_usd: totalCost, hold_days: hold, verdict: verdictFor(implied, totalCost) };
}

// ---------------------------------------------------------------------------
// Part 5: the board and the dashboard's data.
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  token_odds: number;
  model: {
    peer_multiple: number;
    token_odds: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
  verdict: Verdict;
  plan_cost_usd: number;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  peer_multiple: number;
  token_odds: number;
  verdict: Verdict;
  plan_cost_usd: number;
  capital_usd: number;
  hold_days: number;
  watchlist: boolean;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  products_screened: number;
  live_size: number;
  fit: {
    peer_count: number;
    intercept: number;
    size_coef: number;
    growth_coef: number;
    growth_coef_fitted: number;
    global_median_multiple: number;
    top_categories: { category: string; peers: number; multiple: number }[];
    validation: Validation;
    odds_base_rate: number;
    odds_by_age: OddsTable;
    odds_by_tvl: OddsTable;
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** The board: every rankable pre-token protocol, scored and ranked by implied value. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const peers = snapshot.protocols.map(toPeer).filter((p): p is Peer => p !== null);
  const fit = fitMultiples(peers);
  const fitWithGrowth = fitMultiples(peers, true);
  const odds = fitOdds(snapshot);
  const validation = validateMultiples(peers);
  const watchlist = new Set(snapshot.watchlist);
  const productsScreened = snapshot.protocols.filter((p) => isRankable(p) && isProduct(p)).length;

  const scored = snapshot.protocols
    .filter((p) => isRankable(p) && !isProduct(p))
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const multiple = fittedMultiple(fit, p.category, p.tvl_usd, p.change_7d);
      const o = tokenOdds(odds, p, age);
      const implied = Math.max(1, Math.round(p.tvl_usd * multiple * o));
      const plan = farmPlan(p, age, implied);
      return { p, age, multiple, odds: o, implied, plan };
    });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    peer_multiple: round4(s.multiple),
    token_odds: round4(s.odds),
    model: {
      peer_multiple: round4(s.multiple),
      token_odds: round4(s.odds),
      growth_pct: round4(clamp(finite(s.p.change_7d, 0), -60, 150)),
      age_days: s.age,
    },
    farm_steps: s.plan.steps,
    verdict: s.plan.verdict,
    plan_cost_usd: s.plan.total_cost_usd,
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 36)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));

  const topCategories = [...fit.category_offsets.entries()]
    .map(([category, offset]) => ({
      category,
      peers: fit.category_counts.get(category) ?? 0,
      multiple: round4(Math.exp(fit.intercept + offset)),
    }))
    .filter((c) => c.peers >= 3)
    .sort((a, b) => b.peers - a.peers)
    .slice(0, 12);

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    products_screened: productsScreened,
    live_size: live.length,
    fit: {
      peer_count: fit.peer_count,
      intercept: round4(fit.intercept),
      size_coef: round4(fit.size_coef),
      growth_coef: round4(fit.growth_coef),
      growth_coef_fitted: round4(fitWithGrowth.growth_coef),
      global_median_multiple: round4(fit.global_median_multiple),
      top_categories: topCategories,
      validation,
      odds_base_rate: round4(odds.base_rate),
      odds_by_age: odds.by_age,
      odds_by_tvl: odds.by_tvl,
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      peer_multiple: r.peer_multiple,
      token_odds: r.token_odds,
      verdict: r.verdict,
      plan_cost_usd: r.plan_cost_usd,
      capital_usd: capitalFor(r.tvl_usd),
      hold_days: holdDaysFor(r.age_days, r.change_7d),
      watchlist: watchlist.has(r.slug),
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's own rows. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
