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


PARSERS = {
 'ecb_fx': parse_ecb,
 'us_treasury_yield': parse_us_yield,
 'cn_gov_yield': parse_cn_yield,
 'nyfed_sofr': parse_sofr,
 'cboe_vix': parse_vix,
 'tic_holdings': parse_holdings,
 'tic_transactions': parse_transactions,
}


def fetch_raw_url(url):
 req = Request(
  url,
  headers={
   'User-Agent': 'CapitalFlowLab/2.2 public-research; stdlib HTTP',
   'Accept': 'application/json, text/csv, text/plain, application/xml, text/xml, */*',
  },
 )
 with urlopen(req, timeout=25) as r:
  raw = r.read(4_000_001)
  if len(raw) > 4_000_000:
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
  with ThreadPoolExecutor(max_workers=4) as ex:
   jobs = {k: ex.submit(fetch_one, k, sources.get(k), fixture_dir) for k in SOURCES}
   current = {k: j.result() for k, j in jobs.items()}
  out = {
   'schema_version': 1,
   'generated_at': utcnow(),
   'site_version': '2.2.0',
   'observation_policy': 'Daily market rates/prices and monthly cross-border transactions are strictly separated. No flow is fabricated from price or holdings changes.',
   'sources': current,
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
