---
title: Building the Python wheels
source_kind: runbook
origin_class: owner
generated_at: "2026-07-09T18:15:00Z"
tags: [tidepool, python, wheels, build, rust]
---
# Building the Python wheels

The `tidepool` package on PyPI is the Rust core compiled with PyO3 and packaged by maturin.

## What we ship

One abi3 wheel per platform, good for CPython 3.9 and later:

- `manylinux_2_28` x86_64 and aarch64
- `musllinux_1_2` x86_64
- macOS `universal2`, minimum 11.0
- Windows x86_64

Plus an sdist. There are no Windows arm64 or 32-bit wheels; those users build from the sdist.

## Local build

```
cd bindings/python
maturin develop --release
pytest tests
```

## CI

`.github/workflows/wheels.yml` builds the matrix with `PyO3/maturin-action` on every tag and nightly on `main`. The
nightly wheels go to the workflow's artifacts only, never to PyPI.

## Things that have bitten us

- **Debug builds are about 40 times slower.** `maturin develop` without `--release` builds a debug core. The API logs
  `tidepool built without optimisations` at startup when `tidepool.build_info()["profile"]` is `debug`; if predictions
  feel slow on a laptop, look for that line first.
- **The `python` feature.** The PyO3 glue in `crates/tidepool-core` sits behind the crate's `python` feature.
  `bindings/python/Cargo.toml` turns it on; building the core directly with maturin fails with
  ``use of undeclared crate or module `pyo3` ``.
- **The Rust version in the manylinux image.** It ships an older toolchain than the core needs. `rust-toolchain.toml`
  pins the version and maturin-action honours it; do not remove the file to silence a warning.
- **universal2 needs both targets.** Locally, `rustup target add aarch64-apple-darwin x86_64-apple-darwin` before
  `maturin build --target universal2-apple-darwin`.
- **The sdist must carry the core.** The bindings depend on the core by path, so `pyproject.toml` lists
  `crates/tidepool-core` under `[tool.maturin] include`. Without it, `pip install` from the sdist fails on a missing
  crate.
