#!/usr/bin/env python3
"""Allowlisted official & exchange primary sources. Fail closed; atomic writes; retain last-good data.
No API keys, trading endpoints, arbitrary URLs, or inferred capital-flow signals.
"""
import argparse, csv, hashlib, io, json, math, re, os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, date
from pathlib import Path
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'public' / 'data'


def us_yield_url(year=None):
 y = year or datetime.now(timezone.utc).year
 return (
  f'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
  f'daily-treasury-rates.csv/{y}/all?type=daily_treasury_yield_curve&field_tdr_date_value={y}&page&_format=csv'
 )


def ust_auctions_fiscal_url(year=None):
 start_year = (year or datetime.now(timezone.utc).year) - 3
 return (
  f'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?'
  f'fields=cusip,auction_date,issue_date,security_type,security_term,comp_accepted,'
  f'indirect_bidder_accepted,primary_dealer_accepted,fima_noncomp_accepted&'
  f'filter=auction_date:gte:{start_year}-08-01,security_type:in:(Note,Bond)&sort=auction_date&page[size]=1000'
 )


UST_AUCTIONS_RECENT_URL = 'https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&pagesize=60'


SOURCES = {
 'ecb_fx': {
  'url': 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
  'name': '欧洲中央银行参考汇率（90日序列）',
  'frequency': '工作日日频',
 },
 'us_treasury_yield': {
  'url': us_yield_url(),
  'name': '美国财政部每日国债收益率曲线',
  'frequency': '交易日日频',
 },
 'cn_gov_yield': {
  'url': 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/SddsIntrRateGovYldHis?lang=CN&pageNum=1&pageSize=60',
  'name': '中国外汇交易中心国债收益率（SDDS）',
  'frequency': '交易日日频',
 },
 'nyfed_sofr': {
  'url': 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/60.json',
  'name': '纽约联储隔夜担保融资利率（SOFR）',
  'frequency': '交易日日频',
 },
 'cboe_vix': {
  'url': 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv',
  'name': 'Cboe 标普500波动率指数（VIX）',
  'frequency': '交易日日频',
 },
 'tic_holdings': {
  'url': 'https://ticdata.treasury.gov/Publish/slt_table5.txt',
  'name': '美国财政部 TIC 表 5（美债存量）',
  'frequency': '月频，带发布滞后',
 },
 'tic_transactions': {
  'url': 'https://ticdata.treasury.gov/Publish/slt_table1.txt',
  'name': '美国财政部 TIC 表 1（跨境净买卖）',
  'frequency': '月频，带发布滞后',
 },
 'fed_h41_custody': {
  'url': 'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H41&series=7c037361d7d4efc82b17dcd09ff94755&lastobs=100&from=&to=&filetype=csv&label=include&layout=seriescolumn',
  'name': '美联储 H.4.1 周报（外国官方托管证券）',
  'frequency': '周频（滞后约 3 天）',
 },
 'ust_auctions': {
  'url': ust_auctions_fiscal_url(),
  'name': '美国财政部中长期国债拍卖（海外间接投标）',
  'frequency': '按场次实时更新（月均 8–9 场附息债）',
 },
}


def utcnow():
 return datetime.now(timezone.utc).isoformat(timespec='seconds')


def period_ok(s):
 if not re.fullmatch(r'\d{4}-\d{2}(?:-\d{2})?', s):
  raise ValueError('Invalid observation period')
 d = date.fromisoformat(s if len(s) == 10 else s + '-01')
 if d > datetime.now(timezone.utc).date():
  raise ValueError('Future observation period')
 return s


def us_date_to_iso(s):
 m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', str(s).strip())
 if not m:
  raise ValueError('Invalid MM/DD/YYYY date')
 mo, da, yr = m.groups()
 return period_ok(f'{yr}-{mo}-{da}')


def number(s):
 # Missing is never silently zero.
 n = float(str(s).replace(',', '').strip())
 if not math.isfinite(n):
  raise ValueError('Non-finite numeric input')
 return n


def synth_dxy(rates):
 req = ('USD', 'JPY', 'GBP', 'CAD', 'SEK', 'CHF')
 if not all(k in rates and rates[k] > 0 for k in req):
  return None
 eurusd = rates['USD']
 usdjpy = rates['JPY'] / eurusd
 gbpusd = eurusd / rates['GBP']
 usdcad = rates['CAD'] / eurusd
 usdsek = rates['SEK'] / eurusd
 usdchf = rates['CHF'] / eurusd
 idx = (
  50.14348112
  * (eurusd ** -0.576)
  * (usdjpy ** 0.136)
  * (gbpusd ** -0.119)
  * (usdcad ** 0.091)
  * (usdsek ** 0.042)
  * (usdchf ** 0.036)
 )
 return round(idx, 3) if 40 < idx < 220 else None


def parse_ecb(raw):
 xml = ET.fromstring(raw)
 rows = sorted([e for e in xml.iter() if 'time' in e.attrib], key=lambda x: x.attrib['time'])
 if not rows:
  raise ValueError('ECB dated cube missing')
 hist = []
 for e in rows:
  p = period_ok(e.attrib['time'])
  rates = {x.attrib['currency']: number(x.attrib['rate']) for x in e if 'currency' in x.attrib}
  if not all(k in rates for k in ('USD', 'CNY', 'HKD')):
   raise ValueError('ECB currencies missing')
  cny = rates['CNY'] / rates['USD']
  hkd = rates['HKD'] / rates['USD']
  if not 1 < cny < 30 or not 1 < hkd < 30:
   raise ValueError('FX range guard failed')
  item = {'period': p, 'usd_cny': round(cny, 6), 'usd_hkd': round(hkd, 6)}
  dxy = synth_dxy(rates)
  if dxy is not None:
   item['usd_index'] = dxy
  hist.append(item)
 latest = hist[-1]
 metrics = [
  {
   'id': 'usd_cny',
   'name': '美元 / 人民币参考汇率',
   'value': latest['usd_cny'],
   'unit': '人民币元/美元',
   'kind': '日频参考价',
   'note': '由同日欧元参考价交叉计算（CNY/EUR ÷ USD/EUR）；不是成交价或未来升值预期。',
  },
  {
   'id': 'usd_hkd',
   'name': '美元 / 港币参考汇率',
   'value': latest['usd_hkd'],
   'unit': '港元/美元',
   'kind': '日频参考价',
   'note': '由同日欧元参考价交叉计算；只作汇率环境观测，不代表跨境资金净流。',
  },
 ]
 if 'usd_index' in latest:
  metrics.append({
   'id': 'usd_index',
   'name': '美元对六大主要货币指数',
   'value': latest['usd_index'],
   'unit': '指数点',
   'kind': '日频合成参考',
   'note': '由欧央行同日欧/日/英/加/瑞/典六币参考价按经典几何权重合成，衡量美元广泛强弱。',
  })
 return {'period': latest['period'], 'metrics': metrics, 'history': hist[-60:]}


