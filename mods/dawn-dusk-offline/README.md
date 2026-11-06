# dawn-dusk-offline: every Digimon without trading (Digimon World Dawn and Dusk)

Dawn and Dusk contain the same game data. What makes Digimon version-exclusive is which dungeons each version can
enter, plus "has befriended X" requirements that point at X itself (so X needs an egg, a trade or an event first).

| Only in Dawn | Only in Dusk |
|---|---|
| Task Canyon, Highlight Haven | Magnet Mine, Process Factory, Shadow Abyss |

Checked against the ROM's encounter tables: without trading, Dawn misses 16 Digimon that Dusk can get (Moonmon /
Lunamon line, Kuramon and Tsumemon lines, Keramon, Tsuchidarumon, SkullGreymon, Piedmon, Puppetmon, MachineDramon,
Diaboromon, ...), Dusk misses 17 that Dawn can get (Sunmon / Coronamon line, Chibomon, Gigimon / Guilmon line, Kudamon
line, Imperialdramon, Gallantmon, Megidramon, ...). This matches the community list of version exclusives.

The mod (one file, applies to both versions):

* copies the wild-encounter entry (same level and rate) of the 12 Digimon these lines start from into the other
  version's exclusive dungeon at the same depth: Moonmon, Keramon, Kuramon, Tsuchidarumon into Task Canyon,
  Tsumemon, SkullGreymon, Piedmon into Highlight Haven; Sunmon, Chibomon, Guilmon, Kudamon, Imperialdramon Fighter
  Mode into Magnet Mine
* removes the self-referential "has befriended X" conditions on routes into X (DotAgumon, Guilmon, Kudamon,
  SkullGreymon, Kimeramon, Apocalymon, ...)

With the mod, the page's check counts 349 of 352 Digimon in each version. The remaining three (Lucemon Chaos Mode,
Creepymon, Moon=Millenniummon) come from DNA digivolution or quests, which the check does not model.
Matching, DNA and trading keep working as in the original.
