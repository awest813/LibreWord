#!/usr/bin/env python3
"""Build pieces.doc / pieces-4k.doc from a LibreOffice-written .doc.

LibreOffice always saves the text as one UTF-16 piece in a compound file with
512-byte sectors. Word itself often writes 8-bit ("compressed") pieces, mixes
both kinds, and newer files use 4096-byte sectors. This script rewrites a
LibreOffice .doc so that:

  * the text is split into two pieces: the first part compressed (cp1252,
    one byte per character), the rest still UTF-16;
  * the CHPX/PAPX FKP and bin-table file offsets follow the moved text;
  * optionally, the compound file uses version 4 (4096-byte sectors).

Usage: python3 make-pieces.py source.doc out.doc [512|4096] [split_cp]
Check the result with: soffice --headless --convert-to txt out.doc
(LibreOffice 7.x refuses the 4096-byte-sector variant, so only the 512 one
can be cross-checked that way.)
"""
import struct
import sys

ENDOFCHAIN, FREESECT, FATSECT, NOSTREAM = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD, 0xFFFFFFFF


def u16(b, o): return struct.unpack_from('<H', b, o)[0]
def u32(b, o): return struct.unpack_from('<I', b, o)[0]


def read_cfb(data):
    """Root-level streams of a compound file (no DIFAT sectors needed for small files)."""
    ss = 1 << u16(data, 0x1E)
    sector = lambda n: data[(n + 1) * ss:(n + 2) * ss]
    fat = []
    for i in range(109):
        s = u32(data, 0x4C + i * 4)
        if s < 0xFFFFFFFA:
            fat += struct.unpack('<%dI' % (ss // 4), sector(s))

    def chain(start, table, get):
        out, s = b'', start
        while s < 0xFFFFFFFA:
            out += get(s)
            s = table[s]
        return out

    d = chain(u32(data, 0x30), fat, sector)
    entries = []
    for o in range(0, len(d), 128):
        n = u16(d, o + 0x40)
        entries.append(dict(name=d[o:o + max(0, n - 2)].decode('utf-16-le'), type=d[o + 0x42],
                            left=u32(d, o + 0x44), right=u32(d, o + 0x48), child=u32(d, o + 0x4C),
                            start=u32(d, o + 0x74), size=u32(d, o + 0x78)))
    root = entries[0]
    mini = chain(root['start'], fat, sector)
    minifat_raw = chain(u32(data, 0x3C), fat, sector) if u32(data, 0x40) else b''
    minifat = list(struct.unpack('<%dI' % (len(minifat_raw) // 4), minifat_raw))
    streams, stack = {}, [root['child']]
    while stack:
        i = stack.pop()
        if i == NOSTREAM or i >= len(entries):
            continue
        e = entries[i]
        stack += [e['left'], e['right']]
        if e['type'] == 2:
            if e['size'] < 4096:
                raw = chain(e['start'], minifat, lambda n: mini[n * 64:(n + 1) * 64])
            else:
                raw = chain(e['start'], fat, sector)
            streams[e['name']] = raw[:e['size']]
    return streams


def write_cfb(streams, shift=12):
    """Version-4 compound file. Streams are padded to 4096 bytes so no mini stream is needed."""
    ss = 1 << shift
    names = sorted(streams, key=lambda n: (len(n), n.upper()))
    data_sectors, starts = [], {}
    fat = []
    for name in names:
        raw = streams[name]
        raw = raw + b'\0' * (max(4096, -(-len(raw) // ss) * ss) - len(raw))
        streams[name] = raw
        starts[name] = len(data_sectors)
        n = len(raw) // ss
        for k in range(n):
            data_sectors.append(raw[k * ss:(k + 1) * ss])
            fat.append(len(data_sectors) if k < n - 1 else ENDOFCHAIN)
    # Directory: root + one entry per stream, as a balanced binary tree.
    ids = {name: i + 1 for i, name in enumerate(names)}

    def tree(lo, hi):
        if lo >= hi:
            return NOSTREAM, {}
        mid = (lo + hi) // 2
        left, a = tree(lo, mid)
        right, b = tree(mid + 1, hi)
        links = {**a, **b, names[mid]: (left, right)}
        return ids[names[mid]], links

    top, links = tree(0, len(names))

    def entry(name, typ, left, right, child, start, size):
        n = (name + '\0').encode('utf-16-le')
        return (n + b'\0' * (64 - len(n)) + struct.pack('<HBBIII', len(n), typ, 1, left, right, child)
                + b'\0' * 36 + struct.pack('<IQ', start, size))

    d = entry('Root Entry', 5, NOSTREAM, NOSTREAM, top, ENDOFCHAIN, 0)
    for name in names:
        left, right = links[name]
        d += entry(name, 2, left, right, NOSTREAM, starts[name], len(streams[name]))
    d += b'\0' * (-len(d) % ss)
    dir_start = len(data_sectors)
    for k in range(len(d) // ss):
        data_sectors.append(d[k * ss:(k + 1) * ss])
        fat.append(len(data_sectors) if k < len(d) // ss - 1 else ENDOFCHAIN)
    nfat = 1
    while len(fat) + nfat > nfat * ss // 4:
        nfat += 1
    fat_start = len(data_sectors)
    fat += [FATSECT] * nfat
    fat += [FREESECT] * (nfat * ss // 4 - len(fat))
    fat_raw = struct.pack('<%dI' % len(fat), *fat)
    difat = list(range(fat_start, fat_start + nfat)) + [FREESECT] * (109 - nfat)
    header = (bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b'\0' * 16
              + struct.pack('<HHHHH', 0x3E, 4 if shift == 12 else 3, 0xFFFE, shift, 6) + b'\0' * 6
              + struct.pack('<IIIIIIIII', len(d) // ss if shift == 12 else 0, nfat, dir_start, 0, 4096,
                            ENDOFCHAIN, 0, ENDOFCHAIN, 0)
              + struct.pack('<109I', *difat))
    header += b'\0' * (ss - len(header))
    return header + b''.join(data_sectors) + fat_raw


def main():
    src, dst = sys.argv[1], sys.argv[2]
    streams = read_cfb(open(src, 'rb').read())
    wd = bytearray(streams['WordDocument'])
    flags = u16(wd, 0x0A)
    tname = '1Table' if flags & 0x0200 else '0Table'
    table = bytearray(streams[tname])
    csw = u16(wd, 0x20)
    lw = 0x22 + csw * 2 + 2
    cslw = u16(wd, lw - 2)
    fclcb = lw + cslw * 4 + 2
    fc_of = lambda i: fclcb + i * 8
    ccp = u32(wd, lw + 12)
    fc_clx, lcb_clx = u32(wd, fc_of(33)), u32(wd, fc_of(33) + 4)
    assert table[fc_clx] == 2, 'expected a bare Pcdt'
    plc = fc_clx + 5
    assert (u32(table, fc_clx + 1) - 4) // 12 == 1, 'expected one piece'
    base = u32(table, plc + 8 + 2) & 0x3FFFFFFF  # the single UTF-16 piece's offset
    split = int(sys.argv[4]) if len(sys.argv) > 4 else ccp // 2
    text = wd[base:base + ccp * 2].decode('utf-16-le')
    head = text[:split].encode('cp1252')
    boundary = base + split * 2

    def remap(fc):  # file offset of the UTF-16 text → offset after compressing the first part
        return base + (fc - base) // 2 if base <= fc < boundary else fc

    wd[base:base + len(head)] = head
    for idx in (12, 13):  # PlcfBteChpx, PlcfBtePapx and their FKP pages
        fc, lcb = u32(wd, fc_of(idx)), u32(wd, fc_of(idx) + 4)
        n = (lcb - 4) // 8
        for i in range(n + 1):
            struct.pack_into('<I', table, fc + i * 4, remap(u32(table, fc + i * 4)))
        for i in range(n):
            off = (u32(table, fc + (n + 1) * 4 + i * 4) & 0x3FFFFF) * 512
            count = wd[off + 511]
            for k in range(count + 1):
                struct.pack_into('<I', wd, off + k * 4, remap(u32(wd, off + k * 4)))
    # New two-piece CLX at the end of the table stream.
    pcd = lambda fc: struct.pack('<HIH', 0, fc, 0)
    plcpcd = struct.pack('<III', 0, split, ccp) + pcd((base * 2) | 0x40000000) + pcd(boundary)
    clx = bytes([2]) + struct.pack('<I', len(plcpcd)) + plcpcd
    struct.pack_into('<II', wd, fc_of(33), len(table), len(clx))
    table += clx
    streams['WordDocument'] = bytes(wd)
    streams[tname] = bytes(table)
    shift = 12 if len(sys.argv) > 3 and sys.argv[3] == '4096' else 9
    open(dst, 'wb').write(write_cfb(streams, shift))


if __name__ == '__main__':
    main()
