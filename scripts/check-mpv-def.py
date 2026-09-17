#!/usr/bin/env python3
"""Diff packaging/windows/mpv.def against a libmpv-2.dll's real export table.

`lib.exe /def:` builds the MSVC import library from the .def ALONE — it never
opens the DLL. A symbol listed in the .def but not exported by the DLL
therefore links fine and then fails at PROCESS LOAD (the app dies before
main(), with no window and no message). This script is the CI gate for that:
it parses the DLL's PE export table directly (stdlib only — runs anywhere
Python runs, including the Windows runner) and FAILS if any .def name is
missing from the DLL. Names exported by the DLL but absent from the .def are
fine (we deliberately import only a subset) and are only counted.

Usage: check-mpv-def.py <libmpv-2.dll> <mpv.def>
Exit: 0 = every .def name is exported; 1 = missing names (listed) or parse
error.
"""

import struct
import sys
from pathlib import Path


def rva_to_offset(rva: int, sections: list[tuple[int, int, int, int]]) -> int:
    """Translate an RVA to a file offset via the section table.

    Each section tuple is (virtual_address, virtual_size, raw_ptr, raw_size).
    """
    for vaddr, vsize, rptr, rsize in sections:
        span = max(vsize, rsize)
        if vaddr <= rva < vaddr + span:
            delta = rva - vaddr
            if delta >= rsize:
                raise ValueError(f"RVA {rva:#x} points into section BSS tail")
            return rptr + delta
    raise ValueError(f"RVA {rva:#x} not covered by any section")


def dll_export_names(dll: Path) -> set[str]:
    """Parse a PE32/PE32+ DLL's export table and return the named symbols."""
    data = dll.read_bytes()

    if data[:2] != b"MZ":
        raise ValueError("not a PE file (no MZ magic)")
    pe_off = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_off : pe_off + 4] != b"PE\x00\x00":
        raise ValueError("bad PE signature")

    machine, num_sections, _, _, _, opt_size, _ = struct.unpack_from(
        "<HHIIIHH", data, pe_off + 4
    )
    if machine not in (0x8664, 0x14C):
        raise ValueError(f"unsupported machine {machine:#x}")

    opt_off = pe_off + 24
    magic = struct.unpack_from("<H", data, opt_off)[0]
    if magic == 0x20B:  # PE32+
        dd_off = opt_off + 112
    elif magic == 0x10B:  # PE32
        dd_off = opt_off + 96
    else:
        raise ValueError(f"unknown optional-header magic {magic:#x}")

    export_rva, _export_size = struct.unpack_from("<II", data, dd_off)
    if export_rva == 0:
        return set()

    sect_off = opt_off + opt_size
    sections = []
    for i in range(num_sections):
        base = sect_off + 40 * i
        vsize, vaddr, rsize, rptr = struct.unpack_from("<IIII", data, base + 8)
        sections.append((vaddr, vsize, rptr, rsize))

    exp = rva_to_offset(export_rva, sections)
    # IMAGE_EXPORT_DIRECTORY (40 bytes): Characteristics(0) TimeDateStamp(4)
    # Major(8) Minor(10) Name(12) Base(16) NumberOfFunctions(20)
    # NumberOfNames(24) AddressOfFunctions(28) AddressOfNames(32)
    # AddressOfNameOrdinals(36)
    num_names = struct.unpack_from("<I", data, exp + 24)[0]
    addr_names = struct.unpack_from("<I", data, exp + 32)[0]
    names_off = rva_to_offset(addr_names, sections)

    names = set()
    for i in range(num_names):
        name_rva = struct.unpack_from("<I", data, names_off + 4 * i)[0]
        n_off = rva_to_offset(name_rva, sections)
        end = data.index(b"\x00", n_off)
        names.add(data[n_off:end].decode("ascii"))
    return names


def def_names(def_path: Path) -> set[str]:
    """Collect symbol names from a module-definition EXPORTS list."""
    names: set[str] = []
    in_exports = False
    for raw in def_path.read_text(encoding="ascii").splitlines():
        line = raw.split(";", 1)[0].strip()
        if not line:
            continue
        head = line.split(None, 1)[0].lower()
        if head in ("library", "exports"):
            in_exports = head == "exports" or in_exports
            continue
        if not in_exports:
            continue
        # "name @ordinal", "name @ordinal NONAME", or bare "name" — the
        # first token is always the symbol name.
        names.append(line.split(None, 1)[0])
    return set(names)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 1
    dll, deff = Path(sys.argv[1]), Path(sys.argv[2])

    try:
        exported = dll_export_names(dll)
    except (ValueError, OSError) as e:
        print(f"ERROR: failed to parse {dll}: {e}", file=sys.stderr)
        return 1
    wanted = def_names(deff)

    missing = sorted(wanted - exported)
    print(f"DLL exports: {len(exported)} names")
    print(f".def entries: {len(wanted)} names")
    print(f".def names not exported by the DLL: {len(missing)}")
    print(f"DLL-only names (fine, subset import): {len(exported - wanted)}")
    if missing:
        print("\nERROR: names in the .def but NOT exported by the DLL "
              "(link would succeed, process would die at load):", file=sys.stderr)
        for name in missing:
            print(f"  {name}", file=sys.stderr)
        return 1
    print("OK: every .def name is exported by the DLL")
    return 0


if __name__ == "__main__":
    sys.exit(main())