def parse_us_yield(raw):
 text = raw.decode('utf-8-sig')
 reader = csv.DictReader(io.StringIO(text))
 if not reader.fieldnames or '10 Yr' not in reader.fieldnames or 'Date' not in reader.fieldnames:
  raise ValueError('US Treasury yield CSV header changed')
 hist = []
 for r in reader:
  if not r.get('Date', '').strip():
   continue
  p = us_date_to_iso(r['Date'])
  y10 = number(r['10 Yr'])
  if not -2 <= y10 <= 25:
   raise ValueError('US 10Y yield range guard failed')
  item = {'period': p, 'y10': round(y10, 4)}
  for col, key in [('2 Yr', 'y2'), ('3 Mo', 'm3')]:
   if col in r and str(r[col]).strip():
    try:
     v = number(r[col])
     if -2 <= v <= 25:
      item[key] = round(v, 4)
    except ValueError:
     pass
  hist.append(item)
 if not hist:
  raise ValueError('US Treasury yield rows empty')
 hist.sort(key=lambda x: x['period'])
 seen = set()
 dedup = []
 for x in hist:
  if x['period'] not in seen:
   seen.add(x['period'])
   dedup.append(x)
 latest = dedup[-1]
 metrics = [
  {
   'id': 'us_10y',
   'name': '美国 10 年期国债收益率',
   'value': latest['y10'],
   'unit': '%',
   'kind': '日频到期收益率',
   'note': '美国财政部每日国债平价收益率曲线（CMT 10Y），衡量美元无风险久期定价锚。',
  }
 ]
 if 'y2' in latest:
  metrics.append({
   'id': 'us_2y',
   'name': '美国 2 年期国债收益率',
   'value': latest['y2'],
   'unit': '%',
   'kind': '日频到期收益率',
   'note': '美国财政部 CMT 2Y，反映联储政策利率路径预期。',
  })
 if 'm3' in latest:
  metrics.append({
   'id': 'us_3m',
   'name': '美国 3 个月国库券收益率',
   'value': latest['m3'],
   'unit': '%',
   'kind': '日频短端收益率',
   'note': '美国财政部 CMT 3M，反映美元短端无风险套息水平。',
  })
 return {'period': latest['period'], 'metrics': metrics, 'history': dedup[-60:]}


def parse_cn_yield(raw):
 obj = json.loads(raw.decode('utf-8-sig'))
 records = obj.get('records')
 if not isinstance(records, list) or not records:
  raise ValueError('CFETS SDDS government yield records missing')
 hist = []
 for r in records:
  ds = str(r.get('dateString') or '').strip()
  if not ds:
   continue
  p = period_ok(ds)
  y10 = number(r.get('tenRate'))
  if not -1 <= y10 <= 20:
   raise ValueError('CN 10Y yield range guard failed')
  item = {'period': p, 'y10': round(y10, 4)}
  if r.get('oneRate') not in (None, ''):
   y1 = number(r['oneRate'])
   if -1 <= y1 <= 20:
    item['y1'] = round(y1, 4)
  hist.append(item)
 if not hist:
  raise ValueError('CFETS yield history empty')
 hist.sort(key=lambda x: x['period'])
 latest = hist[-1]
 metrics = [
  {
   'id': 'cn_10y',
   'name': '中国 10 年期国债收益率',
   'value': latest['y10'],
   'unit': '%',
   'kind': '日频到期收益率',
   'note': '中国外汇交易中心（CFETS）SDDS 公布国债收益率，可与美债 10Y 构成双端名义利差对照。',
  }
 ]
 if 'y1' in latest:
  metrics.append({
   'id': 'cn_1y',
   'name': '中国 1 年期国债收益率',
   'value': latest['y1'],
   'unit': '%',
   'kind': '日频短端收益率',
   'note': '中国外汇交易中心 SDDS 1 年期国债收益率。',
  })
 return {'period': latest['period'], 'metrics': metrics, 'history': hist[-60:]}


def parse_sofr(raw):
 obj = json.loads(raw.decode('utf-8-sig'))
 rates = obj.get('refRates')
 if not isinstance(rates, list) or not rates:
  raise ValueError('NY Fed SOFR refRates missing')
 hist = []
 for r in rates:
  if r.get('type') != 'SOFR':
   continue
  p = period_ok(str(r.get('effectiveDate', '')).strip())
  rate = number(r.get('percentRate'))
  if not -2 <= rate <= 25:
   raise ValueError('SOFR range guard failed')
  item = {'period': p, 'sofr': round(rate, 4)}
  if r.get('volumeInBillions') not in (None, ''):
   vol = number(r['volumeInBillions']) * 10  # billion USD -> 亿美元
   if 0 < vol < 500_000:
    item['volume'] = round(vol, 1)
  hist.append(item)
 if not hist:
  raise ValueError('NY Fed SOFR rows empty')
 hist.sort(key=lambda x: x['period'])
 latest = hist[-1]
 metrics = [
  {
   'id': 'sofr',
   'name': '美元隔夜担保融资利率（SOFR）',
   'value': latest['sofr'],
   'unit': '%',
   'kind': '日频货币市场利率',
   'note': '纽约联储公布的美元隔夜回购基准利率，直接刻画“停留在美元现金池”的套息回报锚。',
  }
 ]
 if 'volume' in latest:
  metrics.append({
   'id': 'sofr_volume',
   'name': 'SOFR 隔夜回购成交量',
   'value': latest['volume'],
   'unit': '亿美元/日',
   'kind': '日频市场成交规模',
   'note': '美国隔夜国债回购成交额（非跨境净流），反映美元货币市场深度。',
  })
 return {'period': latest['period'], 'metrics': metrics, 'history': hist[-60:]}


def parse_vix(raw):
 text = raw.decode('utf-8-sig')
 reader = csv.DictReader(io.StringIO(text))
 if not reader.fieldnames or 'DATE' not in reader.fieldnames or 'CLOSE' not in reader.fieldnames:
  raise ValueError('Cboe VIX CSV header changed')
 rows = list(reader)
 if not rows:
  raise ValueError('Cboe VIX rows empty')
 hist = []
 for r in rows[-90:]:
  if not r.get('DATE', '').strip() or not r.get('CLOSE', '').strip():
   continue
  p = us_date_to_iso(r['DATE'])
  c = number(r['CLOSE'])
  if not 1 <= c <= 200:
   raise ValueError('VIX range guard failed')
  hist.append({'period': p, 'vix': round(c, 2)})
 if not hist:
  raise ValueError('Cboe VIX recent rows empty')
 hist.sort(key=lambda x: x['period'])
 latest = hist[-1]
 return {
  'period': latest['period'],
  'metrics': [{
   'id': 'vix',
   'name': '标普500隐含波动率（VIX）',
   'value': latest['vix'],
   'unit': '点',
   'kind': '日频风险情绪指标',
   'note': 'Cboe 官方收盘值；高于 25–30 往往对应美元流动性压力抬头与风险资产去杠杆。',
  }],
  'history': hist[-60:],
 }


