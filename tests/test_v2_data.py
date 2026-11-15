import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from update_data import (
 parse_transactions,
 parse_holdings,
 parse_ecb,
 parse_us_yield,
 parse_cn_yield,
 parse_sofr,
 parse_vix,
)

class ExpandedDataTests(unittest.TestCase):
 def raw(self,latest='20'):
  return ('Table 1\nMillions of dollars\ncountry\tcountry_code\tdate\tfor_lt_total_net\tfor_lt_eqty_net\tfor_lt_total_pos\tfor_lt_total_valchg\n'
   'Grand Total\t99996\t2026-07\t10\t3\t1000\t5\n'
   f'Grand Total\t99996\t2026-08\t{latest}\t7\t1100\t50\n'
   'China, Mainland\t41408\t2026-08\t-50\t10\t200\t20\n'
   'Hong Kong\t42005\t2026-08\t70\t20\t300\t30\n').encode()
 def test_resident_split_and_bond_remainder(self):
  d=parse_transactions(self.raw())
  self.assertEqual(d['regions']['cn']['history'][-1]['total'],-.5)
  self.assertEqual(d['regions']['hk']['history'][-1]['equity'],.2)
  self.assertAlmostEqual(d['regions']['world']['history'][-1]['bond'],.13)
 def test_intensity_and_adjustment_not_silently_zero(self):
  r=parse_transactions(self.raw())['history'][-1]
  self.assertAlmostEqual(r['intensity'],.2/10.5*100)
  self.assertAlmostEqual(r['residual'],.3)
  self.assertIsNone(r['treasury'])
 def test_latest_missing_not_backdated_success(self):
  with self.assertRaises(ValueError):parse_transactions(self.raw('n.a.'))
 def test_holdings_official_vs_private_decomposition(self):
  raw=(b'Table 5\nBillions of dollars\nCountry\t2026-08\t2026-07\n'
       b'China, Mainland\t590.7\t618.0\nHong Kong\t261.5\t258.3\n'
       b'Grand Total\t9331.7\t9248.4\nOf Which: Foreign Official\t3755.6\t3773.1\n')
  d=parse_holdings(raw)
  self.assertEqual(len(d['metrics']),4)
  self.assertAlmostEqual(d['history'][-1]['official'],37556.0)
  self.assertAlmostEqual(d['history'][-1]['private'],93317.0-37556.0)
 def test_daily_yields_sofr_vix_and_ecb_history(self):
  us=parse_us_yield(b'Date,"3 Mo","2 Yr","10 Yr"\n11/12/2026,4.30,4.85,5.12\n11/13/2026,4.32,4.88,5.15\n')
  self.assertEqual(us['period'],'2026-11-13')
  self.assertEqual(us['metrics'][0]['value'],5.15)
  cn=parse_cn_yield(b'{"records":[{"dateString":"2026-11-12","oneRate":"1.18","tenRate":"1.60"},{"dateString":"2026-11-13","oneRate":"1.1766","tenRate":"1.5922"}]}')
  self.assertEqual(cn['period'],'2026-11-13')
  self.assertEqual(cn['metrics'][0]['value'],1.5922)
  sofr=parse_sofr(b'{"refRates":[{"effectiveDate":"2026-11-12","type":"SOFR","percentRate":3.90,"volumeInBillions":3138}]}')
  self.assertEqual(sofr['metrics'][0]['value'],3.90)
  self.assertEqual(sofr['metrics'][1]['value'],31380.0)
  vix=parse_vix(b'DATE,OPEN,HIGH,LOW,CLOSE\n11/12/2026,18.3,19.3,17.3,18.70\n11/13/2026,18.8,20.9,17.6,19.30\n')
  self.assertEqual(vix['metrics'][0]['value'],19.3)
  ecb=parse_ecb(b'<Envelope><Cube><Cube time="2026-11-13"><Cube currency="USD" rate="1.1052"/><Cube currency="JPY" rate="176.83"/><Cube currency="GBP" rate="0.83559"/><Cube currency="CAD" rate="1.5758"/><Cube currency="SEK" rate="11.1075"/><Cube currency="CHF" rate="0.9266"/><Cube currency="CNY" rate="7.3738"/><Cube currency="HKD" rate="8.6714"/></Cube></Cube></Envelope>')
  self.assertEqual(len(ecb['metrics']),3)
  self.assertTrue(90<ecb['metrics'][2]['value']<120)
