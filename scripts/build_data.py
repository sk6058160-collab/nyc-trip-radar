#!/usr/bin/env python3
"""NYC Trip Radar preprocessing.

Downloads NYC TLC trip records (HVFHV + yellow + green) one file at a time,
projects them to a slim local parquet, deletes the raw file, then aggregates
by pickup zone x day-of-week x hour x service into compact JSON for the app.

Usage:  python scripts/build_data.py --months 2026-05 2026-06 2026-07
Requires: duckdb, shapely, pyshp, pyproj  (see requirements.txt)
"""
import argparse, json, os, subprocess, sys, datetime as dt, zipfile, urllib.request
from collections import defaultdict
import duckdb

BASE = "https://d37ci6vzurychx.cloudfront.net/trip-data"
MISC = "https://d37ci6vzurychx.cloudfront.net/misc"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
SLIM = os.path.join(RAW, "slim")
OUT = os.path.join(ROOT, "public", "data")
AIRPORTS = (1, 132, 138)  # EWR, JFK, LGA
SERVICES = {"rideshare": 0, "yellow": 1, "green": 2}

SQL = {
 "fhvhv": """SELECT PULocationID::SMALLINT pu, DOLocationID::SMALLINT dz,
     pickup_datetime ts, trip_miles::FLOAT mi, (trip_time/60.0)::FLOAT mins,
     driver_pay::FLOAT pay FROM read_parquet('{f}')""",
 "yellow": """SELECT PULocationID::SMALLINT pu, DOLocationID::SMALLINT dz,
     tpep_pickup_datetime ts, trip_distance::FLOAT mi,
     (epoch(tpep_dropoff_datetime - tpep_pickup_datetime)/60.0)::FLOAT mins,
     fare_amount::FLOAT pay FROM read_parquet('{f}')""",
 "green": """SELECT PULocationID::SMALLINT pu, DOLocationID::SMALLINT dz,
     lpep_pickup_datetime ts, trip_distance::FLOAT mi,
     (epoch(lpep_dropoff_datetime - lpep_pickup_datetime)/60.0)::FLOAT mins,
     fare_amount::FLOAT pay FROM read_parquet('{f}')""",
}

def fetch(url, dest):
    if not os.path.exists(dest):
        print("  downloading", url, flush=True)
        subprocess.run(["curl", "-sSfL", "--retry", "3", "-o", dest + ".part", url], check=True)
        os.rename(dest + ".part", dest)

def slim(month, kind, con):
    out = os.path.join(SLIM, f"{kind}_{month}.parquet")
    if os.path.exists(out):
        return out
    raw = os.path.join(RAW, f"{kind}_tripdata_{month}.parquet")
    fetch(f"{BASE}/{kind}_tripdata_{month}.parquet", raw)
    y, m = map(int, month.split("-"))
    start = dt.date(y, m, 1); end = dt.date(y + (m == 12), m % 12 + 1, 1)
    svc = SERVICES["rideshare" if kind == "fhvhv" else kind]
    q = SQL[kind].format(f=raw)
    con.execute(f"""COPY (
      SELECT {svc}::TINYINT svc, pu, dz, isodow(ts)::TINYINT % 7 AS dow, hour(ts)::TINYINT hr,
             mi, mins, pay
      FROM ({q})
      WHERE ts >= DATE '{start}' AND ts < DATE '{end}'
        AND pu BETWEEN 1 AND 263 AND pu NOT IN (264,265)
        AND mi > 0 AND mi < 100 AND mins >= 1 AND mins <= 240 AND pay > 0 AND pay < 1000
    ) TO '{out}' (FORMAT parquet, COMPRESSION zstd)""")
    n = con.execute(f"select count(*) from '{out}'").fetchone()[0]
    print(f"  {kind} {month}: {n:,} clean trips", flush=True)
    os.remove(raw)
    return out

def dow_occurrences(months):
    occ = [0] * 7  # 0=Sun..6=Sat (isodow%7)
    for mo in months:
        y, m = map(int, mo.split("-"))
        d = dt.date(y, m, 1)
        while d.month == m:
            occ[d.isoweekday() % 7] += 1
            d += dt.timedelta(days=1)
    return occ

