import json, glob, os, sys
variants = sys.argv[1:]
base = variants[0]
rows = {}
for v in variants:
    for f in sorted(glob.glob(f'benchmarks/solar/results/{v}/*.json')):
        g = os.path.basename(f)[:-5].replace('yul_router','').strip('_') or 'swap'
        for k, val in json.load(open(f)).items():
            rows.setdefault(f'{g}.{k}', {})[v] = int(val)
print('| case | ' + ' | '.join(variants) + ' |')
print('|---|' + '---:|'*len(variants))
for k, d in rows.items():
    cells = []
    for v in variants:
        if v == base: cells.append(str(d[v]))
        else: cells.append(f'{d[v]} ({d[v]-d[base]:+d})')
    print(f'| {k} | ' + ' | '.join(cells) + ' |')
