// Apply a patch with RomPatcher.js itself (no npm deps) and compare to an expected ROM.
//   node verify_rompatcher.js <RomPatcher.js dir> <rom> <patch> [expected.nds]
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const [dir, romPath, patchPath, expected] = process.argv.slice(2);
const RomPatcher = require(path.resolve(dir, 'rom-patcher-js/RomPatcher.js'));
const BinFile = require(path.resolve(dir, 'rom-patcher-js/modules/BinFile.js'));
const patch = RomPatcher.parsePatchFile(new BinFile(patchPath));
if (!patch) throw new Error('RomPatcher.js could not parse the patch');
const out = RomPatcher.applyPatch(new BinFile(romPath), patch, { requireValidation: true });
const bytes = Buffer.from(out._u8array.buffer, out._u8array.byteOffset, out.fileSize);
const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
console.log('RomPatcher.js applied ' + path.basename(patchPath) + ': ' + out.fileSize + ' bytes, SHA-1 ' + sha1);
if (expected) {
  const same = Buffer.compare(bytes, fs.readFileSync(expected)) === 0;
  console.log(same ? 'identical to ' + path.basename(expected) : 'MISMATCH with ' + path.basename(expected));
  process.exit(same ? 0 : 1);
}
