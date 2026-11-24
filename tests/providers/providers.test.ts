import { describe, expect, it, vi } from 'vitest';
import {
  EastmoneyProvider,
  HithinkProvider,
  ProviderRequestError,
  SinaProvider,
  TencentProvider,
  parseEastmoneyIntradayResponse,
  parseEastmoneySearchResponse,
  parseSinaSnapshotResponse,
  parseTencentIntradayResponse,
  parseTencentSearchResponse,
  parseTencentSnapshotResponse,
  type FetchLike,
} from '../../src/main/providers';

function buildTencentLine(params: {
  txCode: string;
  name: string;
  code: string;
  price: string;
  prevClose: string;
  open: string;
  volHands: string;
  timeStr: string;
  changeAmt: string;
  changePct: string;
  high: string;
  low: string;
  f35: string;
  f37Wan: string;
}): string {
  const fields = new Array<string>(45).fill('0');
  fields[0] = '1';
  fields[1] = params.name;
  fields[2] = params.code;
  fields[3] = params.price;
  fields[4] = params.prevClose;
  fields[5] = params.open;
  fields[6] = params.volHands;
  fields[30] = params.timeStr;
  fields[31] = params.changeAmt;
  fields[32] = params.changePct;
  fields[33] = params.high;
  fields[34] = params.low;
  fields[35] = params.f35;
  fields[36] = params.volHands;
  fields[37] = params.f37Wan;
  return `v_${params.txCode}="${fields.join('~')}";`;
}

function buildSinaLine(params: {
  sinaCode: string;
  name: string;
  open: string;
  prevClose: string;
  price: string;
  high: string;
  low: string;
  volume: string;
  turnoverYuan: string;
  dateStr: string;
  timeStr: string;
}): string {
  const fields = new Array<string>(33).fill('0');
  fields[0] = params.name;
  fields[1] = params.open;
  fields[2] = params.prevClose;
  fields[3] = params.price;
  fields[4] = params.high;
  fields[5] = params.low;
  fields[8] = params.volume;
  fields[9] = params.turnoverYuan;
  fields[30] = params.dateStr;
  fields[31] = params.timeStr;
  return `var hq_str_${params.sinaCode}="${fields.join(',')}";`;
}

