# Golden archive fixtures

`real/` — archives produced by REAL tools (rar 5.50, p7zip) inside `ubuntu:20.04`, committed
as binaries. Payload is `seededPayload(300*1024)` from `test/archive-fixtures.js` (LCG seed
0x7ace), so tests regenerate the expected bytes without reading a payload file.

| Fixture | Tool command | Exercises |
|---|---|---|
| real4store.rar | `rar a -ma4 -m0` | RAR4 store, single volume |
| real5store.rar | `rar a -ma5 -m0` | RAR5 store, single volume |
| real5multi.part1-4.rar | `rar a -ma5 -m0 -v100k` | RAR5 store, real multi-volume |
| comp4.rar / comp5.rar | `rar a -ma4/-ma5 -m3` | compressed detection (🐢) |
| pass5.rar | `rar a -ma5 -m0 -pSecret123` | data-encrypted (listable) |
| passhdr5.rar | `rar a -ma5 -m0 -hpSecret123` | header-encrypted (unlistable) |
| store7z.7z / lzma7z.7z | `7z a -mx0 / -mx5` | 7z detection |

`work/` — regenerable output of `node test/fixtures/gen-fixtures.js` (hand-rolled JS store
archives + payload). Not used by tests directly; exists so Docker can validate the JS writers.

Regenerate / re-validate everything:

    node test/fixtures/gen-fixtures.js
    docker run --rm -v "${PWD}\test\fixtures:/fix" ubuntu:20.04 sh /fix/docker-gen.sh

The Docker step is also the ground-truth gate for `test/archive-fixtures.js`: real unrar must
test-extract the JS-built RAR4/RAR5 single+multi volumes with zero warnings and byte-identical
output (unrar exits 0 on warnings, so the script greps output). Validated 2026-06-11.

Format notes learned from validation (encoded in the writers):
- Split-volume CRC rule (RAR4 and RAR5 alike): continued parts store the chunk's crc32; the
  final part stores the whole file's crc32.
- Ubuntu 24.04's rar 7.x refuses `-ma4`; use ubuntu:20.04 (rar 5.50) for generation.
