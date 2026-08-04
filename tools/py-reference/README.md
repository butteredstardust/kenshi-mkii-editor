# Python reference implementation

The scripts used to reverse-engineer the Kenshi save format. They are kept as an
**independent second implementation**, not as a runtime dependency — nothing in
`webapp/` shells out to Python, and nothing here should grow into a feature.

Their value is cross-checking. `report.py` and `webapp/scripts/status.js` render
the same save from the same bytes through two separately written parsers; if
they disagree, one of them is wrong and that is worth knowing before an edit
gets written to disk.

## Scripts

| Script | Purpose |
|---|---|
| `ks.py` | The reader. `read_file(path) -> (header, records, endOffset, size)` |
| `explore.py` | Group a file's records by typecode and show sample field names — the first thing to run against an unfamiliar file |
| `dump.py` | Dump every field of records matching a typecode, name or stringID |
| `index.py` | Build `stringID -> (name, type)` across base data + all workshop mods, into `nameidx.pkl` |
| `report.py` | Full character/world report for a save directory |

## Use

```bash
python ks.py       "C:\Users\<you>\AppData\Local\kenshi\save\save1\quick.save"
python explore.py  "...\save1\quick.save"
python dump.py     "...\save1\platoon\Nameless_0.platoon" 25
python index.py                       # writes nameidx.pkl (a few seconds)
python report.py   "...\kenshi\save\save1"
```

`ks.py` prints how many bytes it consumed against the file size. For a filetype
15 save the remainder is the documented tail; for a mod file it must be zero. A
non-zero remainder on a mod file means the parse is wrong.

Paths in `index.py` are hardcoded to this machine's install. The Node
implementation auto-detects them (`webapp/services/pathService.js`) — prefer it
for anything real.
