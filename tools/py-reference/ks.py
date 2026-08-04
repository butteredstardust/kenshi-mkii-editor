"""Kenshi save/mod binary reader (format spec: filetype 15 = save, 16 = mod)."""
import struct

class R:
    def __init__(self, data):
        self.d = data; self.o = 0
    def L(self):
        v = struct.unpack_from('<i', self.d, self.o)[0]; self.o += 4; return v
    def F(self):
        v = struct.unpack_from('<f', self.d, self.o)[0]; self.o += 4; return v
    def B(self):
        v = self.d[self.o] != 0; self.o += 1; return v
    def S(self):
        n = self.L()
        if n < 0 or self.o + n > len(self.d): raise ValueError('bad string len %d at %d' % (n, self.o-4))
        s = self.d[self.o:self.o+n].decode('utf-8', 'replace'); self.o += n; return s
    def V(self, k):
        return tuple(self.F() for _ in range(k))

def read_record(r, ftype):
    rec = {}
    rec['instcount'] = r.L()
    rec['type'] = r.L()
    rec['id'] = r.L()
    rec['name'] = r.S()
    rec['sid'] = r.S()
    rec['moddata'] = r.L()
    rec['bools']  = {r.S(): r.B() for _ in range(r.L())}
    rec['floats'] = {r.S(): r.F() for _ in range(r.L())}
    rec['ints']   = {r.S(): r.L() for _ in range(r.L())}
    rec['vec3']   = {r.S(): r.V(3) for _ in range(r.L())}
    rec['vec4']   = {r.S(): r.V(4) for _ in range(r.L())}
    rec['strs']   = {r.S(): r.S() for _ in range(r.L())}
    rec['files']  = {r.S(): r.S() for _ in range(r.L())}
    extra = {}
    for _ in range(r.L()):
        cat = r.S(); cnt = r.L()
        extra[cat] = [(r.S(), r.L(), r.L(), r.L()) for _ in range(cnt)]
    rec['extra'] = extra
    inst = []
    for _ in range(r.L()):
        iid = r.S(); tgt = r.S(); pos = r.V(3); rot = r.V(4)
        inst.append({'id': iid, 'target': tgt, 'pos': pos, 'rot': rot,
                     'states': [r.S() for _ in range(r.L())]})
    rec['instances'] = inst
    return rec

def read_file(path):
    r = R(open(path, 'rb').read())
    ftype = r.L()
    hdr = {'filetype': ftype}
    if ftype == 15:
        hdr['nextid'] = r.L(); n = r.L()
    else:
        if ftype == 17: hdr['extra_hdr'] = r.L()   # newer mod format has one extra leading int
        hdr['modversion'] = r.L()
        hdr['author'] = r.S(); hdr['desc'] = r.S(); hdr['deps'] = r.S(); hdr['refs'] = r.S()
        # Between the reference list and the record count, type-17 files carry a
        # variable-length blob. Find the header end by probing for an offset where
        # a sane record count is followed by records that actually parse.
        base = r.o
        for k in range(0, 40):
            r.o = base + k
            try:
                u = r.L(); n = r.L()
            except Exception:
                continue
            if not (0 < n < 500000): continue
            probe, ok = r.o, True
            try:
                for _ in range(min(3, n)): read_record(r, ftype)
            except Exception:
                ok = False
            r.o = probe
            if ok:
                hdr['unknown'] = u; hdr['skew'] = k
                break
        else:
            raise ValueError('could not locate record count')
    hdr['records'] = n
    recs = [read_record(r, ftype) for _ in range(n)]
    return hdr, recs, r.o, len(r.d)

if __name__ == '__main__':
    import sys, collections
    hdr, recs, end, total = read_file(sys.argv[1])
    print(hdr, 'parsed to', end, 'of', total, '(tail %d bytes)' % (total-end))
    print(collections.Counter(x['type'] for x in recs).most_common())