def parse_holdings(raw):
 text = raw.decode('utf-8-sig')
 lines = text.splitlines()
 if 'Billions of dollars' not in text[:800] or 'Table 5' not in text[:150]:
  raise ValueError('TIC5 unit/schema changed')
 line = next((s for s in lines if s.startswith('Country\t')), None)
 if not line:
  raise ValueError('TIC5 header missing')
 periods = [period_ok(x) for x in line.split('\t')[1:] if x.strip()]
 if len(set(periods)) != len(periods):
  raise ValueError('Duplicate observation periods')
 data = {}
 for name in ['China, Mainland', 'Hong Kong']:
  row = next((s.split('\t') for s in lines if s.startswith(name + '\t')), None)
  if not row or len(row) < len(periods) + 1:
   raise ValueError('TIC5 country row missing')
  values = [number(x) * 10 for x in row[1:1 + len(periods)]]  # billion USD -> 亿美元
  if any(v < 0 or v > 2_000_000 for v in values):
   raise ValueError('TIC5 holdings range guard failed')
  data[name] = dict(zip(periods, values))
 for opt in ['Grand Total', 'Of Which: Foreign Official']:
  row = next((s.split('\t') for s in lines if s.startswith(opt + '\t')), None)
  if row and len(row) >= len(periods) + 1:
   try:
    vals = [number(x) * 10 for x in row[1:1 + len(periods)]]
    if all(0 <= v <= 2_000_000 for v in vals):
     data[opt] = dict(zip(periods, vals))
   except ValueError:
    pass
 latest = max(periods)
 metrics = []
 for name, id_, label in [
  ('China, Mainland', 'cn_treasury', '中国内地持有美国国债'),
  ('Hong Kong', 'hk_treasury', '中国香港持有美国国债'),
 ]:
  metrics.append({
   'id': id_,
   'name': label,
   'value': round(data[name][latest], 3),
   'unit': '亿美元',
   'kind': '月末持仓',
   'note': '月末存量，不是净交易；含托管地归属误差。持仓变化不能直接解释为卖出、回流或最终受益人转向。',
  })
 if 'Grand Total' in data:
  metrics.append({
   'id': 'world_treasury',
   'name': '外国投资者持有美国国债合计',
   'value': round(data['Grand Total'][latest], 3),
   'unit': '亿美元',
   'kind': '月末持仓',
   'note': 'TIC 表 5 Grand Total；包含外国官方储备与私人/托管机构。',
  })
 if 'Of Which: Foreign Official' in data:
  metrics.append({
   'id': 'official_treasury',
   'name': '其中：外国官方机构持有美债',
   'value': round(data['Of Which: Foreign Official'][latest], 3),
   'unit': '亿美元',
   'kind': '月末持仓',
   'note': '官方储备与主权机构口径；可与私人部门存量变化对照结构分化。',
  })
 hist = []
 for p in sorted(periods):
  item = {'period': p, 'cn': round(data['China, Mainland'][p], 3), 'hk': round(data['Hong Kong'][p], 3)}
  if 'Grand Total' in data:
   item['world'] = round(data['Grand Total'][p], 3)
  if 'Of Which: Foreign Official' in data:
   item['official'] = round(data['Of Which: Foreign Official'][p], 3)
   if 'Grand Total' in data:
    item['private'] = round(data['Grand Total'][p] - data['Of Which: Foreign Official'][p], 3)
  hist.append(item)
 return {'period': latest, 'metrics': metrics, 'history': hist}


def parse_transactions(raw):
 text = raw.decode('utf-8-sig')
 lines = text.splitlines()
 if 'Millions of dollars' not in text[:900] or 'Table 1' not in text[:150]:
  raise ValueError('TIC1 unit/schema changed')
 start = next((i for i, s in enumerate(lines) if s.startswith('country\tcountry_code\tdate\t')), None)
 if start is None:
  raise ValueError('TIC1 machine-readable header missing')
 rows = list(csv.DictReader(io.StringIO('\n'.join(lines[start:])), delimiter='\t'))
 groups = {}
 for key, code, label in [('world', '99996', '全球外国居民'), ('cn', '41408', '中国内地居民'), ('hk', '42005', '中国香港居民')]:
  rr = [r for r in rows if r.get('country_code', '').strip() == code and re.fullmatch(r'\d{4}-\d{2}', r.get('date', ''))]
  if key == 'world':
   rr = [r for r in rr if r.get('country', '').strip().lower() == 'grand total']
  if not rr:
   if key == 'world':
    raise ValueError('Explicit Grand Total absent')
   continue
  latest = max(r['date'] for r in rr)
  out = []

  def optional(r, k):
   try:
    return number(r[k]) / 100
   except (KeyError, ValueError):
    return None

  for r in sorted(rr, key=lambda r: r['date']):
   total = optional(r, 'for_lt_total_net')
   equity = optional(r, 'for_lt_eqty_net')
   if total is None or equity is None:
    if r['date'] == latest:
     raise ValueError('Latest TIC1 ' + key + ' net transaction missing')
    continue
   if abs(total) > 2_000_000 or abs(equity) > 2_000_000:
    raise ValueError('TIC1 range guard')
   x = {
    'period': period_ok(r['date']),
    'total': total,
    'equity': equity,
    'bond': total - equity,
    'treasury': optional(r, 'for_lt_treas_net'),
    'agency': optional(r, 'for_lt_agcy_net'),
    'corporate': optional(r, 'for_lt_corp_net'),
    'position': optional(r, 'for_lt_total_pos'),
    'valuation': optional(r, 'for_lt_total_valchg'),
    'intensity': None,
    'residual': None,
   }
   if out and x['position'] is not None and out[-1]['position'] is not None:
    prev = out[-1]
    y, mo = map(int, prev['period'].split('-'))
    expected = f'{y + (mo == 12):04d}-{mo % 12 + 1:02d}'
    if x['period'] == expected:
     den = (x['position'] + prev['position']) / 2
     x['intensity'] = total / den * 100 if den > 0 else None
     x['residual'] = x['position'] - prev['position'] - total - x['valuation'] if x['valuation'] is not None else None
   out.append(x)
  if out:
   groups[key] = {'name': label, 'country_code': code, 'history': out[-36:]}
 if 'world' not in groups:
  raise ValueError('TIC1 totals unavailable')
 latest = groups['world']['history'][-1]
 return {
  'period': latest['period'],
  'metrics': [
   {
    'id': 'us_lt_net',
    'name': '外国居民净买入美国长期证券',
    'value': latest['total'],
    'unit': '亿美元/月',
    'kind': '月度净交易',
    'note': 'TIC Grand Total；涵盖长期股票与债券，不是全部跨境资本。',
   },
   {
    'id': 'us_equity_net',
    'name': '外国居民净买入美国公司股票',
    'value': latest['equity'],
    'unit': '亿美元/月',
    'kind': '月度净交易',
    'note': '外国居民口径，不等于从中国资产迁出的同一笔资金。',
   },
  ],
  'history': groups['world']['history'],
  'regions': groups,
 }


