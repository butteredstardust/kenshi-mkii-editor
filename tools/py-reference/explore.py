import sys, collections
from ks import read_file

hdr, recs, end, total = read_file(sys.argv[1])
print(hdr)
bytype = collections.defaultdict(list)
for r in recs: bytype[r['type']].append(r)
for t in sorted(bytype):
    rs = bytype[t]
    s = rs[0]
    keys = sorted(set(list(s['bools']) + list(s['floats']) + list(s['ints']) + list(s['strs']) + list(s['files'])))
    print("\n=== type %d  (%d records) ===" % (t, len(rs)))
    print("  names:", [x['name'] for x in rs[:8]])
    print("  sample sid:", s['sid'], " keys:", keys[:25])
