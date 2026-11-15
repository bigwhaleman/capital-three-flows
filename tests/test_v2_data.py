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
 parse_fed_h41,
 parse_ust_auctions,
 compute_nowcast,
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

 def test_fed_h41_parser_and_monthly_custody_delta(self):
  csv_raw=(
   '"Series Description","Total","UST","Agency"\n'
   '"Unit:","Currency","Currency","Currency"\n'
   '"Time Period","RESH4F_N.WW","RESH4FG_N.WW","RESH4FA_N.WW"\n'
   '2026-08-26,2880000,2615200,200000\n'
   '2026-09-30,2850000,2582350,198000\n'
   '2026-10-07,2845000,2579000,197500\n'
   '2026-10-28,2838071,2568597,196672\n'
   '2026-11-11,2793613,2524189,196672\n'
  ).encode('utf-8')
  d=parse_fed_h41(csv_raw)
  self.assertEqual(d['period'],'2026-11-11')
  self.assertEqual(len(d['metrics']),3)
  self.assertAlmostEqual(d['metrics'][0]['value'],25241.89)
  by_ym={m['period']:m for m in d['monthly']}
  self.assertAlmostEqual(by_ym['2026-09']['d_ust'],25823.50-26152.00)
  self.assertAlmostEqual(by_ym['2026-11']['d_ust'],25241.89-25685.97)
  with self.assertRaises(ValueError):
   parse_fed_h41(b'bad,header\n2026-11-11,1,2\n')

 def test_ust_auctions_hybrid_merge_null_guard_and_dedup(self):
  import json
  payload={
   'fiscaldata':{'data':[
    {'cusip':'912810UW6','auction_date':'2026-10-08','security_type':'Bond','security_term':'30-Year','comp_accepted':'20000000000','indirect_bidder_accepted':'13000000000','primary_dealer_accepted':'2000000000','fima_noncomp_accepted':'0'},
    {'cusip':'91282CRR4','auction_date':'2026-10-22','security_type':'Note','security_term':'5-Year','comp_accepted':'null','indirect_bidder_accepted':'null','primary_dealer_accepted':'null','fima_noncomp_accepted':'null'},
   ]},
   'treasurydirect':[
    {'cusip':'912810UW6','competitiveAuctionCloseDate':'2026-10-08T00:00:00','securityType':'Bond','securityTerm':'30-Year','subtotalCompetitiveParAwardedInsideOfOfferingAmount':'20000000000','indirectBiddersCompetitiveParAwarded':'13000000000','primaryDealersCompetitiveParAwarded':'2000000000','fimaNoncompetitiveParAwarded':'0'},
    {'cusip':'91282CRR4','competitiveAuctionCloseDate':'2026-10-22T00:00:00','securityType':'Note','securityTerm':'5-Year','subtotalCompetitiveParAwardedInsideOfOfferingAmount':'30000000000','indirectBiddersCompetitiveParAwarded':'18000000000','primaryDealersCompetitiveParAwarded':'4500000000','fimaNoncompetitiveParAwarded':'0'},
    {'cusip':'912810UY2','competitiveAuctionCloseDate':'2026-11-12T00:00:00','securityType':'Bond','securityTerm':'30-Year','subtotalCompetitiveParAwardedInsideOfOfferingAmount':'25000000000','indirectBiddersCompetitiveParAwarded':'15000000000','primaryDealersCompetitiveParAwarded':'3000000000','fimaNoncompetitiveParAwarded':'0'},
   ]
  }
  d=parse_ust_auctions(json.dumps(payload).encode('utf-8'))
  self.assertEqual(d['period'],'2026-11-12')
  by_ym={m['period']:m for m in d['history']}
  self.assertEqual(by_ym['2026-10']['auction_count'],2)
  self.assertAlmostEqual(by_ym['2026-10']['comp_amt'],500.0)
  self.assertAlmostEqual(by_ym['2026-10']['indirect_share'],62.0)
  self.assertEqual(by_ym['2026-11']['auction_count'],1)
  self.assertIn('月初至今',d['metrics'][0]['name'])

 def test_nowcast_sign_monotonicity_intervals_and_auto_handoff(self):
  months=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08']
  tx_hist=[]
  hold_hist=[]
  h41_m=[]
  auc_m=[]
  for i,ym in enumerate(months):
   sh=60.0+(i%4)*1.8
   pd_sh=15.0-(i%4)*1.1
   d_u=-150.0+i*40.0
   bond=300.0+(sh-60.0)*120.0+0.4*d_u
   eq=500.0+(i%3)*40.0
   tx_hist.append({'period':ym,'total':bond+eq,'equity':eq,'bond':bond})
   hold_hist.append({'period':ym,'official':37000.0+i*80.0,'world':90000.0+i*150.0})
   h41_m.append({'period':ym,'through_date':ym+'-28','ust':26000.0+i*60.0,'total':28500.0,'d_ust':d_u})
   auc_m.append({'period':ym,'through_date':ym+'-28','auction_count':8,'comp_amt':3200.0,'indirect_amt':3200.0*sh/100.0,'primary_dealer_amt':3200.0*pd_sh/100.0,'fima_amt':0.0,'indirect_share':sh,'primary_dealer_share':pd_sh})
  # Add 2026-09 (stronger) vs 2026-10 (weaker indirect share & deeper H.4.1 outflow)
  h41_m.extend([
   {'period':'2026-09','through_date':'2026-09-30','ust':26200.0,'total':28400.0,'d_ust':-100.0},
   {'period':'2026-10','through_date':'2026-10-28','ust':25700.0,'total':27900.0,'d_ust':-500.0},
  ])
  auc_m.extend([
   {'period':'2026-09','through_date':'2026-09-30','auction_count':8,'comp_amt':3200.0,'indirect_amt':2080.0,'primary_dealer_amt':352.0,'fima_amt':0.0,'indirect_share':65.0,'primary_dealer_share':11.0},
   {'period':'2026-10','through_date':'2026-10-29','auction_count':8,'comp_amt':3200.0,'indirect_amt':1856.0,'primary_dealer_amt':544.0,'fima_amt':0.0,'indirect_share':58.0,'primary_dealer_share':17.0},
  ])
  sources={
   'tic_transactions':{'history':tx_hist},
   'tic_holdings':{'history':hold_hist},
   'fed_h41_custody':{'period':'2026-10-28','monthly':h41_m},
   'ust_auctions':{'period':'2026-10-29','history':auc_m},
   'cboe_vix':{'history':[{'period':'2026-09-15','vix':18.0},{'period':'2026-10-15','vix':18.0}]},
  }
  nc=compute_nowcast(sources)
  self.assertEqual(nc['status'],'ok')
  self.assertEqual([m['period'] for m in nc['months']],['2026-09','2026-10'])
  m9,m10=nc['months']
  self.assertGreater(m9['bond'],m10['bond'])
  self.assertGreater(m9['total'],m10['total'])
  self.assertLess(m9['total_low80'],m9['total'])
  self.assertGreater(m9['total_high80'],m9['total'])
  self.assertGreater(m9['official_holdings'],m10['official_holdings'])
  # Simulate TIC advancing to 2026-09 -> nowcast automatically shifts to ['2026-10']
  tx_hist.append({'period':'2026-09','total':1400.0,'equity':600.0,'bond':800.0})
  hold_hist.append({'period':'2026-09','official':37450.0,'world':91200.0})
  nc2=compute_nowcast(sources)
  self.assertEqual([m['period'] for m in nc2['months']],['2026-10'])

if __name__=='__main__':unittest.main()