describe('TencentProvider parsers & HTTP', () => {
  it('parses batch snapshots with exact yuan from f35, fallback to f37*10000, and hands->shares conversion', () => {
    const sample = [
      buildTencentLine({
        txCode: 'sh000001',
        name: '上证指数',
        code: '000001',
        price: '3548.37',
        prevClose: '3538.95',
        open: '3567.84',
        volHands: '493526296',
        timeStr: '20261124150003',
        changeAmt: '9.42',
        changePct: '0.27',
        high: '3585.22',
        low: '3539.01',
        f35: '3548.37/493526296/771861010309',
        f37Wan: '77186101',
      }),
      // f35 缺失第三段时自动回退至 f37(万元) × 10000
      buildTencentLine({
        txCode: 'sz399106',
        name: '深证综指',
        code: '399106',
        price: '1965.43',
        prevClose: '1950.00',
        open: '1955.00',
        volHands: '590663196',
        timeStr: '20261124150003',
        changeAmt: '15.43',
        changePct: '0.79',
        high: '1970.00',
        low: '1948.00',
        f35: '1965.43/590663196/',
        f37Wan: '88322492',
      }),
    ].join('\n');

    const map = parseTencentSnapshotResponse(sample);
    expect(map.size).toBe(2);

    const sh = map.get('000001.SH')!;
    expect(sh.name).toBe('上证指数');
    expect(sh.price).toBe(3548.37);
    expect(sh.turnover).toBe(771_861_010_309); // 精确到元
    expect(sh.volumeShares).toBe(49_352_629_600); // 手 × 100
    expect(sh.tradeDate).toBe('2026-11-24');
    expect(sh.source).toBe('tencent');

    const sz = map.get('399106.SZ')!;
    expect(sz.turnover).toBe(883_224_920_000); // 万元 × 10000
    expect(sz.volumeShares).toBe(59_066_319_600);
  });

  it('cleans day/query intraday bars: extracts 0930 auction, drops 1300 duplicate & >1500 after-hours, never zero-fills gaps', () => {
    const payload = {
      data: {
        sh600519: {
          data: [
            {
              date: '20261124',
              prec: '1450.00',
              data: [
                '0930 1425.00 763 108727500.00', // 开盘竞价锚点
                '0931 1430.00 1763 251727500.00', // minuteIndex 0
                // 刻意缺失 0932（minuteIndex 1）验证不补零
                '0933 1435.00 2263 323477500.00', // minuteIndex 2
                '1130 1440.00 20000 2880000000.00', // minuteIndex 119
                '1300 1440.00 20000 2880000000.00', // 腾讯午休重复节点 → 必须丢弃
                '1301 1442.00 20500 2952100000.00', // minuteIndex 120
                '1500 1460.00 42562 6214192454.00', // minuteIndex 239
                '1505 1460.00 42568 6215068454.00', // 盘后固定价格交易 → 必须丢弃
                '1530 1460.00 42568 6215068454.00', // 盘后固定价格交易 → 必须丢弃
              ],
            },
          ],
        },
      },
    };

    const days = parseTencentIntradayResponse(payload, '600519.SH', 2);
    expect(days).toHaveLength(1);
    const day = days[0];
    expect(day.tradeDate).toBe('2026-11-24');
    expect(day.auction).toEqual({ openPrice: 1425, auctionTurnover: 108_727_500 });
    expect(day.bars.map((b) => b.minuteIndex)).toEqual([0, 2, 119, 120, 239]);
    // 验证未补零 minuteIndex 1
    expect(day.bars.find((b) => b.minuteIndex === 1)).toBeUndefined();
    // 验证第 0 分钟纯连续竞价增量 = cum(0931) - auction(0930)
    expect(day.bars[0].barTurnover).toBeCloseTo(143_000_000, 2);
    expect(day.bars[0].cumVolume).toBe(176_300);
    // 验证收盘精确为 1500，不含 1530 盘后额
    expect(day.bars[day.bars.length - 1].cumTurnover).toBe(6_214_192_454);
  });

  it('parses smartbox search response and filters to A-share stocks and indices', () => {
    const raw =
      'v_hint="sz~300750~\\u5b81\\u5fb7\\u65f6\\u4ee3~ndsd~GP-A^hk~00700~\\u817e\\u8baf~tx~GP-HK^sh~000001~\\u4e0a\\u8bc1\\u6307\\u6570~szzs~ZS";';
    const items = parseTencentSearchResponse(raw, 10);
    expect(items).toEqual([
      {
        symbol: '300750.SZ',
        ticker: '300750',
        name: '宁德时代',
        exchange: 'SZ',
        assetType: 'STOCK',
        source: 'tencent',
      },
      {
        symbol: '000001.SH',
        ticker: '000001',
        name: '上证指数',
        exchange: 'SH',
        assetType: 'INDEX',
        source: 'tencent',
      },
    ]);
  });

  it('throws rateLimited error on HTTP 429', async () => {
    const mockFetch: FetchLike = vi.fn(async () => new Response('Too Many Requests', { status: 429 }));
    const provider = new TencentProvider({ fetchImpl: mockFetch });
    await expect(provider.fetchBatchSnapshots(['000001.SH'])).rejects.toMatchObject({
      name: 'ProviderRequestError',
      provider: 'tencent',
      httpStatus: 429,
      rateLimited: true,
    });
  });
});

