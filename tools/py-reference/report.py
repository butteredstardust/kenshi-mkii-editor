import sys, os, pickle
from ks import read_file

idx = pickle.load(open(os.path.join(os.path.dirname(__file__), 'nameidx.pkl'), 'rb'))
def nm(sid, default=None):
    v = idx.get(sid)
    return v[0] if v else (default if default is not None else sid)

save = sys.argv[1]
hdr, world, _, _ = read_file(os.path.join(save, 'quick.save'))
gs = [r for r in world if r['type'] == 56][0]
I, S, F = gs['ints'], gs['strs'], gs['floats']

print("=" * 72)
print("SAVE: %s     (Kenshi %s)" % (os.path.basename(save), S.get('version')))
print("=" * 72)
print("Faction   : %s" % S.get('pfaction name'))
print("Region    : %s" % S.get('area'))
print("Game time : day %d, %02d:%02d" % (I['time day'], I['time hour'], I['time minute']))
print("Cats      : %d" % I['player money'])
print("Squad     : %d squad(s), %d member(s)" % (I['squads'], I['members']))
print("Map pos   : x=%.0f y=%.0f z=%.0f" % gs['vec3']['pos'])

# faction relations (player faction record in world file)
fr = [r for r in world if r['type'] == 37 and r['name'] == S.get('pfaction name')]
if fr:
    f = fr[0]
    sidmap = {k[len('relationSID'):]: v for k, v in f['strs'].items() if k.startswith('relationSID')}
    rel = []
    for k, v in f['floats'].items():
        if k.startswith('relation'):
            n = k[len('relation'):]
            tgt = sidmap.get(n)
            rel.append((v, nm(tgt) if tgt else '#' + n))
    rel = [x for x in rel if abs(x[0]) > 0.5]
    rel.sort()
    if rel:
        print("\nNotable faction relations:")
        for v, n in rel[:6]:
            print("   %-34s %+7.1f" % (n, v))
        if len(rel) > 6:
            for v, n in rel[-4:]:
                print("   %-34s %+7.1f" % (n, v))

pf = S.get('pfaction name')
for fn in sorted(os.listdir(os.path.join(save, 'platoon'))):
    if not fn.startswith(pf + '_'): continue
    h, recs, _, _ = read_file(os.path.join(save, 'platoon', fn))
    by = {r['sid']: r for r in recs}
    squad = [r for r in recs if r['type'] == 30][0]
    for inst in squad['instances']:
        st = [by[s] for s in inst['states'] if s in by]
        stat = next((s for s in st if s['type'] == 25), None)
        state = next((s for s in st if s['type'] == 36), None)
        med = next((s for s in st if s['type'] == 57), None)
        bag = next((s for s in st if s['type'] == 41), None)
        name = state['strs'].get('name') if state else '?'
        print("\n" + "-" * 72)
        print("%s%s   [from %s]" % (name, "  (squad leader)" if state and state['bools'].get('is leader') else "",
                                    nm(inst['target'])))
        print("-" * 72)
        print("  position : x=%.0f y=%.0f z=%.0f" % inst['pos'])
        if med:
            f = med['floats']; b = med['bools']
            flags = [k for k in ('dead', 'unconcious', 'coma', 'incapacitated') if b.get(k)]
            print("  condition: %s" % (', '.join(flags).upper() if flags else 'conscious / healthy'))
            print("  blood    : %.1f    bleeding %.2f    fed %.2f    hunger %.2f" % (
                f.get('blood', 0), f.get('bleeding', 0), f.get('fed', 0), f.get('hung', 0)))
            print("  body:")
            for i in range(7):
                if 'hit%d' % i not in f: continue
                mx, cur = f['hit%d' % i], f['flesh%d' % i]
                pct = 100.0 * cur / mx if mx else 0
                bar = '#' * int(min(pct, 100) / 5) + '.' * (20 - int(min(pct, 100) / 5))
                print("    %-14s %s %6.1f/%-5.0f %3.0f%%%s" % (
                    nm(med['strs'].get('sid%d' % i, ''), '?'), bar, cur, mx, pct,
                    "   +bandage" if f.get('bandage%d' % i) else ""))
        if stat:
            sk = stat['floats']
            print("  attributes: STR %.1f  DEX %.1f  TGH %.1f  PER %.1f" % (
                sk.get('strength', 0), sk.get('dexterity', 0), sk.get('toughness2', 0), sk.get('perception', 0)))
            named = sorted(((v, k) for k, v in sk.items()
                            if k not in ('xp', 'free attribute points', 'strength', 'dexterity',
                                         'toughness2', 'perception') and v > 1.05), reverse=True)
            print("  trained skills: %s" % (', '.join("%s %.1f" % (k, v) for v, k in named[:12]) or '(none above starting level)'))
        if bag:
            print("  inventory (%d):" % len(bag['instances']))
            for ii in bag['instances']:
                it = by.get(ii['target'])
                if not it: continue
                q = it['ints'].get('quantity', 1)
                print("    %-30s %s%s%s" % (
                    nm(it['strs'].get('base data sid', '')),
                    ("x%d " % q) if q > 1 else "",
                    "[%s] " % it['strs'].get('section', ''),
                    ("(%s)" % nm(it['strs']['material sid'])) if it['strs'].get('material sid') else ""))
