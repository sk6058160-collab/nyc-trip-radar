#!/usr/bin/env python3
"""Map MTA GTFS stops (subway, LIRR, Metro-North) and key venues/landmarks to TLC taxi zones.
Output: public/data/transit.json  (used to place live MTA alerts and event boosts on zones)."""
import csv, io, json, os, subprocess, zipfile
import duckdb, shapefile
from shapely.geometry import shape, Point
from shapely.ops import transform
from shapely.strtree import STRtree
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw"); OUT = os.path.join(ROOT, "public", "data")
FEEDS = {"subway": "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip",
         "lirr": "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip",
         "mnr": "https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip"}
# Venue / landmark coordinates (public, from venue addresses). zone resolved by point-in-polygon.
PLACES = {
  "msg": ("Madison Square Garden", 40.7505, -73.9934),
  "barclays": ("Barclays Center", 40.6826, -73.9754),
  "yankee": ("Yankee Stadium", 40.8296, -73.9262),
  "citi": ("Citi Field", 40.7571, -73.8458),
  "ubs": ("UBS Arena (Elmont, outside NYC)", 40.7117, -73.7258),
  "metlife": ("MetLife Stadium (NJ, outside NYC)", 40.8135, -74.0745),
  "usta": ("USTA Billie Jean King Tennis Center", 40.7498, -73.8463),
  "lincoln": ("Lincoln Center", 40.7725, -73.9835),
  "radio": ("Radio City Music Hall", 40.7600, -73.9800),
  "broadway": ("Broadway Theater District", 40.7590, -73.9865),
  "penn": ("Penn Station", 40.7506, -73.9935),
  "gct": ("Grand Central", 40.7527, -73.9772),
  "pabt": ("Port Authority Bus Terminal", 40.7570, -73.9903),
  "moynihan": ("Moynihan Train Hall", 40.7523, -73.9967),
  "javits": ("Javits Center", 40.7577, -74.0022),
  "beacon": ("Beacon Theatre", 40.7805, -73.9812),
  "apollo": ("Apollo Theater", 40.8100, -73.9500),
  "kings": ("Kings Theatre", 40.6463, -73.9576),
  "forest": ("Forest Hills Stadium", 40.7195, -73.8486),
  "centralpark": ("Central Park SummerStage", 40.7713, -73.9718),
}

def zones():
    r = shapefile.Reader(os.path.join(RAW, "taxi_zones", "taxi_zones.shp"))
    tr = Transformer.from_crs("EPSG:2263", "EPSG:4326", always_xy=True).transform
    f = [x[0] for x in r.fields[1:]]
    geoms, ids = [], []
    for sr in r.shapeRecords():
        geoms.append(transform(tr, shape(sr.shape.__geo_interface__).buffer(0)))
        ids.append(int(dict(zip(f, sr.record))["LocationID"]))
    return geoms, ids

def main():
    geoms, ids = zones(); tree = STRtree(geoms)
    def zone_of(lat, lon, nearest=False):
        p = Point(lon, lat)
        for i in tree.query(p):
            if geoms[i].contains(p): return ids[i]
        return ids[tree.nearest(p)] if nearest else None
    out = {"stops": {}, "routes": {}, "places": {}}
    con = duckdb.connect()
    for name, url in FEEDS.items():
        zp = os.path.join(RAW, os.path.basename(url))
        if not os.path.exists(zp): subprocess.run(["curl", "-sSfL", "-o", zp, url], check=True)
        z = zipfile.ZipFile(zp)
        stops = {}
        for s in csv.DictReader(io.TextIOWrapper(z.open("stops.txt"), "utf-8-sig")):
            zid = zone_of(float(s["stop_lat"]), float(s["stop_lon"]))
            if zid: stops[s["stop_id"]] = zid
        out["stops"][name] = stops
        d = os.path.join(RAW, "gtfs_" + name); z.extractall(d)
        rows = con.execute(f"""SELECT DISTINCT t.route_id, st.stop_id::VARCHAR FROM read_csv('{d}/stop_times.txt', all_varchar=true) st
                               JOIN read_csv('{d}/trips.txt', all_varchar=true) t USING (trip_id)""").fetchall()
        rz = {}
        for rid, sid in rows:
            if sid in stops: rz.setdefault(rid, set()).add(stops[sid])
        out["routes"][name] = {k: sorted(v) for k, v in rz.items()}
        print(name, len(stops), "stops in NYC zones;", len(rz), "routes")
    for k, (n, lat, lon) in PLACES.items():
        zid = zone_of(lat, lon); out["places"][k] = {"name": n, "lat": lat, "lon": lon, "zone": zid or zone_of(lat, lon, True), "outside": zid is None}
        print(k, out["places"][k])
    json.dump(out, open(os.path.join(OUT, "transit.json"), "w"), separators=(",", ":"))

if __name__ == "__main__":
    main()
