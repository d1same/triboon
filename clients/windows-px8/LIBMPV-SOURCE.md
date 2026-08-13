# libmpv source, license, and rebuild information

Triboon for Windows dynamically links to an unmodified LGPL build of libmpv.
Triboon does not statically incorporate mpv or prevent users from replacing the
DLL with a compatible build.

## Exact distributed runtime

| Item | Locked value |
| --- | --- |
| Archive | `mpv-dev-lgpl-x86_64-20260812-git-f4d13e1c2c.7z` |
| Archive URL | `https://github.com/zhongfly/mpv-winbuild/releases/download/2026-08-12-f4d13e1c2c/mpv-dev-lgpl-x86_64-20260812-git-f4d13e1c2c.7z` |
| SHA-256 | `20dffed429610b52dbb9e3d5b4124145b2a954ef3e6e8fe319cc249a5a794c51` |
| `libmpv-2.dll` SHA-256 | `34bdbb5c56132fbed513fd13a9401fb729e206309e7b4c091dc3a4b70b423fd4` |
| Release | `https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-12-f4d13e1c2c` |
| mpv source | `https://github.com/mpv-player/mpv/commit/f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47` |
| Builder workflow source | `https://github.com/zhongfly/mpv-winbuild/blob/a237017af09e72a689882afdf0adf6108c33c0fd/.github/workflows/mpv.yml` |
| Builder commit used by the published run | `a237017af09e72a689882afdf0adf6108c33c0fd` |
| Published build run | `https://github.com/zhongfly/mpv-winbuild/actions/runs/31594464841` |

The selected archive is the baseline x86-64 LGPL variant, not the GPL or
x86-64-v3 variant. Its release records Clang as the compiler. The Triboon
workflow pins both its immutable URL and SHA-256 and verifies the digest before
using any file from the archive.

The installer includes the verbatim license text as `LIBMPV-LICENSE.LGPL`.
mpv's copyright notices and the same LGPL text are also available in the exact
source tree:

- `https://github.com/mpv-player/mpv/blob/f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47/Copyright`
- `https://github.com/mpv-player/mpv/blob/f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47/LICENSE.LGPL`

The exact archive contains the mpv C headers, the MinGW import library
`libmpv.dll.a`, and one runtime binary, `libmpv-2.dll`. It does **not** contain
`mpv.def`, an MSVC `mpv.lib`, or separate FFmpeg/libass/libplacebo codec,
subtitle, or rendering DLLs. The Triboon package script derives `mpv.def` from
the locked DLL exports and generates `mpv.lib` with the installed MSVC tools;
neither generated link file is distributed. The single upstream DLL contains
the enabled LGPL-build components. Use the pinned builder workflow/run and its
package-version/source summary for those exact component revisions.

`dumpbin /dependents` shows that this DLL imports standard Windows system
libraries and `vulkan-1.dll`. The installer intentionally does not copy a
Vulkan loader. A current x64 graphics driver/Vulkan Runtime must provide
`C:\Windows\System32\vulkan-1.dll`, even though Triboon requests mpv's D3D11
renderer. Missing that loader prevents Windows from loading `libmpv-2.dll`.

## Reproduce or modify the runtime

For the closest reproduction of the distributed DLL:

1. Check out `zhongfly/mpv-winbuild` at
   `a237017af09e72a689882afdf0adf6108c33c0fd`.
2. Open `.github/workflows/mpv.yml` and run its `Build MPV` route with the same
   inputs recorded by run `31594464841`: Clang compiler, `64` target, LGPL
   enabled, no additional mpv pull-request patches, and mpv commit
   `f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`.
3. That workflow checks out the pinned Windows build toolchain repository,
   builds the dependency graph and mpv, and emits the
   `mpv-dev-lgpl-x86_64-*` archive containing the headers, MinGW import
   library, and `libmpv-2.dll` described above.
4. Verify the resulting dependency/source revision table in the workflow job
   summary. A byte-identical archive is not guaranteed across a newer compiler,
   operating-system image, or dependency mirror; corresponding behavior and
   source are the reproducibility target.

Alternatively, mpv's supported Meson route begins from the exact mpv commit and
uses `meson setup build -Dlibmpv=true`, `meson compile -C build`, and
`meson install -C build` after providing compatible FFmpeg, libplacebo, libass,
and other enabled dependencies. See mpv's `README.md` and `meson_options.txt` at
the exact commit for the authoritative options.

## Use a replacement DLL

Stop Triboon, back up the installed `libmpv-2.dll`, place an ABI-compatible x64
replacement at the same path, and restart the application. Triboon performs no
signature or checksum enforcement on the installed replacement. Keep the
replacement's own notices, ensure its codec/profile support matches the media
you intend to play, and install every runtime DLL that replacement imports.
Reinstalling or upgrading Triboon restores the DLL shipped by that release.