def parse_fed_h41(raw):
 text = raw.decode('utf-8-sig')
 lines = text.splitlines()
 start = next((i for i, s in enumerate(lines) if s.startswith('"Time Period"') or s.startswith('Time Period,')), None)
 if start is None:
  raise ValueError('Fed H.4.1 Time Period header missing')
 reader = csv.DictReader(io.StringIO('\n'.join(lines[start:])))
 req_cols = ('Time Period', 'RESH4F_N.WW', 'RESH4FG_N.WW')
 if not reader.fieldnames or not all(c in reader.fieldnames for c in req_cols):
  raise ValueError('Fed H.4.1 required custody series missing')
 hist = []
 for r in reader:
  tp = (r.get('Time Period') or '').strip()
  v_tot = (r.get('RESH4F_N.WW') or '').strip()
  v_ust = (r.get('RESH4FG_N.WW') or '').strip()
  if not tp or v_tot in ('', 'ND', 'null') or v_ust in ('', 'ND', 'null'):
   continue
  p = period_ok(tp)
  tot = number(v_tot) / 100.0  # million USD -> 亿美元
  ust = number(v_ust) / 100.0
  if not (5_000 <= ust <= 200_000 and 5_000 <= tot <= 250_000):
   raise ValueError('Fed H.4.1 custody range guard failed')
  item = {'period': p, 'total': round(tot, 2), 'ust': round(ust, 2)}
  v_ag = (r.get('RESH4FA_N.WW') or '').strip()
  if v_ag not in ('', 'ND', 'null'):
   try:
    ag = number(v_ag) / 100.0
    if 0 <= ag <= 100_000:
     item['agency'] = round(ag, 2)
   except ValueError:
    pass
  hist.append(item)
 if not hist:
  raise ValueError('Fed H.4.1 custody rows empty')
 hist.sort(key=lambda x: x['period'])
 by_ym = {}
 for x in hist:
  by_ym[x['period'][:7]] = x
 yms = sorted(by_ym)
 monthly = []
 for i, ym in enumerate(yms):
  cur = by_ym[ym]
  d_ust = None
  if i > 0:
   py, pm = map(int, yms[i - 1].split('-'))
   ey, em = py + (pm == 12), pm % 12 + 1
   if ym == f'{ey:04d}-{em:02d}':
    d_ust = round(cur['ust'] - by_ym[yms[i - 1]]['ust'], 2)
  monthly.append({
   'period': ym,
   'through_date': cur['period'],
   'ust': cur['ust'],
   'total': cur['total'],
   'd_ust': d_ust,
  })
 latest = hist[-1]
 metrics = [
  {
   'id': 'h41_custody_ust',
   'name': '美联储托管外国官方美债',
   'value': latest['ust'],
   'unit': '亿美元',
   'kind': '周频官方托管存量',
   'note': '美联储 H.4.1 表 RESH4FG_N.WW（周三日终存量），滞后仅约 3 天，是 TIC 外国官方美债存量的核心高频同步锚。',
  },
  {
   'id': 'h41_custody_total',
   'name': '美联储托管外国官方证券合计',
   'value': latest['total'],
   'unit': '亿美元',
   'kind': '周频官方托管存量',
   'note': '涵盖外国央行及国际组织在纽约联储托管的可流通美债、机构债与 MBS。',
  },
 ]
 if len(hist) >= 5:
  metrics.append({
   'id': 'h41_custody_4w_chg',
   'name': '近 4 周官方托管美债变动',
   'value': round(latest['ust'] - hist[-5]['ust'], 2),
   'unit': '亿美元',
   'kind': '周频滚动变动',
   'note': '最新周三较 4 周前同口径存量差值；负值代表外国官方托管账户净减持或到期不续作。',
  })
 return {'period': latest['period'], 'metrics': metrics, 'history': hist[-60:], 'monthly': monthly}


def _opt_pos_num(val):
 if val in (None, '', 'null', 'None', 'ND'):
  return None
 return number(val)