def build_geo():
    import shapefile
    from shapely.geometry import shape, mapping
    from shapely.ops import transform
    from pyproj import Transformer
    zp = os.path.join(RAW, "taxi_zones.zip")
    fetch(f"{MISC}/taxi_zones.zip", zp)
    with zipfile.ZipFile(zp) as z: z.extractall(RAW)
    shp = os.path.join(RAW, "taxi_zones", "taxi_zones.shp")
    tr = Transformer.from_crs("EPSG:2263", "EPSG:4326", always_xy=True).transform
    r = shapefile.Reader(shp)
    fields = [f[0] for f in r.fields[1:]]
    feats, cents = [], {}
    def rnd(g):
        return transform(lambda x, y, z=None: (round(x, 5), round(y, 5)), g)
    merged = {}
    for sr in r.shapeRecords():
        rec = dict(zip(fields, sr.record))
        lid = int(rec["LocationID"])
        g = shape(sr.shape.__geo_interface__).buffer(0)
        merged[lid] = g if lid not in merged else merged[lid].union(g)
    for lid, g in sorted(merged.items()):
        s = g.simplify(150, preserve_topology=True)  # 150 ft tolerance
        wg = rnd(transform(tr, s))
        c = transform(tr, g.representative_point())
        cents[lid] = [round(c.x, 5), round(c.y, 5)]
        feats.append({"type": "Feature", "id": lid, "properties": {}, "geometry": mapping(wg)})
    gj = {"type": "FeatureCollection", "features": feats}
    with open(os.path.join(OUT, "zones.geojson"), "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    return cents

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", nargs="+", required=True)
    ap.add_argument("--min-trips", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(SLIM, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    con = duckdb.connect(os.path.join(RAW, "work.duckdb"))
    con.execute("SET memory_limit='6GB'; SET threads=6; SET preserve_insertion_order=false;")
    con.execute(f"SET temp_directory='{RAW}/tmp'")
    files = []
    for mo in a.months:
        for kind in ("green", "yellow", "fhvhv"):
            files.append(slim(mo, kind, con))
    flist = ",".join(f"'{f}'" for f in files)
    print("Aggregating ...", flush=True)
    ap_list = ",".join(map(str, AIRPORTS))
    # svc 3 = all services combined
    rows = con.execute(f"""
      WITH t AS (SELECT *, CASE WHEN mi > 10 OR dz IN ({ap_list}) THEN 2 WHEN mi >= 3 THEN 1 ELSE 0 END AS len
                 FROM read_parquet([{flist}]))
      SELECT coalesce(svc, 3) svc, pu, dow, hr, count(*) n,
        avg((len=0)::INT) s, avg((len=1)::INT) m, avg((len=2)::INT) l,
        median(mi) mmi, median(mins) mmin, median(pay) mpay,
        sum(pay) / (sum(mins)/60.0) pph, avg((dz IN ({ap_list}))::INT) apt
      FROM t GROUP BY GROUPING SETS ((svc, pu, dow, hr), (pu, dow, hr))
    """).fetchall()
    print("  cells:", len(rows), flush=True)
    dests = con.execute(f"""
      WITH t AS (SELECT svc, pu, dz, CASE WHEN dow IN (0,6) THEN 1 ELSE 0 END we, hr // 6 AS blk
                 FROM read_parquet([{flist}])),
      g AS (SELECT coalesce(svc,3) svc, pu, we, blk, dz, count(*) c FROM t
            GROUP BY GROUPING SETS ((svc,pu,we,blk,dz),(pu,we,blk,dz))),
      r AS (SELECT *, row_number() OVER (PARTITION BY svc,pu,we,blk ORDER BY c DESC) rk,
                  sum(c) OVER (PARTITION BY svc,pu,we,blk) tot FROM g)
      SELECT svc,pu,we,blk,dz,c,tot FROM r WHERE rk <= 5 ORDER BY svc,pu,we,blk,rk
    """).fetchall()
    totals = con.execute(f"select svc, count(*) from read_parquet([{flist}]) group by svc order by svc").fetchall()

    occ = dow_occurrences(a.months)
    names = {v: k for k, v in SERVICES.items()}; names[3] = "all"
    # cell array layout per zone: 168 slots (dow*24+hr), each [n, s%, m%, l%, medMi*10, medMin, medPay*1 (dollars), payPerHr, airport%] or 0
    data = {s: {} for s in names.values()}
    for svc, pu, dow, hr, n, s, m, l, mmi, mmin, mpay, pph, apt in rows:
        if n < a.min_trips: continue
        z = data[names[svc]].setdefault(str(pu), [0] * 168)
        z[dow * 24 + hr] = [n, round(s * 100), round(m * 100), round(l * 100), round(mmi, 1),
                            round(mmin), round(mpay, 2), round(pph), round(apt * 100)]
    for s, d in data.items():
        with open(os.path.join(OUT, f"cells_{s}.json"), "w") as f:
            json.dump(d, f, separators=(",", ":"))
    dd = {s: {} for s in names.values()}
    for svc, pu, we, blk, dz, c, tot in dests:
        k = f"{pu}_{we}_{blk}"
        dd[names[svc]].setdefault(k, []).append([dz, round(c * 100 / tot, 1)])
    with open(os.path.join(OUT, "dests.json"), "w") as f:
        json.dump(dd, f, separators=(",", ":"))
    cents = build_geo()
    zones = {}
    import csv
    lk = os.path.join(RAW, "taxi_zone_lookup.csv")
    fetch(f"{MISC}/taxi_zone_lookup.csv", lk)
    for r in csv.DictReader(open(lk)):
        lid = int(r["LocationID"])
        if lid in cents:
            zones[lid] = {"b": r["Borough"], "z": r["Zone"], "sz": r["service_zone"], "c": cents[lid]}
    meta = {
        "months": a.months, "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "dowOccurrences": occ,
        "tripsBySvc": {names[s]: n for s, n in totals},
        "airports": list(AIRPORTS),
        "source": "NYC TLC Trip Record Data (fhvhv, yellow, green)",
        "zones": zones,
        "cellLayout": ["n", "short%", "medium%", "long%", "medMiles", "medMinutes", "medPayOrFare", "payPerEngagedHour", "airportBound%"],
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print("Done.", meta["tripsBySvc"])

if __name__ == "__main__":
    main()