describe('SinaProvider parsers & HTTP', () => {
  it('handles SH-index hands vs SZ-index/stock shares volume trap and matches yuan turnover', () => {
    const sample = [
      buildSinaLine({
        sinaCode: 'sh000001',
        name: '上证指数',
        open: '3567.8405',
        prevClose: '3538.95',
        price: '3548.37',
        high: '3585.22',
        low: '3539.01',
        volume: '493526296', // 沪市指数单位为手！
        turnoverYuan: '771861010309',
        dateStr: '2026-11-24',
        timeStr: '15:00:03',
      }),
      buildSinaLine({
        sinaCode: 'sz399106',
        name: '深证综指',
        open: '1955.00',
        prevClose: '1950.00',
        price: '1965.43',
        high: '1970.00',
        low: '1948.00',
        volume: '59066319600', // 深市指数单位为股！
        turnoverYuan: '883224915526',
        dateStr: '2026-11-24',
        timeStr: '15:00:03',
      }),
      buildSinaLine({
        sinaCode: 'sh600519',
        name: '贵州茅台',
        open: '1425.00',
        prevClose: '1450.00',
        price: '1460.00',
        high: '1465.00',
        low: '1420.00',
        volume: '4256200', // 沪市个股单位为股！
        turnoverYuan: '6214192454',
        dateStr: '2026-11-24',
        timeStr: '15:00:00',
      }),
    ].join('\n');

    const map = parseSinaSnapshotResponse(sample);
    expect(map.get('000001.SH')?.volumeShares).toBe(49_352_629_600); // ×100
    expect(map.get('000001.SH')?.turnover).toBe(771_861_010_309);
    expect(map.get('000001.SH')?.changePct).toBeCloseTo(0.27, 2);

    expect(map.get('399106.SZ')?.volumeShares).toBe(59_066_319_600); // ×1
    expect(map.get('399106.SZ')?.turnover).toBe(883_224_915_526);

    expect(map.get('600519.SH')?.volumeShares).toBe(4_256_200); // ×1
    expect(map.get('600519.SH')?.turnover).toBe(6_214_192_454);
  });

  it('sends required finance.sina.com.cn Referer header', async () => {
    let capturedReferer = '';
    const mockFetch: FetchLike = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      capturedReferer = headers?.Referer ?? '';
      return new Response(
        buildSinaLine({
          sinaCode: 'sh000001',
          name: '上证指数',
          open: '3567.84',
          prevClose: '3538.95',
          price: '3548.37',
          high: '3585.22',
          low: '3539.01',
          volume: '493526296',
          turnoverYuan: '771861010309',
          dateStr: '2026-11-24',
          timeStr: '15:00:03',
        }),
        { status: 200 }
      );
    });

    const provider = new SinaProvider({ fetchImpl: mockFetch });
    const res = await provider.fetchBatchSnapshots(['000001.SH']);
    expect(capturedReferer).toBe('https://finance.sina.com.cn/');
    expect(res.get('000001.SH')?.turnover).toBe(771_861_010_309);
  });
});

describe('EastmoneyProvider parsers', () => {
  it('accumulates prefix-sum turnover from f57 starting with 09:30 auction and uses f53 price', () => {
    const payload = {
      data: {
        preClose: 3538.95,
        trends: [
          // 历史日 f52 为 0.00，必须取 f53（index 2）
          '2026-11-23 09:30,0.00,3520.00,3520.00,3520.00,1000,100000000,3520.00',
          '2026-11-23 09:31,0.00,3525.00,3528.00,3518.00,2000,250000000,3523.00',
          '2026-11-24 09:30,3567.84,3567.84,3567.84,3567.84,7725349,12728771688.50,3567.84',
          '2026-11-24 09:31,3567.84,3559.78,3568.00,3558.00,22333229,38616172951.90,3562.00',
          '2026-11-24 13:01,3550.00,3552.00,3553.00,3549.00,5000000,8000000000.00,3551.00',
        ],
      },
    };

    const days = parseEastmoneyIntradayResponse(payload, '000001.SH', 2);
    expect(days).toHaveLength(2);
    expect(days[0].tradeDate).toBe('2026-11-24');
    expect(days[0].auction).toEqual({
      openPrice: 3567.84,
      auctionTurnover: 12_728_771_688.5,
    });
    expect(days[0].bars.map((b) => b.minuteIndex)).toEqual([0, 120]);
    expect(days[0].bars[0].cumTurnover).toBeCloseTo(51_344_944_640.4, 2);
    expect(days[0].bars[0].barTurnover).toBeCloseTo(38_616_172_951.9, 2);
    expect(days[1].tradeDate).toBe('2026-11-23');
    expect(days[1].bars[0].price).toBe(3525);
  });

  it('parses Eastmoney suggest search results accurately', () => {
    const payload = {
      QuotationCodeTable: {
        Data: [
          { Code: '600519', Name: '贵州茅台', MktNum: '1', Classify: 'AStock', SecurityTypeName: '沪A' },
          { Code: '00700', Name: '腾讯控股', MktNum: '116', Classify: 'HK', SecurityTypeName: '港股' },
        ],
      },
    };
    const res = parseEastmoneySearchResponse(payload, 10);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      symbol: '600519.SH',
      name: '贵州茅台',
      exchange: 'SH',
      assetType: 'STOCK',
      source: 'eastmoney',
    });
  });

  it('fetches trends2 from push2his host via EastmoneyProvider', async () => {
    let capturedUrl = '';
    const mockFetch: FetchLike = vi.fn(async (url) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          data: {
            preClose: 3538.95,
            trends: [
              '2026-11-24 09:30,3567.84,3567.84,3567.84,3567.84,1000,1000000,3567.84',
              '2026-11-24 09:31,3567.84,3560.00,3568.00,3559.00,2000,2000000,3562.00',
            ],
          },
        }),
        { status: 200 }
      );
    });

    const provider = new EastmoneyProvider({ fetchImpl: mockFetch });
    const days = await provider.fetchIntradayMinutes('000001.SH', 2);
    expect(capturedUrl).toContain('https://push2his.eastmoney.com/');
    expect(capturedUrl).toContain('ndays=2');
    expect(capturedUrl).toContain('secid=1.000001');
    expect(days[0].bars).toHaveLength(1);
  });
});