def parse_ust_auctions(raw):
 obj = json.loads(raw.decode('utf-8-sig'))
 fd_rows = []
 td_rows = []
 if isinstance(obj, dict) and ('fiscaldata' in obj or 'treasurydirect' in obj):
  fd_obj = obj.get('fiscaldata') or {}
  fd_rows = fd_obj.get('data') or [] if isinstance(fd_obj, dict) else []
  td_rows = obj.get('treasurydirect') or []
 elif isinstance(obj, dict) and isinstance(obj.get('data'), list):
  fd_rows = obj['data']
 elif isinstance(obj, list):
  td_rows = obj
 else:
  raise ValueError('US Treasury auctions JSON schema unrecognized')

 today_iso = datetime.now(timezone.utc).date().isoformat()
 dedup = {}
 for r in fd_rows:
  st = str(r.get('security_type') or '').strip()
  if st not in ('Note', 'Bond'):
   continue
  ad = str(r.get('auction_date') or '').strip()[:10]
  if not ad or ad > today_iso:
   continue
  comp = _opt_pos_num(r.get('comp_accepted'))
  ind = _opt_pos_num(r.get('indirect_bidder_accepted'))
  pd = _opt_pos_num(r.get('primary_dealer_accepted'))
  if comp is None or ind is None or pd is None or comp <= 0:
   continue
  fima = _opt_pos_num(r.get('fima_noncomp_accepted')) or 0.0
  p = period_ok(ad)
  cusip = str(r.get('cusip') or '').strip()
  term = str(r.get('security_term') or '').strip()
  comp_yi, ind_yi, pd_yi, fima_yi = comp / 1e8, ind / 1e8, pd / 1e8, fima / 1e8
  if not (0 < comp_yi < 50_000 and 0 <= ind_yi <= comp_yi * 1.02 and 0 <= pd_yi <= comp_yi * 1.02):
   raise ValueError('FiscalData auction range guard failed')
  key = (cusip or f'{p}:{st}:{term}', p)
  dedup[key] = {
   'cusip': cusip,
   'auction_date': p,
   'security_type': st,
   'security_term': term,
   'comp_amt': comp_yi,
   'indirect_amt': ind_yi,
   'primary_dealer_amt': pd_yi,
   'fima_amt': fima_yi,
  }

 for r in td_rows:
  st = str(r.get('securityType') or '').strip()
  if st not in ('Note', 'Bond'):
   continue
  ad = str(r.get('competitiveAuctionCloseDate') or r.get('auctionDate') or '').strip()[:10]
  if not ad or ad > today_iso:
   continue
  comp = _opt_pos_num(r.get('subtotalCompetitiveParAwardedInsideOfOfferingAmount') or r.get('competitiveAccepted'))
  ind = _opt_pos_num(r.get('indirectBiddersCompetitiveParAwarded') or r.get('indirectBidderAccepted'))
  pd = _opt_pos_num(r.get('primaryDealersCompetitiveParAwarded') or r.get('primaryDealerAccepted'))
  if comp is None or ind is None or pd is None or comp <= 0:
   continue
  fima = _opt_pos_num(r.get('fimaNoncompetitiveParAwarded') or r.get('fimaNoncompetitiveAccepted')) or 0.0
  p = period_ok(ad)
  cusip = str(r.get('cusip') or '').strip()
  term = str(r.get('securityTerm') or '').strip()
  comp_yi, ind_yi, pd_yi, fima_yi = comp / 1e8, ind / 1e8, pd / 1e8, fima / 1e8
  if not (0 < comp_yi < 50_000 and 0 <= ind_yi <= comp_yi * 1.02 and 0 <= pd_yi <= comp_yi * 1.02):
   raise ValueError('TreasuryDirect auction range guard failed')
  key = (cusip or f'{p}:{st}:{term}', p)
  dedup[key] = {
   'cusip': cusip,
   'auction_date': p,
   'security_type': st,
   'security_term': term,
   'comp_amt': comp_yi,
   'indirect_amt': ind_yi,
   'primary_dealer_amt': pd_yi,
   'fima_amt': fima_yi,
  }

 if not dedup:
  raise ValueError('US Treasury coupon auction rows empty')

 auctions = sorted(dedup.values(), key=lambda x: (x['auction_date'], x['cusip']))
 by_ym = {}
 for a in auctions:
  ym = a['auction_date'][:7]
  b = by_ym.setdefault(ym, {
   'period': ym,
   'through_date': a['auction_date'],
   'auction_count': 0,
   'comp_amt': 0.0,
   'indirect_amt': 0.0,
   'primary_dealer_amt': 0.0,
   'fima_amt': 0.0,
  })
  if a['auction_date'] > b['through_date']:
   b['through_date'] = a['auction_date']
  b['auction_count'] += 1
  b['comp_amt'] += a['comp_amt']
  b['indirect_amt'] += a['indirect_amt']
  b['primary_dealer_amt'] += a['primary_dealer_amt']
  b['fima_amt'] += a['fima_amt']

 monthly = []
 for ym in sorted(by_ym):
  b = by_ym[ym]
  comp_amt = b['comp_amt']
  ind_sh = b['indirect_amt'] / comp_amt * 100.0 if comp_amt > 0 else 0.0
  pd_sh = b['primary_dealer_amt'] / comp_amt * 100.0 if comp_amt > 0 else 0.0
  monthly.append({
   'period': ym,
   'through_date': b['through_date'],
   'auction_count': b['auction_count'],
   'comp_amt': round(comp_amt, 2),
   'indirect_amt': round(b['indirect_amt'], 2),
   'primary_dealer_amt': round(b['primary_dealer_amt'], 2),
   'fima_amt': round(b['fima_amt'], 2),
   'indirect_share': round(ind_sh, 2),
   'primary_dealer_share': round(pd_sh, 2),
  })

 latest_m = monthly[-1]
 latest_date = auctions[-1]['auction_date']
 tag = '（月初至今）' if latest_m['auction_count'] < 7 else ''
 metrics = [
  {
   'id': 'ust_indirect_share',
   'name': f'美债附息拍卖海外间接获配占比{tag}',
   'value': latest_m['indirect_share'],
   'unit': '%',
   'kind': '一级市场外资需求指标',
   'note': '美国财政部中长期附息国债（Note & Bond）拍卖中 Indirect Bidders 获配占比；外国央行与海外机构主要经此通道认购。',
  },
  {
   'id': 'ust_indirect_amt',
   'name': f'美债附息拍卖海外间接获配额{tag}',
   'value': latest_m['indirect_amt'],
   'unit': '亿美元',
   'kind': '一级市场获配规模',
   'note': f"{latest_m['period']} 已完成 {latest_m['auction_count']} 场附息国债拍卖累计获配额（截至 {latest_date}）。",
  },
  {
   'id': 'ust_pd_share',
   'name': f'美债拍卖一级交易商兜底占比{tag}',
   'value': latest_m['primary_dealer_share'],
   'unit': '%',
   'kind': '一级市场承接压力指标',
   'note': 'Primary Dealers 被动承接比例越高，通常意味着海外与终端买盘认购意愿越弱。',
  },
 ]
 recent = [
  {
   'auction_date': a['auction_date'],
   'security_type': a['security_type'],
   'security_term': a['security_term'],
   'comp_amt': round(a['comp_amt'], 2),
   'indirect_amt': round(a['indirect_amt'], 2),
   'indirect_share': round(a['indirect_amt'] / a['comp_amt'] * 100.0, 2),
   'primary_dealer_share': round(a['primary_dealer_amt'] / a['comp_amt'] * 100.0, 2),
  }
  for a in auctions[-15:]
 ]
 return {'period': latest_date, 'metrics': metrics, 'history': monthly[-38:], 'recent_auctions': recent}


def _solve_linear(A, b):
 n = len(b)
 M = [list(map(float, A[i])) + [float(b[i])] for i in range(n)]
 for col in range(n):
  piv = max(range(col, n), key=lambda r: abs(M[r][col]))
  if abs(M[piv][col]) < 1e-12:
   return [0.0] * n
  M[col], M[piv] = M[piv], M[col]
  div = M[col][col]
  for j in range(col, n + 1):
   M[col][j] /= div
  for r in range(n):
   if r != col and M[r][col] != 0.0:
    fac = M[r][col]
    for j in range(col, n + 1):
     M[r][j] -= fac * M[col][j]
 return [M[i][n] for i in range(n)]


