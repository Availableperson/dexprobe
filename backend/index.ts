import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { JsonRpcProvider, Contract, ZeroAddress, formatUnits } from 'ethers';
import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import dotenv from 'dotenv';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import express from 'express';
import http from 'http';
import { initLogger } from './logger.ts';
import { WebSocketServer, WebSocket } from 'ws';
import { smartRpcRequest, safeDexRpc, logRpcFullStats, getRpcStats } from './rpcProvider.ts';
import { ALL_FACTORIES } from './factories.ts';
import { TOKENS } from './tokens.ts';
import type { TokenInfo } from './tokens.ts';
import { getTokenPriceUSD } from './tokenPriceFetcher.ts';
import { authRouter } from './auth.ts';


// =========== SCAN LOCK c авторазблокировкой ===========
let scanLock = false;
let scanLockTimestamp = 0;
let scanLockTimeout: NodeJS.Timeout | undefined = undefined;
const SCAN_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут

async function acquireScanLock(): Promise<boolean> {
  const now = Date.now();
  if (scanLock && now - scanLockTimestamp < SCAN_LOCK_TIMEOUT_MS) return false;
  scanLock = true;
  scanLockTimestamp = now;
  if (scanLockTimeout) clearTimeout(scanLockTimeout);
  scanLockTimeout = setTimeout(() => {
    scanLock = false;
    scanLockTimestamp = 0;
    console.warn('[SCAN] Timeout! scanLock reset automatically.');
  }, SCAN_LOCK_TIMEOUT_MS);
  return true;
}

function releaseScanLock(): void {
  scanLock = false;
  scanLockTimestamp = 0;
  if (scanLockTimeout) clearTimeout(scanLockTimeout);
}

// ============== ENV ==============
dotenv.config();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const RESULT_PATH = path.resolve(process.cwd(), 'public/data.json');
const MAX_RPS = 100;
const rpsLimiter = new RateLimiterMemory({ points: MAX_RPS, duration: 1 });
const SCAN_TIMEOUT_MS = 45 * 60 * 1000; // 45 min timeout for scan safety

// ============== MULTIUSER LOCK & PROGRESS ==============
type UserId = string;
type Progress = { checked: number; total: number; running: boolean; symbol: string; error?: string; done?: boolean };
const scanStatus: Record<UserId, { running: boolean; progress: Progress }> = {};

function getUserId(req: Request): UserId {
  return req.headers['x-user-id']?.toString() || 'public';
}

// ============== TYPES & CONSTANTS ==============
interface PoolInfo {
  id: string;
  pair: string;
  dex: string;
  version: 'v2' | 'v3';
  fee: string;
  price: string;
  priceHuman: string;
  liquidity0: string;
  liquidity1: string;
  reserve0: string;
  reserve1: string;
  pool: string;
  tvl: number;
  tvlTag: string;
  tvlHuman?: string;
  status: 'ok' | 'error' | 'inactive' | 'arbi';
  errorReason?: string;
  freshness?: string;
  risk?: 'low' | 'medium' | 'high';
  arbitrage?: string;
  maxNoSlippageAmount?: string;
}

const FEE_TIERS = [100, 500, 2500, 3000, 10000];
const FACTORY_V3_ABI = ['function getPool(address,address,uint24) external view returns (address)'];
const POOL_V3_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
];
const FACTORY_V2_ABI = ['function getPair(address,address) external view returns (address)'];
const PAIR_V2_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const FIXED_V2_FEES: Record<string, number> = {
  'Pancake V2': 0.0025, 'Biswap': 0.001, 'ApeSwap': 0.002, 'BakerySwap': 0.003, 'SushiSwap': 0.003,
  'Nomiswap': 0.001, 'BabySwap': 0.003, 'Tenfi': 0.0025,
};
const ARBI_THRESHOLD = 0.004;
const CONCURRENCY_LIMIT = 10;

type PoolUniqKey = string;
const makeV3PoolKey = (dex: string, base: string, quote: string, fee: number, pool: string) =>
  `${dex}_v3_${base}_${quote}_${fee}_${pool}`.toLowerCase();
