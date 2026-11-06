# Toolkit: translation, mods, web build

Python 3.10+, plus `pip install anthropic` for API translation. ROMs are only read and never committed
(`*.nds`, `.api_key` are git-ignored). Run the commands from the repository root.

| file | what it does |
|---|---|
| `dgmtool.py` | CLI: extract, status, translate, check, build, release |
| `batch.py` | offline batches for manual translation (person or chat assistant) |
| `langs/<code>.json` | language profile: letters, extra glyphs, style, glossary, release README text |
| `ndsfs.py` | NDS file system reader/rebuilder (header CRC fixed) |
| `fonts.py` | font reader/writer, synthesizes accented letters for fonts that lack them |
| `bps.py` | BPS patch writer/reader (what RomPatcher.js, Flips and beat apply) |
| `verify_rompatcher.js` | applies a patch with RomPatcher.js itself and compares to the expected ROM |
| `mod.py` | applies a data mod (`mods/<name>/mod.json`) to a ROM or writes it as BPS |
| `build_web.py` | writes `web/data/meta.json` + `web/patches/`, or a single-file page (`--single`) |

## Workflow

    T=translations
    python tools/dgmtool.py extract "Digimon World - Dawn.nds" $T     # Dawn + Dusk share one text set: $T/dawn
    python tools/dgmtool.py extract "Digimon World DS.nds"     $T     # $T/ds
    python tools/dgmtool.py translate $T/dawn --lang de --model claude-haiku-5-5 --budget 90
    python tools/dgmtool.py status    $T/dawn --lang de
    python tools/batch.py list  $T/dawn --lang de    # leftovers -> de/batches/*.json, write de/out/*.json, then
    python tools/batch.py merge $T/dawn --lang de
    python tools/dgmtool.py export $T/dawn dawn_de.csv --lang de   # spreadsheet for a native speaker; edit column "de"
    python tools/dgmtool.py import $T/dawn dawn_de.csv --lang de   # validated, rejected rows are listed
    python tools/dgmtool.py check "Digimon World - Dawn.nds" $T/dawn --lang de
    python tools/dgmtool.py release --lang de --workdir $T --out web/patches --dawn-rom "Digimon World - Dawn.nds"         "Digimon World - Dawn.nds" "Digimon World - Dusk.nds" "Digimon World DS.nds"
    python tools/dgmtool.py release ... --mod mods/ds-offline        # same, with a data mod built into the patch
    node tools/verify_rompatcher.js <RomPatcher.js dir> "Digimon World - Dawn.nds" "web/patches/Digimon World Dawn (Deutsch).bps"

`release` writes one `.bps` per ROM plus a README with the CRC32/SHA-1 each patch expects.
Players apply the patch to their own dump with RomPatcher.js; a wrong or modified ROM is rejected.

## Translation tables

* `<set>/<lang>.json` is `{"english source": "translation"}`; one entry covers every place the string occurs.
  `<set>/<lang>.overrides.json` (`{"container:index": "..."}`) translates one occurrence differently.
* `translate` only fills missing entries (resumable). It uses the Claude API (key from `ANTHROPIC_API_KEY`
  or `tools/.api_key`), keeps a running cost in `<workdir>/api_spend.json` and stops at `--budget` USD.
  `--endpoint` uses an OpenAI-compatible local server (Ollama, LM Studio) instead.
* Every translation is validated: control tokens must match the source (line breaks excepted), the text must
  be displayable, and menus/lists (every line starts a new item) must keep their line breaks.
* Control tokens: `{FFED}`/`{FFEC}` player name, `{FFF0-2}` variables, `{FFEE}/{FFEA}/{FFEF}` highlight,
  `{FFE9}` description frame, `{FFFD}` newline, `{FFFE}`/`{FFFF}` end of message, `{22}` etc. icons.
  Flowing text is re-wrapped to each file's box width at build time.

## Adding a language

Copy `langs/de.json` to `langs/<code>.json` and change name, `letters` (every non-ASCII letter the language
uses), style, glossary and readme. Letters from Latin-1 (à-ý, À-Ý, ¡, ¿) need nothing else: Dawn/Dusk's main
font has them, DS gets them copied from Dawn, and the bold menu fonts get them synthesized from the base letter
plus the mark (diaeresis, acute, grave, circumflex, tilde). Letters outside that (ß, œ, ...) need pixel art in
`glyphs` (`art` for the 8x16 fonts, `art16` for the 16x16 menu fonts); they go into unused glyph slots.

## Known limits

Only `dat/MSG.PAK` (Dawn/Dusk) and `dat/msg/*.sdb` (DS) are translated. Text baked into code or graphics
(title screen, some menu labels) is untouched. The caps-only fonts (font_n, font_s, font_s2, font_mini) get
no accented letters. Widths of `{FFED}`/variables are estimates, so `check` warnings are a guide, not exact.
