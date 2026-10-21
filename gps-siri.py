#!/usr/bin/env python3
"""קו באג — סריקה רחבה: יום שלם של שידורי GPS מכל האוטובוסים, מקבצי הדקה של דאטאבוס ב-S3.

בכל קובץ דקה (stride-siri-requester/YYYY/MM/DD/HH/MM.br) יש את המיקום של כל האוטובוסים בארץ באותה דקה.
מכל קו נבחרות K נסיעות ביום, מפוזרות על פני השעות, ונכתבות בפורמט ש-gps-scan.js קורא (GPS_SIRI):
<out>/<route_id>.json = [{id, date, points: [[lat, lon, ms], …]}]. קובץ קיים מקבל את היום הנוסף.
ההורדה מ-S3 לא מעמיסה על שרת ה-API של דאטאבוס.

שימוש: python3 gps-siri.py YYYY-MM-DD <out-dir> [K=6]
"""
import sys, json, brotli, urllib.request, datetime, os, collections
from multiprocessing import Pool
B="https://openbus-stride-public.s3.eu-west-1.amazonaws.com/stride-siri-requester"
day=sys.argv[1]; out=sys.argv[2]; K=int(sys.argv[3]) if len(sys.argv)>3 else 6
Y,M,D=day.split('-')
def get(hm):
    h,m=hm
    for a in range(3):
        try:
            raw=urllib.request.urlopen(f"{B}/{Y}/{M}/{D}/{h:02d}/{m:02d}.br",timeout=60).read(); break
        except Exception: raw=None
    if not raw: return []
    try: j=json.loads(brotli.decompress(raw))
    except Exception: return []
    res=[]
    for dl in j.get('Siri',{}).get('ServiceDelivery',{}).get('StopMonitoringDelivery',[]) or []:
        for v in dl.get('MonitoredStopVisit',[]) or []:
            mv=v.get('MonitoredVehicleJourney') or {}; fr=mv.get('FramedVehicleJourneyRef') or {}
            if fr.get('DataFrameRef')!=day: continue
            loc=mv.get('VehicleLocation') or {}
            try:
                lat=float(loc['Latitude']); lon=float(loc['Longitude'])
                t=int(datetime.datetime.fromisoformat(v['RecordedAtTime']).timestamp())
            except Exception: continue
            res.append((mv.get('LineRef',''), fr.get('DatedVehicleJourneyRef','0')+'|'+mv.get('VehicleRef',''), round(lat*1e5), round(lon*1e5), t))
    return res
if __name__=='__main__':
    os.makedirs(out,exist_ok=True)
    J={}; n=0
    with Pool(12) as p:
        for res in p.imap_unordered(get,[(h,m) for h in range(24) for m in range(60)],chunksize=4):
            n+=1
            for line,k,la,lo,t in res:
                e=J.get(k)
                if e is None: e=J[k]=[line,{}]
                e[1][t]=(la,lo)
    byline=collections.defaultdict(list)
    for k,(line,pts) in J.items():
        if len(pts)>=20: byline[line].append((min(pts),k,pts))
    nl=0
    for line,rs in byline.items():
        rs.sort()
        pick=[rs[round(i*(len(rs)-1)/(K-1))] for i in range(K)] if len(rs)>K else rs
        pick=list({r[1]:r for r in pick}.values())
        fn=os.path.join(out,line+'.json')
        cur=json.load(open(fn)) if os.path.exists(fn) else []
        for t0,k,pts in pick:
            cur.append({'id':day+'|'+k,'date':day,'points':[[pts[t][0]/1e5,pts[t][1]/1e5,t*1000] for t in sorted(pts)]})
        json.dump(cur,open(fn,'w'),separators=(',',':')); nl+=1
    print(day,'files',n,'journeys',len(J),'lines',nl,flush=True)