def _fit_nonneg_ridge(X, y, lam=8.0):
 n = len(y)
 p = len(X[0])
 y_mean = sum(y) / n
 means = [sum(X[i][j] for i in range(n)) / n for j in range(p)]
 stds = []
 for j in range(p):
  var = sum((X[i][j] - means[j]) ** 2 for i in range(n)) / max(1, n)
  stds.append(math.sqrt(var) if var > 1e-9 else 1.0)
 Z = [[(X[i][j] - means[j]) / stds[j] for j in range(p)] for i in range(n)]
 yc = [y[i] - y_mean for i in range(n)]

 active = list(range(p))
 w = [0.0] * p
 for _ in range(p + 1):
  if not active:
   w = [0.0] * p
   break
  k = len(active)
  A = [[0.0] * k for _ in range(k)]
  rhs = [0.0] * k
  for a_idx, ja in enumerate(active):
   rhs[a_idx] = sum(Z[i][ja] * yc[i] for i in range(n))
   for b_idx, jb in enumerate(active):
    A[a_idx][b_idx] = sum(Z[i][ja] * Z[i][jb] for i in range(n)) + (lam if a_idx == b_idx else 0.0)
  sol = _solve_linear(A, rhs)
  w = [0.0] * p
  neg_found = False
  for a_idx, ja in enumerate(active):
   if sol[a_idx] < 0.0:
    neg_found = True
   else:
    w[ja] = sol[a_idx]
  if not neg_found:
   break
  active = [j for j in active if w[j] > 0.0]
 return {'y_mean': y_mean, 'means': means, 'stds': stds, 'weights': w}


def _predict_nonneg_ridge(model, x):
 z = [(x[j] - model['means'][j]) / model['stds'][j] for j in range(len(x))]
 return model['y_mean'] + sum(model['weights'][j] * z[j] for j in range(len(x)))


