import os, glob, pickle, sys
from ks import read_file

KEN = r"D:\SteamLibrary\steamapps\common\Kenshi"
WS  = r"D:\SteamLibrary\steamapps\workshop\content\233860"
out = os.path.join(os.path.dirname(__file__), 'nameidx.pkl')

files = [os.path.join(KEN, 'data', 'gamedata.base')]
files += glob.glob(os.path.join(KEN, 'data', '*.mod'))
files += glob.glob(os.path.join(WS, '*', '*.mod'))
files += glob.glob(os.path.join(KEN, 'mods', '*', '*.mod'))

idx = {}
for f in files:
    try:
        hdr, recs, end, total = read_file(f)
    except Exception as e:
        print("SKIP %s: %s" % (os.path.basename(f), e)); continue
    for r in recs:
        if r['sid'] and r['sid'] not in idx:
            idx[r['sid']] = (r['name'], r['type'])
    print("%-55s %6d recs" % (os.path.basename(f), len(recs)))
pickle.dump(idx, open(out, 'wb'))
print("indexed", len(idx), "stringIDs ->", out)
