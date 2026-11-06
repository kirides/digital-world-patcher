"""Offline batch helper for manual translation (by a person or a chat assistant).  No network calls.

    python batch.py list   WORKDIR/<set> --lang de [--batch N]   slice missing strings into <lang>/batches/
    python batch.py merge  WORKDIR/<set> --lang de [names...]    validate + merge <lang>/out/<batch> into <lang>.json
    python batch.py status WORKDIR/<set> --lang de               which batches still have no out file

Batch file:  {"<id>": {"src": "<english>", "file": "<container>", "w": px, "h": lines}, ...}
Out file:    {"<id>": "<translation>", ...}      (UTF-8)
A translation is accepted only if its {FFxx} tokens equal the source's and it is displayable.
Rejected or missing strings are listed in <lang>/failed.json; a batch that is not fully merged
keeps its batch file and its out file is renamed to .partial, so fix it and merge again.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dgmtool import load, save, load_lang, Charset, unique_sources, validate, table_paths

def dirs(a):
    base = os.path.join(a.setdir, a.lang)
    return base, os.path.join(base, 'batches'), os.path.join(base, 'out')

def cmd_list(a):
    cat = load(os.path.join(a.setdir, 'catalog.json')); tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    base, bd, od = dirs(a); os.makedirs(bd, exist_ok=True); os.makedirs(od, exist_ok=True)
    taken = set()                                   # strings already sitting in an unmerged batch
    for n in os.listdir(bd):
        if not os.path.exists(os.path.join(od, n)): taken |= {v['src'] for v in load(os.path.join(bd, n)).values()}
    todo = [(f, s) for f, s in unique_sources(cat) if s not in tab and s not in taken]
    start = len(os.listdir(bd)); made = 0
    for i in range(0, len(todo), a.batch):
        chunk = {str(j): {'src': s, 'file': f, 'w': cat['files'][f]['w'], 'h': cat['files'][f]['h']}
                 for j, (f, s) in enumerate(todo[i:i + a.batch])}
        save(os.path.join(bd, 'batch_%04d.json' % (start + made)), chunk); made += 1
    print('%d strings -> %d new batches in %s' % (len(todo), made, bd))

def cmd_merge(a):
    cat = load(os.path.join(a.setdir, 'catalog.json')); cs = Charset(cat['kind'], load_lang(a.lang))
    tp, _ = table_paths(a.setdir, a.lang); tab = load(tp, {})
    base, bd, od = dirs(a); fp = os.path.join(base, 'failed.json'); failed = load(fp, {})
    names = a.names or sorted(n for n in os.listdir(od) if n.endswith('.json'))
    ok = bad = miss = 0
    for n in names:
        batch, res = load(os.path.join(bd, n)), load(os.path.join(od, n))
        for k, v in batch.items():
            t = res.get(k)
            if t is None: miss += 1; continue
            e = validate(cs, v['src'], t)
            if e is None: tab[v['src']] = t; failed.pop(v['src'], None); ok += 1
            else: failed[v['src']] = {'error': e, 'got': t, 'batch': n}; bad += 1
    save(tp, tab); save(fp, failed)
    # batches whose strings are all merged are done; failed ones are re-listed by "list"
    for n in names:
        if all(v['src'] in tab for v in load(os.path.join(bd, n)).values()): continue
        os.replace(os.path.join(od, n), os.path.join(od, n + '.partial'))
    print('%d merged, %d rejected, %d missing; %s now has %d entries' % (ok, bad, miss, os.path.basename(tp), len(tab)))

def cmd_status(a):
    base, bd, od = dirs(a)
    names = sorted(os.listdir(bd)) if os.path.isdir(bd) else []
    todo = [n for n in names if not os.path.exists(os.path.join(od, n))]
    print('%d batches, %d without out file%s' % (len(names), len(todo), (' (next: %s)' % todo[0]) if todo else ''))

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest='cmd', required=True)
    for name, fn in (('list', cmd_list), ('merge', cmd_merge), ('status', cmd_status)):
        x = sp.add_parser(name); x.add_argument('setdir'); x.add_argument('--lang', required=True); x.set_defaults(f=fn)
        if name == 'list': x.add_argument('--batch', type=int, default=100)
        if name == 'merge': x.add_argument('names', nargs='*')
    a = p.parse_args(); a.f(a)