def compute_nowcast(sources):
 tic_tx = sources.get('tic_transactions') or {}
 tic_hold = sources.get('tic_holdings') or {}
 h41 = sources.get('fed_h41_custody') or {}
 auc = sources.get('ust_auctions') or {}
 vix_src = sources.get('cboe_vix') or {}

 tx_hist = tic_tx.get('history') or []
 hold_hist = tic_hold.get('history') or []
 h41_monthly = h41.get('monthly') or []
 auc_monthly = auc.get('history') or []

 if len(tx_hist) < 6 or not hold_hist or (not h41_monthly and not auc_monthly):
  return {'status': 'unavailable', 'months': []}

 anchor_period = tx_hist[-1]['period']
 h41_by_ym = {r['period']: r for r in h41_monthly}
 auc_by_ym = {r['period']: r for r in auc_monthly}
 hold_by_ym = {r['period']: r for r in hold_hist if r.get('official') is not None}

 vix_by_ym = {}
 for r in (vix_src.get('history') or []):
  ym = r['period'][:7]
  vix_by_ym.setdefault(ym, []).append(r['vix'])
 vix_month_avg = {ym: sum(vs) / len(vs) for ym, vs in vix_by_ym.items() if vs}

 target_yms = sorted({
  ym for ym in (set(h41_by_ym) | set(auc_by_ym))
  if ym > anchor_period
 })
 if not target_yms:
  return {
   'status': 'up_to_date',
   'anchor_period': anchor_period,
   'months': [],
  }

 # 1) Official US Treasury Holdings Bridge: d(TIC_Official) = alpha + beta * d(H41_UST)
 hold_yms = sorted(hold_by_ym)
 off_pairs = []
 for i in range(1, len(hold_yms)):
  ym, pym = hold_yms[i], hold_yms[i - 1]
  if ym > anchor_period:
   continue
  py, pm = map(int, pym.split('-'))
  if ym != f'{py + (pm == 12):04d}-{pm % 12 + 1:02d}':
   continue
  h_rec = h41_by_ym.get(ym)
  if h_rec and h_rec.get('d_ust') is not None:
   dy = hold_by_ym[ym]['official'] - hold_by_ym[pym]['official']
   off_pairs.append((ym, h_rec['d_ust'], dy))

 def _fit_off(pairs):
  if len(pairs) < 4:
   return 0.0, 0.80
  mx = sum(p[1] for p in pairs) / len(pairs)
  my = sum(p[2] for p in pairs) / len(pairs)
  vx = sum((p[1] - mx) ** 2 for p in pairs)
  cov = sum((p[1] - mx) * (p[2] - my) for p in pairs)
  beta_raw = cov / vx if vx > 1e-6 else 0.80
  beta = max(0.55, min(1.35, beta_raw))
  alpha = 0.5 * (my - beta * mx)
  return alpha, beta

 off_alpha, off_beta = _fit_off(off_pairs)
 if len(off_pairs) >= 5:
  loo_errs_off = []
  for i in range(len(off_pairs)):
   sub = off_pairs[:i] + off_pairs[i + 1:]
   a_i, b_i = _fit_off(sub)
   pred_i = a_i + b_i * off_pairs[i][1]
   loo_errs_off.append(off_pairs[i][2] - pred_i)
  off_rmse = math.sqrt(sum(e * e for e in loo_errs_off) / len(loo_errs_off))
 else:
  off_rmse = 415.0

 # 2) Global Foreign Net Long-Term Securities Bridge (Bond + Equity = Total)
 full_aucs = [r['comp_amt'] for r in auc_monthly if r['auction_count'] >= 7 and r['period'] <= anchor_period]
 mean_full_comp = sum(full_aucs) / len(full_aucs) if full_aucs else 3100.0

 def _auc_features(a_rec):
  equiv_ind = a_rec['indirect_amt'] * (mean_full_comp / a_rec['comp_amt']) if a_rec['comp_amt'] > 0 else a_rec['indirect_amt']
  return [
   a_rec['indirect_share'],
   -a_rec['primary_dealer_share'],
   equiv_ind,
  ]

 flow_samples = []
 for idx, tx in enumerate(tx_hist):
  ym = tx['period']
  a_rec = auc_by_ym.get(ym)
  if not a_rec:
   continue
  prev_eq = [tx_hist[j]['equity'] for j in range(max(0, idx - 6), idx)]
  prev_eq24 = [tx_hist[j]['equity'] for j in range(max(0, idx - 24), idx)]
  eq_base = (
   0.55 * (sum(prev_eq) / len(prev_eq)) + 0.45 * (sum(prev_eq24) / len(prev_eq24))
   if prev_eq else tx['equity']
  )
  h_d = h41_by_ym[ym]['d_ust'] if ym in h41_by_ym and h41_by_ym[ym].get('d_ust') is not None else None
  flow_samples.append({
   'period': ym,
   'x': _auc_features(a_rec),
   'h41_d': h_d,
   'bond': tx['bond'],
   'equity': tx['equity'],
   'eq_base': eq_base,
   'total': tx['total'],
  })

 gamma_h41 = 0.35

 def _fit_bond(samples):
  X = [s['x'] for s in samples]
  h_vals = [s['h41_d'] for s in samples if s['h41_d'] is not None]
  h_mean = sum(h_vals) / len(h_vals) if h_vals else 0.0
  y_adj = [
   s['bond'] - (gamma_h41 * (s['h41_d'] - h_mean) if s['h41_d'] is not None else 0.0)
   for s in samples
  ]
  ridge = _fit_nonneg_ridge(X, y_adj, lam=8.0)
  return ridge, h_mean

 def _pred_bond(ridge, h_mean, x_vec, h_d):
  base = _predict_nonneg_ridge(ridge, x_vec)
  if h_d is not None:
   base += gamma_h41 * (h_d - h_mean)
  return base

 if len(flow_samples) >= 6:
  bond_ridge, h41_mean_d = _fit_bond(flow_samples)
  bond_loo_errs = []
  total_loo_errs = []
  for i in range(len(flow_samples)):
   sub = flow_samples[:i] + flow_samples[i + 1:]
   r_i, hm_i = _fit_bond(sub)
   s_i = flow_samples[i]
   b_hat = _pred_bond(r_i, hm_i, s_i['x'], s_i['h41_d'])
   bond_loo_errs.append(s_i['bond'] - b_hat)
   if i >= 3:
    total_loo_errs.append(s_i['total'] - (b_hat + s_i['eq_base']))
  bond_rmse = math.sqrt(sum(e * e for e in bond_loo_errs) / len(bond_loo_errs))
  total_rmse = (
   math.sqrt(sum(e * e for e in total_loo_errs) / len(total_loo_errs))
   if total_loo_errs else bond_rmse * 1.25
  )
 else:
  bond_ridge, h41_mean_d = None, 0.0
  bond_rmse, total_rmse = 520.0, 680.0

 eq_tail6 = [r['equity'] for r in tx_hist[-6:]]
 eq_tail24 = [r['equity'] for r in tx_hist[-24:]]
 eq_anchor = 0.55 * (sum(eq_tail6) / len(eq_tail6)) + 0.45 * (sum(eq_tail24) / len(eq_tail24))
 mean_bond_hist = sum(r['bond'] for r in tx_hist[-12:]) / min(12, len(tx_hist))

 anchor_off = hold_by_ym.get(anchor_period, {}).get('official')
 if anchor_off is None and hold_hist:
  anchor_off = hold_hist[-1].get('official')
 running_off = anchor_off

 z80 = 1.28155
 months_out = []
 for step_idx, ym in enumerate(target_yms, start=1):
  a_rec = auc_by_ym.get(ym)
  h_rec = h41_by_ym.get(ym)
  is_partial_auc = bool(a_rec and a_rec['auction_count'] < 7) or (a_rec is None)
  is_partial_h41 = bool(h_rec and int(h_rec['through_date'].split('-')[2]) < 24)
  is_partial = is_partial_auc or is_partial_h41

  h_d = h_rec['d_ust'] if h_rec and h_rec.get('d_ust') is not None else None
  if a_rec and bond_ridge is not None:
   bond_est = _pred_bond(bond_ridge, h41_mean_d, _auc_features(a_rec), h_d)
  elif h_d is not None:
   bond_est = mean_bond_hist + gamma_h41 * (h_d - h41_mean_d)
  else:
   bond_est = mean_bond_hist

  vix_m = vix_month_avg.get(ym)
  vix_drag = -12.0 * max(0.0, vix_m - 20.0) if vix_m is not None else 0.0
  eq_est = eq_anchor + vix_drag
  tot_est = bond_est + eq_est

  mult = 1.18 if is_partial_auc else 1.0
  bond_half80 = z80 * bond_rmse * mult
  tot_half80 = z80 * total_rmse * mult

  off_est, off_low80, off_high80, off_chg = None, None, None, None
  if running_off is not None and h_d is not None:
   off_chg = off_alpha + off_beta * h_d
   running_off = running_off + off_chg
   off_half80 = z80 * math.sqrt(step_idx) * off_rmse * (1.10 if is_partial_h41 else 1.0)
   off_est = round(running_off, 1)
   off_low80 = round(running_off - off_half80, 1)
   off_high80 = round(running_off + off_half80, 1)
   off_chg = round(off_chg, 1)

  through_candidates = [d for d in [
   a_rec['through_date'] if a_rec else None,
   h_rec['through_date'] if h_rec else None,
  ] if d]
  through_date = max(through_candidates) if through_candidates else ym

  months_out.append({
   'period': ym,
   'label': f'{ym} 月初至今估算' if is_partial else f'{ym} 高频估算',
   'through_date': through_date,
   'is_partial_month': is_partial,
   'auction_count': a_rec['auction_count'] if a_rec else 0,
   'comp_amt': a_rec['comp_amt'] if a_rec else None,
   'indirect_amt': a_rec['indirect_amt'] if a_rec else None,
   'indirect_share': a_rec['indirect_share'] if a_rec else None,
   'primary_dealer_share': a_rec['primary_dealer_share'] if a_rec else None,
   'h41_through_date': h_rec['through_date'] if h_rec else None,
   'h41_custody_ust': h_rec['ust'] if h_rec else None,
   'h41_d_ust': h_d,
   'bond': round(bond_est, 1),
   'bond_low80': round(bond_est - bond_half80, 1),
   'bond_high80': round(bond_est + bond_half80, 1),
   'equity': round(eq_est, 1),
   'total': round(tot_est, 1),
   'total_low80': round(tot_est - tot_half80, 1),
   'total_high80': round(tot_est + tot_half80, 1),
   'official_holdings': off_est,
   'official_low80': off_low80,
   'official_high80': off_high80,
   'official_chg': off_chg,
  })

 return {
  'status': 'ok',
  'anchor_period': anchor_period,
  'latest_h41_date': h41.get('period'),
  'latest_auction_date': auc.get('period'),
  'next_tic_release_hint': '美国财政部通常于每月月中（约第 15–18 日）发布滞后两个月的 TIC 正式月报；新月报落地后，本估算窗口自动向后顺延。',
  'country_boundary_note': '美联储 H.4.1 周报与美国财政部国债拍卖仅披露全球外国投资者合计口径，不公布分国别明细；因此不伪造中国内地或香港 9—11 月单月净买卖点估计，仅在总量与官方存量序列上展示虚线估算区间。',
  'methodology': (
   '双支柱官方高频桥接（Bridge Nowcast）：① 以美联储 H.4.1 外国官方托管可流通美债月度变动桥接 TIC 表 5 外国官方美债存量；'
   '② 以美国财政部附息国债（Note/Bond）拍卖海外间接投标占比、一级交易商兜底占比及全月等效获配额（施加经济符号单调非负岭回归约束），'
   '叠加 H.4.1 官方托管冲量估算外资净买美债，再结合近 6/24 个月美股净流入收缩均值与 VIX 风险折价合成跨境长期证券净买入，并由历史留一法交叉验证（LOOCV）给出 80% 预测区间。'
  ),
  'validation': {
   'ci_level': 0.80,
   'official_holdings_loocv_rmse': round(off_rmse, 1),
   'official_beta_h41': round(off_beta, 3),
   'official_overlap_months': len(off_pairs),
   'bond_flow_loocv_rmse': round(bond_rmse, 1),
   'total_flow_loocv_rmse': round(total_rmse, 1),
   'flow_overlap_months': len(flow_samples),
  },
  'months': months_out,
 }