const makeV2PoolKey = (dex: string, base: string, quote: string, pair: string) =>
  `${dex}_v2_${base}_${quote}_${pair}`.toLowerCase();

function formatNum(n: number, digits = 6): string {
  if (!isFinite(n)) return 'NaN';
  if (Math.abs(n) < 1e-6 || Math.abs(n) >= 1e9) return n.toExponential(6);
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function humanFormat(n: number): string {
  if (!isFinite(n) || n == null) return '-';
  const abs = Math.abs(n);
  if (abs < 1) { if (abs === 0) return '0'; if (abs < 0.000001) return '<0.000001'; return n.toLocaleString(undefined, { maximumFractionDigits: 6 }); }
  if (abs < 1_000) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  if (abs < 1_000_000) return (n / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M';
  return (n / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'B';
}
function isValidPool(price: number | null, liquidity: bigint): boolean {
  return price !== null && isFinite(price) && price > 0 && price < 1e12 && liquidity > 0n;
}
function getLiquidityTag(amount: number): string {
  if (amount === 0) return '💤 inactive';
  if (amount < 1) return '⚠ low';
  if (amount > 10000) return '🔥 high';
  return '💧active';
}
function safeSqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number | null {
  try {
    const Q96 = 2n ** 96n;
    const ratio = sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n / (Q96 * Q96);
    const priceFloat = parseFloat(formatUnits(ratio, 18)) * 10 ** (decimals0 - decimals1);
    return isFinite(priceFloat) && priceFloat > 0 && priceFloat < 1e12 ? priceFloat : null;
  } catch { return null; }
}
function normalizePriceV2({
  baseToken, quoteToken, token0, token1, reserve0, reserve1,
}: { baseToken: TokenInfo, quoteToken: TokenInfo, token0: string, token1: string, reserve0: bigint, reserve1: bigint }): number | null {
  const baseIsToken0 = token0.toLowerCase() === baseToken.address.toLowerCase();
  const baseReserve = baseIsToken0 ? reserve0 : reserve1;
  const quoteReserve = baseIsToken0 ? reserve1 : reserve0;
  const baseAmount = parseFloat(formatUnits(baseReserve, baseToken.decimals));
  const quoteAmount = parseFloat(formatUnits(quoteReserve, quoteToken.decimals));
  if (baseAmount === 0) return null;
  return quoteAmount / baseAmount;
}
function resolveToken(symbolOrAddress: string): TokenInfo | undefined {
  return (
    TOKENS.find(t => t.symbol.toUpperCase() === symbolOrAddress.toUpperCase()) ||
    TOKENS.find(t => t.address.toLowerCase() === symbolOrAddress.toLowerCase())
  );
}
function groupPoolsByPair(pools: PoolInfo[]) {
  const map = new Map<string, PoolInfo[]>();
  for (const pool of pools) {
    const [a, b] = pool.pair.split('/').sort();
    const key = [a, b, pool.dex, pool.version, pool.fee].join('-');
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(pool);
  }
  return map;
}

// ============ TVL UTILITY ============
async function computeTVL(pool: Omit<PoolInfo, 'tvl' | 'tvlTag' | 'tvlHuman'>): Promise<Pick<PoolInfo, 'tvl' | 'tvlTag' | 'tvlHuman'>> {
  try {
    const [base, quote] = pool.pair.split('/');
    const baseToken = TOKENS.find(t => t.symbol === base);
    const quoteToken = TOKENS.find(t => t.symbol === quote);
    if (!baseToken || !quoteToken) {
      return { tvl: 0, tvlTag: 'no-token', tvlHuman: humanFormat(0) };
    }
    let reserveBase = pool.reserve0 ? BigInt(pool.reserve0) : 0n;
    let reserveQuote = pool.reserve1 ? BigInt(pool.reserve1) : 0n;
    let basePrice = 0, quotePrice = 0;

    await smartRpcRequest(async (provider) => {
      basePrice = await getTokenPriceUSD(baseToken.address, provider) || 0;
      quotePrice = await getTokenPriceUSD(quoteToken.address, provider) || 0;
    });

    let baseFloat = Number(formatUnits(reserveBase, baseToken.decimals));
    let quoteFloat = Number(formatUnits(reserveQuote, quoteToken.decimals));
    const baseUSD = basePrice && isFinite(basePrice) ? baseFloat * basePrice : 0;
    const quoteUSD = quotePrice && isFinite(quotePrice) ? quoteFloat * quotePrice : 0;
    let tvl = 0;
    if (baseUSD > 0 && quoteUSD > 0) tvl = baseUSD + quoteUSD;
    else if (baseUSD > 0) tvl = baseUSD * 2;
    else if (quoteUSD > 0) tvl = quoteUSD * 2;

    if (!isFinite(tvl) || tvl <= 0) {
      return { tvl: 0, tvlTag: (!basePrice && !quotePrice) ? 'no-price' : 'no-liquidity', tvlHuman: humanFormat(0) };
    }
    return { tvl, tvlTag: getLiquidityTag(tvl), tvlHuman: humanFormat(tvl) };
  } catch {
    return { tvl: 0, tvlTag: 'error', tvlHuman: humanFormat(0) };
  }
}

// ============ SCAN V3 ============
const logger = initLogger('debug'); // либо нужный уровень
setInterval(() => logRpcFullStats(), 90000);

async function scanV3Pair(
  provider: JsonRpcProvider,
  factoryAddress: string,
  label: string,
  allPools: PoolInfo[],
  v3Seen: Set<PoolUniqKey>,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
) {
  for (const fee of FEE_TIERS) {
    const url = typeof provider === 'object' && provider && 'connection' in provider ? (provider as any).connection?.url : '';
    logger.debug(`[SCAN V3][START] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | provider=${url}`);

    try {
      const factory = new Contract(factoryAddress, FACTORY_V3_ABI, provider);

      let poolAddress = await factory.getPool(tokenA.address, tokenB.address, fee);
      logger.debug(`[SCAN V3][getPool] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | poolAddress=${poolAddress} | baseIsToken0=true | provider=${url}`);

      let baseIsToken0 = true;
      if (poolAddress === ZeroAddress) {
        poolAddress = await factory.getPool(tokenB.address, tokenA.address, fee);
        baseIsToken0 = false;
        logger.debug(`[SCAN V3][getPool][reverse] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | poolAddress=${poolAddress} | baseIsToken0=false | provider=${url}`);
      }
      if (poolAddress === ZeroAddress) {
        logger.debug(`[SCAN V3][NO_POOL] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | provider=${url}`);
        continue;
      }

      const key = makeV3PoolKey(label, tokenA.symbol, tokenB.symbol, fee, poolAddress);
      if (v3Seen.has(key)) {
        logger.debug(`[SCAN V3][SEEN] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | poolAddress=${poolAddress} | provider=${url}`);
        continue;
      }
      v3Seen.add(key);

      const pool = new Contract(poolAddress, POOL_V3_ABI, provider);
      logger.debug(`[SCAN V3][LOAD_POOL] ${label} | ${tokenA.symbol}/${tokenB.symbol} | pool=${poolAddress} | provider=${url}`);

      const [token0, token1, slot0, liquidityRaw] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(),
        pool.liquidity(),
      ]);
      logger.debug(`[SCAN V3][POOL_META] ${label} | token0=${token0} | token1=${token1} | slot0.sqrtPriceX96=${slot0?.sqrtPriceX96?.toString?.()} | liquidityRaw=${liquidityRaw} | provider=${url}`);

      const token0info = TOKENS.find(t => t.address.toLowerCase() === token0.toLowerCase());
      const token1info = TOKENS.find(t => t.address.toLowerCase() === token1.toLowerCase());
      if (!token0info || !token1info) {
        logger.debug(`[SCAN V3][SKIP_TOKENS] ${label} | token0/token1 info not found | token0=${token0} | token1=${token1} | provider=${url}`);
        continue;
      }

      const baseToken = baseIsToken0 ? tokenA : tokenB;
      const quoteToken = baseIsToken0 ? tokenB : tokenA;

      let rawPrice = safeSqrtPriceX96ToPrice(slot0.sqrtPriceX96, token0info.decimals, token1info.decimals);
      logger.debug(`[SCAN V3][PRICE_RAW] ${label} | rawPrice=${rawPrice} | baseIsToken0=${baseIsToken0} | provider=${url}`);

      if (!baseIsToken0 && rawPrice !== null && rawPrice !== 0) {
        rawPrice = 1 / rawPrice;
        logger.debug(`[SCAN V3][PRICE_INVERT] ${label} | inverted rawPrice=${rawPrice} | provider=${url}`);
      }
      if (!isValidPool(rawPrice, liquidityRaw)) {
        logger.debug(`[SCAN V3][INVALID_POOL] ${label} | rawPrice=${rawPrice} | liquidityRaw=${liquidityRaw} | provider=${url}`);
        continue;
      }

      const liquidity0 = parseFloat(formatUnits(liquidityRaw, token0info.decimals));
      const liquidity1 = rawPrice && liquidity0 > 0 ? liquidity0 * rawPrice : 0;

      logger.debug(`[SCAN V3][LIQUIDITY] ${label} | liquidity0=${liquidity0} | liquidity1=${liquidity1} | provider=${url}`);

      let risk: 'low' | 'medium' | 'high' = 'low';
      if (liquidity0 < 500 || liquidity1 < 500) risk = 'high';
      else if (liquidity0 < 2500 || liquidity1 < 2500) risk = 'medium';

      const maxNoSlippageAmount = liquidity0 * 0.02;

      logger.debug(`[SCAN V3][POOL_READY] ${label} | risk=${risk} | maxNoSlippageAmount=${maxNoSlippageAmount} | provider=${url}`);

      const basePool: Omit<PoolInfo, 'tvl' | 'tvlTag' | 'tvlHuman'> = {
        id: key,
        pair: `${tokenA.symbol}/${tokenB.symbol}`,
        dex: label,
        version: 'v3',
        fee: `${(fee / 10000).toFixed(2)}%`,
        price: String(rawPrice!),
        priceHuman: humanFormat(rawPrice!),
        liquidity0: humanFormat(liquidity0),
        liquidity1: humanFormat(liquidity1),
        reserve0: String(liquidityRaw),
        reserve1: String(Math.floor(liquidity1)),
        pool: poolAddress,
        status: 'ok',
        freshness: 'N/A',
        risk,
        maxNoSlippageAmount: humanFormat(maxNoSlippageAmount),
      };

      logger.debug(`[SCAN V3][COMPUTE_TVL] ${label} | pool=${poolAddress} | provider=${url}`);
      const tvl = await computeTVL(basePool);

      logger.debug(`[SCAN V3][PUSH_POOL] ${label} | tvl=${JSON.stringify(tvl)} | provider=${url}`);
      allPools.push({ ...basePool, ...tvl });

      logger.debug(`[SCAN V3][DONE] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | pool=${poolAddress} | provider=${url}`);
    } catch (err) {
      logger.error(`[SCAN V3][ERROR] ${label} | ${tokenA.symbol}/${tokenB.symbol} | fee=${fee} | provider=${url} | ${(err as any)?.message || err}`);
    }
  }
}
// ============ SCAN V2 ============
export async function scanV2Pair(
  provider: JsonRpcProvider,
  factoryAddress: string,
  label: string,
  allPools: PoolInfo[],
  v2Seen: Set<PoolUniqKey>,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
): Promise<void> {
  logger.debug(`[SCAN V2] ${label} | ${tokenA.symbol}/${tokenB.symbol} | provider=${(provider as any).connection?.url || ''}`);
  try {
    const contract = new Contract(factoryAddress, FACTORY_V2_ABI, provider);
    let pairAddress = await contract.getPair(tokenA.address, tokenB.address);
    let baseIsTokenA = true;
    if (pairAddress === ZeroAddress) {
      pairAddress = await contract.getPair(tokenB.address, tokenA.address);
      baseIsTokenA = false;
    }
    if (pairAddress === ZeroAddress) return;
    const key = makeV2PoolKey(label, tokenA.symbol, tokenB.symbol, pairAddress);
    if (v2Seen.has(key)) return;
    v2Seen.add(key);

    const pair = new Contract(pairAddress, PAIR_V2_ABI, provider);
    const [token0, token1, reserves] = await Promise.all([
      pair.token0(),
      pair.token1(),
      pair.getReserves(),
    ]);
    const token0info = TOKENS.find(t => t.address.toLowerCase() === token0.toLowerCase());
    const token1info = TOKENS.find(t => t.address.toLowerCase() === token1.toLowerCase());
    if (!token0info || !token1info) return;

    const reserve0 = reserves[0];
    const reserve1 = reserves[1];
    const liquidity0 = parseFloat(formatUnits(reserve0, token0info.decimals));
    const liquidity1 = parseFloat(formatUnits(reserve1, token1info.decimals));

    const baseToken = baseIsTokenA ? tokenA : tokenB;
    const quoteToken = baseIsTokenA ? tokenB : tokenA;
    const price = normalizePriceV2({
      baseToken,
      quoteToken,
      token0,
      token1,
      reserve0: BigInt(reserve0),
      reserve1: BigInt(reserve1),
    });
    if (!isValidPool(price, BigInt(reserve0))) return;

    const fee = FIXED_V2_FEES[label] ?? 0.003;
    const now = Math.floor(Date.now() / 1000);
    const secondsAgo = now - Number(reserves[2]);
    const freshness = secondsAgo < 60
      ? `${secondsAgo} сек назад`
      : secondsAgo < 3600
      ? `${Math.floor(secondsAgo/60)} мин назад`
      : `${Math.floor(secondsAgo/3600)} ч назад`;

    let risk: 'low' | 'medium' | 'high' = 'low';
    if (secondsAgo > 1800 || liquidity0 < 500 || liquidity1 < 500) risk = 'high';
    else if (secondsAgo > 600 || liquidity0 < 2500 || liquidity1 < 2500) risk = 'medium';

    const maxNoSlippageAmount = liquidity0 * 0.02;

    const basePool: Omit<PoolInfo, 'tvl' | 'tvlTag' | 'tvlHuman'> = {
      id: key,
      pair: `${tokenA.symbol}/${tokenB.symbol}`,
      dex: label,
      version: 'v2',
      fee: `${(fee * 100).toFixed(2)}%`,
      price: String(price!),
      priceHuman: humanFormat(price!),
      liquidity0: humanFormat(liquidity0),
      liquidity1: humanFormat(liquidity1),
      reserve0: String(reserve0),
      reserve1: String(reserve1),
      pool: pairAddress,
      status: 'ok',
      freshness,
      risk,
      maxNoSlippageAmount: humanFormat(maxNoSlippageAmount),
    };
    const tvl = await computeTVL(basePool);
    allPools.push({ ...basePool, ...tvl });
  } catch (err) {
    logger.error(
      `[SCAN V2 ERROR] ${label} | ${tokenA.symbol}/${tokenB.symbol} | provider=${(provider as any).connection?.url || ''} | ${(err as any)?.message || err}`
    );
  }
}
// ============ WEBSOCKET SERVER ============
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set<WebSocket>();

function broadcast(data: any) {
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);
  console.log(`[WS] Client connected, total: ${clients.size}`);
  for (const userId in scanStatus) {
    const progress = scanStatus[userId]?.progress;
    if (progress) {
      ws.send(JSON.stringify({ type: 'progress', userId, progress }));
    }
  }
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected, total: ${clients.size}`);
  });
  ws.on('error', (err: any) => {
    console.error('[WS] Client error:', err);
  });
});

// ============ ГЛАВНАЯ ЛОГИКА СКАНИРОВАНИЯ ============
async function main(userId: UserId, symbol?: string) {
  if (!scanStatus[userId]) scanStatus[userId] = { running: false, progress: { checked: 0, total: 0, running: false, symbol: '', error: '' } };
  let progress = scanStatus[userId].progress;
  progress.running = true;
  progress.symbol = symbol || '';
  progress.error = '';

  try {
    await fs.promises.mkdir(path.dirname(RESULT_PATH), { recursive: true });
    await fs.promises.writeFile(
      RESULT_PATH,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        pairs: [],
        poolsCount: 0,
        status: 'scan_in_progress'
      }, null, 2)
    );
  } catch {}

  const allPools: PoolInfo[] = [];
  const v3Seen = new Set<PoolUniqKey>();
  const v2Seen = new Set<PoolUniqKey>();

  let match: TokenInfo | undefined = symbol ? resolveToken(symbol) : undefined;
  if (!match) { progress.running = false; progress.error = 'Token not found'; return; }
  const tokensToCheck = TOKENS.filter(t => t.address !== match.address);

  let totalPairs = 0;
  for (const factory of ALL_FACTORIES) {
    if (factory.kind === 'uniswap-v3') {
      totalPairs += tokensToCheck.length * 2 * FEE_TIERS.length;
    } else if (factory.kind === 'v2') {
      totalPairs += tokensToCheck.length * 2;
    }
  }
  progress.checked = 0;
  progress.total = totalPairs;
  progress.running = true;

  let scanInterval: NodeJS.Timeout | undefined = undefined;
  scanInterval = setInterval(async () => {
    try {
      const payload = {
        type: 'update',
        userId,
        timestamp: Date.now(),
        pairs: allPools,
        poolsCount: allPools.length,
        status: 'scanning',
        progress: scanStatus[userId]?.progress,
      };
      broadcast(payload);

      await fs.promises.writeFile(
        RESULT_PATH,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          updatedAtMs: Date.now(),
          pairs: allPools,
          poolsCount: allPools.length,
          status: 'scanning'
        }, null, 2)
      );

      progress.checked = allPools.length;
    } catch {}
  }, 1200);

  const limit = pLimit(CONCURRENCY_LIMIT);
  const scanTasks: Promise<void>[] = [];

  let checkedCount = 0;
  const incChecked = () => { ++checkedCount; progress.checked = checkedCount; };

  for (const factory of ALL_FACTORIES) {
    if (factory.kind === 'uniswap-v3') {
      for (const token of tokensToCheck) {
        scanTasks.push(limit(async () => {
          await rpsLimiter.consume(1);
          incChecked();
          return smartRpcRequest(provider => scanV3Pair(provider, factory.address, factory.label, allPools, v3Seen, match!, token));
        }));
        scanTasks.push(limit(async () => {
          await rpsLimiter.consume(1);
          incChecked();
          return smartRpcRequest(provider => scanV3Pair(provider, factory.address, factory.label, allPools, v3Seen, token, match!));
        }));
      }
    } else if (factory.kind === 'v2') {
      for (const token of tokensToCheck) {
        scanTasks.push(limit(async () => {
          await rpsLimiter.consume(1);
          incChecked();
          return smartRpcRequest(provider => scanV2Pair(provider, factory.address, factory.label, allPools, v2Seen, match!, token));
        }));
        scanTasks.push(limit(async () => {
          await rpsLimiter.consume(1);
          incChecked();
          return smartRpcRequest(provider => scanV2Pair(provider, factory.address, factory.label, allPools, v2Seen, token, match!));
        }));
      }
    }
  }

  let scanTimedOut = false;
  const scanTimeout = setTimeout(() => {
    scanTimedOut = true;
    progress.running = false;
    progress.error = 'Timeout: Scan too long, aborted.';
  }, SCAN_TIMEOUT_MS);

  try {
    await Promise.all(scanTasks);
  } catch (e) {
    progress.error = String(e);
  } finally {
    if (scanInterval) clearInterval(scanInterval);
    if (scanTimeout) clearTimeout(scanTimeout);
  }

  for (const group of groupPoolsByPair(allPools).values()) {
    if (group.length > 1) {
      for (let i = 0; i < group.length; ++i) {
        for (let j = i + 1; j < group.length; ++j) {
          const a = group[i], b = group[j];
          const priceA = Number(a.price), priceB = Number(b.price);
          if (priceA > 0 && priceB > 0) {
            const delta = Math.abs((priceA - priceB) / Math.min(priceA, priceB));
            if (delta > ARBI_THRESHOLD) {
              const deltaPct = ((priceA > priceB ? priceA / priceB : priceB / priceA) - 1) * 100;
              a.arbitrage = `+${deltaPct.toFixed(2)}%`;
              b.arbitrage = `+${deltaPct.toFixed(2)}%`;
              a.status = 'arbi';
              b.status = 'arbi';
            }
          }
        }
      }
    }
  }

  try {
    await fs.promises.writeFile(
      RESULT_PATH,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        pairs: allPools,
        poolsCount: allPools.length,
        status: progress.error ? 'error' : 'done'
      }, null, 2)
    );
  } catch {}
  progress.running = false;
  progress.done = true;
  broadcast({ type: 'done', userId, progress });
}

// ============ EXPRESS SETUP ============
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://bscscan.com"],
      connectSrc: ["'self'"],
    }
  }
}));
app.use(cors());
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, slow down.' },
});
app.use(['/api/scan', '/scan'], apiLimiter);

const validateSymbol = (req: Request, res: Response, next: NextFunction): void => {
  const { symbol } = req.body || {};
  if (typeof symbol !== 'string' || symbol.length < 2 || symbol.length > 64 || !/^[a-zA-Z0-9\-_.:/]+$/.test(symbol)) {
    res.status(400).json({ ok: false, error: 'Invalid symbol' }); return;
  } next();
};

app.post('/api/scan', validateSymbol, async (req: Request, res: Response) => {
  const { symbol } = req.body || {};
  const userId = 'public'; // Замени при мультипользовательском режиме
  const lockAcquired = await acquireScanLock();

  console.log(`[SCAN] main() called: userId=${userId}, symbol=${symbol}, time=${new Date().toISOString()}`);

  if (!lockAcquired) {
    console.log(`[SCAN] Scan already running — отклонено: userId=${userId}, symbol=${symbol}, time=${new Date().toISOString()}`);
    res.status(409).json({ ok: false, error: 'Scan already running' });
    return;
  }

  try {
    await fs.promises.mkdir(path.dirname(RESULT_PATH), { recursive: true });
    await fs.promises.writeFile(
      RESULT_PATH,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        pairs: [],
        poolsCount: 0,
        status: 'scan_in_progress'
      }, null, 2)
    );

    console.log(`[SCAN] Запуск сканирования: symbol=${symbol}, time=${new Date().toISOString()}`);

    main(userId, symbol)
      .catch(err => {
        console.error('[SCAN] Ошибка в main():', err);
      })
      .finally(() => {
        releaseScanLock();
        console.log(`[SCAN] Сканирование завершено, блокировка снята: userId=${userId}, symbol=${symbol}, time=${new Date().toISOString()}`);
      });

    res.json({ ok: true, started: true });
  } catch (err) {
    releaseScanLock();
    console.error('[SCAN] Ошибка в API /scan:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/api/scan-progress', (req: Request, res: Response) => {
  const userId = getUserId(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const sendProgress = () => {
    const progress = scanStatus[userId]?.progress || { running: false, checked: 0, total: 0, symbol: '', error: '' };
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
    if (!progress.running) clearInterval(timer);
  };
  const timer = setInterval(sendProgress, 750);
  req.on('close', () => clearInterval(timer));
  sendProgress();
});

app.post('/api/scan-reset', (_req: Request, res: Response) => {
  releaseScanLock();
  res.json({ ok: true, message: 'Scan lock released manually.' });
});

app.get('/api/result', async (_req: Request, res: Response) => {
  try {
    await fs.promises.access(RESULT_PATH, fs.constants.F_OK);
    res.sendFile(RESULT_PATH);
  } catch { res.status(404).json({ ok: false, error: 'Result not ready' }); }
});

app.use(express.static('public'));
app.use(authRouter);
app.use((_req, res) => { res.status(404).json({ ok: false, error: 'Not found' }); });

// ============ SERVER START ============
server.listen(PORT, () => {
  console.log(`DEX Scanner Web API running at http://localhost:${PORT}`);
});

// ---- Экспорт алиасов ----
export { smartRpcRequest, safeDexRpc };
