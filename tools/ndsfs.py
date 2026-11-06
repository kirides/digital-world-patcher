"""Minimal NDS filesystem reader/patcher (no external dependencies)."""
import struct

def crc16(data, crc=0xFFFF):
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

class NDS:
    CAPACITY_MAX = 0x10000000

    def __init__(self, path):
        self.path = path
        self.data = bytearray(open(path, 'rb').read())
        d = self.data
        self.title = bytes(d[0:12]).rstrip(b'\0').decode('ascii', 'replace')
        self.code = bytes(d[12:16]).decode('ascii', 'replace')
        self.fnt_off, self.fnt_size, self.fat_off, self.fat_size = struct.unpack_from('<4I', d, 0x40)
        self.fat = [list(struct.unpack_from('<2I', d, self.fat_off + i * 8)) for i in range(self.fat_size // 8)]
        self.files = {}
        self._walk(0xF000, '')
        self.end = max(e for s, e in self.fat)
        self.capacity = 1 << (17 + d[0x14])
        self.pending = {}

    def _walk(self, dirid, prefix):
        d, base = self.data, self.fnt_off
        off, fid, parent = struct.unpack_from('<IHH', d, base + (dirid & 0xFFF) * 8)
        p = base + off
        while True:
            n = d[p]; p += 1
            if n == 0: break
            ln = n & 0x7F
            name = bytes(d[p:p + ln]).decode('ascii', 'replace'); p += ln
            if n & 0x80:
                sub = struct.unpack_from('<H', d, p)[0]; p += 2
                self._walk(sub, prefix + name + '/')
            else:
                self.files[prefix + name] = fid; fid += 1

    def read(self, path):
        if path in self.pending: return self.pending[path]
        s, e = self.fat[self.files[path]]
        return bytes(self.data[s:e])

    def write(self, path, data):
        self.files[path]
        self.pending[path] = bytes(data)

    def build(self):
        """apply pending file writes and return the new ROM image (call once)."""
        d = self.data
        orig_len = len(d)
        end = (self.end + 0x1FF) & ~0x1FF
        for path, blob in self.pending.items():
            fid = self.files[path]
            s, e = self.fat[fid]
            if blob == bytes(d[s:e]): continue
            if len(blob) <= e - s:
                d[s:s + len(blob)] = blob
                self.fat[fid][1] = s + len(blob)
            else:
                if end > len(d): d.extend(b'\xFF' * (end - len(d)))
                del d[end:]
                d.extend(blob)
                self.fat[fid] = [end, end + len(blob)]
                end = (end + len(blob) + 0x1FF) & ~0x1FF
                d.extend(b'\xFF' * (end - len(d)))
            struct.pack_into('<2I', d, self.fat_off + fid * 8, *self.fat[fid])
        if end > self.capacity:
            raise SystemExit('ROM would exceed its capacity (%d > %d bytes)' % (end, self.capacity))
        if len(d) < orig_len: d.extend(bytes([255]) * (orig_len - len(d)))
        used = max(e for s, e in self.fat)
        struct.pack_into('<I', d, 0x80, used)
        struct.pack_into('<H', d, 0x15E, crc16(d[0:0x15E]))
        self.pending = {}
        return bytes(d)

    def save(self, out):
        open(out, 'wb').write(self.build())
