"""Build rsrc_windows_amd64.syso: the app icon (from assets/skull.webp) plus a manifest,
as a COFF object the Go linker links into GrimTracker.exe. Needs Pillow.

    python3 tools/make_syso.py <skull image> <out.syso> <out.ico>
"""
import io, struct, sys
from PIL import Image

SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

MANIFEST = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="GrimTracker" version="1.0.0.0" processorArchitecture="amd64"/>
  <description>GrimTracker</description>
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
      processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
  </windowsSettings></application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
</assembly>
"""


def square(img, size):
    img = img.convert("RGBA")
    bb = img.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
    if bb:
        img = img.crop(bb)
    w, h = img.size
    s = max(w, h)
    c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    c.paste(img, ((s - w) // 2, (s - h) // 2))
    return c.resize((size, size), Image.LANCZOS)


def dib(img):
    """32-bit BMP icon image (no file header): XOR bitmap bottom-up BGRA + AND mask."""
    w, h = img.size
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    row = ((w + 31) // 32) * 4
    andm = bytearray()
    for y in range(h - 1, -1, -1):
        bits = bytearray(row)
        for x in range(w):
            if px[x, y][3] < 128:
                bits[x // 8] |= 0x80 >> (x % 8)
        andm += bits
    return hdr + bytes(xor) + bytes(andm)


def png(img):
    b = io.BytesIO()
    img.save(b, "PNG", optimize=True)
    return b.getvalue()


def build(src, out_syso, out_ico):
    base = Image.open(src)
    images = []
    for s in SIZES:
        im = square(base, s)
        images.append((s, png(im) if s >= 64 else dib(im)))

    # .ico file (handy for the site / shortcuts)
    ico = struct.pack("<HHH", 0, 1, len(images))
    off = 6 + 16 * len(images)
    body = b""
    for s, data in images:
        ico += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), off + len(body))
        body += data
    open(out_ico, "wb").write(ico + body)

    group = struct.pack("<HHH", 0, 1, len(images))
    for i, (s, data) in enumerate(images, 1):
        group += struct.pack("<BBBBHHIH", s % 256, s % 256, 0, 0, 1, 32, len(data), i)

    # resources: type -> [(id, bytes)], all language 0x0409
    res = {3: [(i, d) for i, (s, d) in enumerate(images, 1)], 14: [(1, group)], 24: [(1, MANIFEST)]}

    # lay out: directories first, then data entries, then data
    types = sorted(res)
    dirs = bytearray()
    entries_after = []  # we compute offsets in two passes
    n_dirs = 1 + len(types) + sum(len(res[t]) for t in types)
    n_dir_entries = len(types) + sum(len(res[t]) for t in types) * 2
    dir_size = n_dirs * 16 + n_dir_entries * 8
    n_data = sum(len(res[t]) for t in types)
    data_entries_off = dir_size
    data_off = data_entries_off + n_data * 16

    def align(n, a=8):
        return (n + a - 1) // a * a

    data_off = align(data_off)
    out = bytearray()
    relocs = []
    # level 1
    l1 = struct.pack("<IIHHHH", 0, 0, 0, 0, 0, len(types))
    cursor = 16 + 8 * len(types)
    l2_offsets = []
    for t in types:
        l2_offsets.append(cursor)
        cursor += 16 + 8 * len(res[t])
    l3_offsets = {}
    for t in types:
        for rid, _ in res[t]:
            l3_offsets[(t, rid)] = cursor
            cursor += 16 + 8
    assert cursor == dir_size, (cursor, dir_size)
    for t, o in zip(types, l2_offsets):
        l1 += struct.pack("<II", t, 0x80000000 | o)
    out += l1
    for t in types:
        out += struct.pack("<IIHHHH", 0, 0, 0, 0, 0, len(res[t]))
        for rid, _ in res[t]:
            out += struct.pack("<II", rid, 0x80000000 | l3_offsets[(t, rid)])
    de_index = 0
    data_blob = bytearray()
    data_entries = bytearray()
    for t in types:
        for rid, data in res[t]:
            out += struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1)
            out += struct.pack("<II", 0x0409, data_entries_off + de_index * 16)
            # data entry: OffsetToData is an RVA, fixed up by the linker via a relocation
            field = data_entries_off + de_index * 16
            relocs.append(field)
            data_entries += struct.pack("<IIII", data_off + len(data_blob), len(data), 0, 0)
            data_blob += data
            data_blob += b"\0" * (align(len(data_blob)) - len(data_blob))
            de_index += 1
    assert len(out) == dir_size
    out += data_entries
    out += b"\0" * (data_off - len(out))
    out += data_blob
    raw = bytes(out)

    # COFF object: header, one .rsrc section, relocations, symbol table, string table
    sec_hdr_off = 20
    raw_off = sec_hdr_off + 40
    reloc_off = raw_off + len(raw)
    sym_off = reloc_off + 10 * len(relocs)
    coff = struct.pack("<HHIIIHH", 0x8664, 1, 0, sym_off, 1, 0, 0)
    sect = b".rsrc\0\0\0" + struct.pack("<IIIIIIHHI", 0, 0, len(raw), raw_off, reloc_off, 0, len(relocs), 0, 0x40000040)
    rel = b"".join(struct.pack("<IIH", r, 0, 3) for r in relocs)  # IMAGE_REL_AMD64_ADDR32NB
    sym = b".rsrc\0\0\0" + struct.pack("<IhHBB", 0, 1, 0, 3, 0)
    strtab = struct.pack("<I", 4)
    open(out_syso, "wb").write(coff + sect + raw + rel + sym + strtab)


if __name__ == "__main__":
    build(*sys.argv[1:4])