PARSERS = {
 'ecb_fx': parse_ecb,
 'us_treasury_yield': parse_us_yield,
 'cn_gov_yield': parse_cn_yield,
 'nyfed_sofr': parse_sofr,
 'cboe_vix': parse_vix,
 'tic_holdings': parse_holdings,
 'tic_transactions': parse_transactions,
 'fed_h41_custody': parse_fed_h41,
 'ust_auctions': parse_ust_auctions,
}


def fetch_raw_url(url):
 req = Request(
  url,
  headers={
   'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) CapitalFlowLab/2.3',
   'Accept': 'application/json, text/csv, text/plain, application/xml, text/xml, */*',
  },
 )
 with urlopen(req, timeout=25) as r:
  raw = r.read(6_000_001)
  if len(raw) > 6_000_000:
   raise ValueError('Source too large; parser review required')
  src_host = url.split('/')[2]
  allowed = {src_host}
  if src_host == 'cdn.cboe.com':
   allowed.add('cdn-api.cboe.com')
  if r.url.split('/')[2] not in allowed:
   raise ValueError('Unexpected redirect host')
  return raw


def fetch_one(key, previous=None, fixture_dir=None):
 spec = dict(SOURCES[key])
 if key == 'us_treasury_yield':
  spec['url'] = us_yield_url()
 elif key == 'ust_auctions':
  spec['url'] = ust_auctions_fiscal_url()
 attempt = utcnow()
 result = {**(previous or {}), **spec, 'id': key, 'last_attempt_at': attempt}
 try:
  if fixture_dir:
   names = {
    'ecb_fx': 'ecb.raw',
    'us_treasury_yield': 'us_yield.raw',
    'cn_gov_yield': 'cn_yield.raw',
    'nyfed_sofr': 'sofr.raw',
    'cboe_vix': 'vix.raw',
    'tic_holdings': 'tic.raw',
    'tic_transactions': 'tic_transactions.raw',
    'fed_h41_custody': 'fed_h41.raw',
    'ust_auctions': 'ust_auctions.raw',
   }
   raw = (Path(fixture_dir) / names[key]).read_bytes()
   parsed = PARSERS[key](raw)
  elif key == 'us_treasury_yield':
   yr = datetime.now(timezone.utc).year
   try:
    raw = fetch_raw_url(us_yield_url(yr))
    parsed = PARSERS[key](raw)
   except Exception:
    raw = fetch_raw_url(us_yield_url(yr - 1))
    parsed = PARSERS[key](raw)
    spec['url'] = us_yield_url(yr - 1)
    result['url'] = spec['url']
  elif key == 'ust_auctions':
   raw_fd = fetch_raw_url(ust_auctions_fiscal_url())
   raw_td = fetch_raw_url(UST_AUCTIONS_RECENT_URL)
   raw = json.dumps({
    'fiscaldata': json.loads(raw_fd.decode('utf-8-sig')),
    'treasurydirect': json.loads(raw_td.decode('utf-8-sig')),
   }, separators=(',', ':')).encode('utf-8')
   parsed = PARSERS[key](raw)
  else:
   raw = fetch_raw_url(spec['url'])
   parsed = PARSERS[key](raw)
  if previous and previous.get('period') and parsed['period'] < previous['period']:
   raise ValueError('Source observation period went backwards')
  result.update(parsed)
  result.update({
   'status': 'ok',
   'last_success_at': attempt,
   'sha256': hashlib.sha256(raw).hexdigest(),
   'error': None,
   'fixture': bool(fixture_dir),
  })
 except Exception as ex:
  result.update({
   'status': 'stale' if previous and previous.get('metrics') else 'unavailable',
   'error': str(ex)[:240],
  })
  result.setdefault('metrics', [])
  result.setdefault('history', [])
 return result


def atomic_json(path, obj):
 path.parent.mkdir(parents=True, exist_ok=True)
 tmp = path.with_suffix('.json.tmp')
 tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
 os.replace(tmp, path)


def update(fixture_dir=None):
 DATA.mkdir(parents=True, exist_ok=True)
 import fcntl
 with (ROOT / '.update.lock').open('w') as lock:
  fcntl.flock(lock, fcntl.LOCK_EX)
  dest = DATA / 'observations.json'
  try:
   previous = json.loads(dest.read_text())
  except (OSError, ValueError):
   previous = {}
  sources = previous.get('sources', {})
  with ThreadPoolExecutor(max_workers=5) as ex:
   jobs = {k: ex.submit(fetch_one, k, sources.get(k), fixture_dir) for k in SOURCES}
   current = {k: j.result() for k, j in jobs.items()}
  nowcast = compute_nowcast(current)
  out = {
   'schema_version': 1,
   'generated_at': utcnow(),
   'site_version': '2.3.0',
   'observation_policy': 'Daily market rates/prices, monthly TIC realizations, and high-frequency bridge nowcasts (80% prediction intervals) are strictly separated and labeled.',
   'sources': current,
   'nowcast': nowcast,
  }
  atomic_json(dest, out)
  return out


if __name__ == '__main__':
 ap = argparse.ArgumentParser()
 ap.add_argument('--fixtures', help='Test ONLY: directory of archived raw inputs')
 args = ap.parse_args()
 d = update(args.fixtures)
 print(json.dumps({
  k: {'status': v['status'], 'period': v.get('period'), 'metrics': len(v['metrics']), 'error': v.get('error')}
  for k, v in d['sources'].items()
 }, ensure_ascii=False, indent=2))
 raise SystemExit(0 if all(s['status'] == 'ok' for s in d['sources'].values()) else 2)
