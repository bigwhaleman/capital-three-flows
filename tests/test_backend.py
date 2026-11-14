import sys,unittest,io,tempfile,json
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import update_data as u

class ParserTests(unittest.TestCase):
 def test_ecb_cross_rate(self):
  raw=b'<Envelope><Cube><Cube time="2026-01-01"><Cube currency="USD" rate="1.2"/><Cube currency="CNY" rate="8.4"/><Cube currency="HKD" rate="9.36"/></Cube></Cube></Envelope>'
  d=u.parse_ecb(raw);self.assertEqual(d['metrics'][0]['value'],7);self.assertEqual(d['metrics'][1]['value'],7.8)
 def test_missing_currency_fails_closed(self):
  with self.assertRaises(ValueError):u.parse_ecb(b'<x><Cube time="2026-01-01"><Cube currency="USD" rate="1"/></Cube></x>')
 def test_holdings_units_and_dates(self):
  d=u.parse_holdings(b'Table 5\nBillions of dollars\nCountry\t2026-08\t2026-07\nChina, Mainland\t590.7\t618.0\nHong Kong\t261.5\t258.3\n')
  self.assertEqual(d['metrics'][0]['value'],5907);self.assertEqual(d['history'][0]['period'],'2026-07')
 def test_grand_total_not_all_countries(self):
  raw=b'Table 1\nMillions of dollars\ncountry\tcountry_code\tdate\tfor_lt_total_net\tfor_lt_eqty_net\nAll Countries\t69995\t2026-08\t297441\t153944\nGrand Total\t99996\t2026-08\t300724\t153942\n'
  d=u.parse_transactions(raw);self.assertEqual(d['metrics'][0]['value'],3007.24);self.assertEqual(d['metrics'][1]['value'],1539.42)
 def test_aggregate_missing_is_not_zero(self):
  with self.assertRaises(ValueError):u.parse_transactions(b'Table 1\nMillions of dollars\ncountry\tcountry_code\tdate\tfor_lt_total_net\tfor_lt_eqty_net\nGrand Total\t99996\t2026-08\tn.a.\t1')
 def test_failure_keeps_prior_success_date_and_values(self):
  old={'period':'2026-08','last_success_at':'2026-10-01T00:00:00+00:00','metrics':[{'id':'x','value':10}],'history':[],'sha256':'abc'}
  with patch.object(u,'urlopen',side_effect=OSError('offline')):d=u.fetch_one('tic_holdings',old)
  self.assertEqual(d['status'],'stale');self.assertEqual(d['metrics'],old['metrics']);self.assertEqual(d['last_success_at'],old['last_success_at']);self.assertEqual(d['period'],'2026-08')
 def test_first_failure_unavailable_not_fabricated(self):
  with patch.object(u,'urlopen',side_effect=OSError('offline')):d=u.fetch_one('ecb_fx')
  self.assertEqual(d['status'],'unavailable');self.assertEqual(d['metrics'],[])
 def test_nonfinite_invalid_and_future(self):
  for v in ['nan','inf','n.a.']:
   with self.assertRaises(ValueError):u.number(v)
  with self.assertRaises(ValueError):u.period_ok('2099-01')
 def test_atomic_json(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'data.json';u.atomic_json(p,{'a':1});self.assertEqual(json.loads(p.read_text()),{'a':1});self.assertFalse(p.with_suffix('.json.tmp').exists())

if __name__=='__main__':unittest.main()
