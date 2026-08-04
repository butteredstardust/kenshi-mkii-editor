import sys
from ks import read_file

path, sel = sys.argv[1], sys.argv[2]
hdr, recs, end, total = read_file(path)
for r in recs:
    key = str(r['type'])
    if sel != key and sel.lower() not in (r['name'] or '').lower() and sel != r['sid']:
        continue
    print("=" * 70)
    print("type=%s id=%s name=%r sid=%r instcount=%d moddata=%d" % (r['type'], r['id'], r['name'], r['sid'], r['instcount'], r['moddata']))
    for sect in ('bools', 'floats', 'ints', 'vec3', 'vec4', 'strs', 'files'):
        if r[sect]:
            print(" --%s (%d)" % (sect, len(r[sect])))
            for k, v in r[sect].items():
                print("    %-40s %s" % (k, v))
    if r['extra']:
        print(" --extra")
        for c, v in r['extra'].items():
            print("    %s: %s" % (c, v[:12]))
    if r['instances']:
        print(" --instances (%d)" % len(r['instances']))
        for i in r['instances'][:40]:
            print("    %-8s -> %-24s pos=%s states=%s" % (i['id'], i['target'], tuple(round(x,1) for x in i['pos']), i['states'][:6]))