describe('HithinkProvider security, parsing & code=4001 backoff', () => {
  it('sends API key strictly via X-api-key header and never exposes it in URL or errors', async () => {
    const secret = 'SUPER-SECRET-HITHINK-TOKEN-XYZ';
    const capturedUrls: string[] = [];
    const capturedKeys: string[] = [];

    const mockFetch: FetchLike = vi.fn(async (url, init) => {
      capturedUrls.push(String(url));
      const headers = init?.headers as Record<string, string>;
      capturedKeys.push(headers?.['X-api-key'] ?? '');

      if (String(url).includes('/calendar/trading-days')) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: { item: [{ date: '20261123' }, { date: '20261124' }] },
          }),
          { status: 200 }
        );
      }

      if (String(url).includes('/a-share-index/prices/snapshot')) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: {
              timestamp: 1795503600000,
              item: [
                {
                  thscode: '000001.SH',
                  last_price: 3548.37,
                  price_change_ratio_pct: 0.27,
                  volume: 49352629600,
                  turnover: 771861010309,
                },
              ],
            },
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            timestamp: 1795503600000,
            item: [
              {
                thscode: '600519.SH',
                last_price: 1460,
                price_change_ratio_pct: 0.69,
                volume: 4256200,
                turnover: 6214192454,
              },
            ],
          },
        }),
        { status: 200 }
      );
    });

    const provider = new HithinkProvider({
      secretStore: { getApiKey: () => secret },
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    const days = await provider.fetchTradingDays();
    expect(days).toEqual([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);

    const snaps = await provider.fetchBatchSnapshots(
      ['000001.SH', '600519.SH'],
      new Map([['600519.SH', '贵州茅台']])
    );
    expect(snaps.get('000001.SH')?.name).toBe('上证指数');
    expect(snaps.get('000001.SH')?.turnover).toBe(771_861_010_309);
    expect(snaps.get('600519.SH')?.name).toBe('贵州茅台');
    expect(snaps.get('600519.SH')?.volumeShares).toBe(4_256_200);

    expect(capturedUrls.every((u) => !u.includes(secret))).toBe(true);
    expect(capturedKeys.every((k) => k === secret)).toBe(true);
  });

  it('retries code=4001 with exponential backoff up to 3 times and fails without leaking key', async () => {
    const secret = 'DO-NOT-LEAK-4001-KEY';
    const backoffDelays: number[] = [];
    let calls = 0;

    const mockFetch: FetchLike = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ code: 4001, message: 'rate limit exceeded' }),
        { status: 200 }
      );
    });

    const provider = new HithinkProvider({
      secretStore: { getApiKey: () => secret },
      fetchImpl: mockFetch,
      sleepImpl: async (ms) => {
        backoffDelays.push(ms);
      },
      initialBackoffMs: 100,
      maxRetries: 3,
    });

    let caught: unknown = null;
    try {
      await provider.fetchTradingDays();
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(4); // 首次 + 最多重试 3 次
    expect(backoffDelays).toEqual([100, 200, 400]);
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).apiCode).toBe(4001);
    expect((caught as ProviderRequestError).rateLimited).toBe(true);
    expect(String(caught)).not.toContain(secret);
  });
});
