#!/usr/bin/env bash
# Reproducible build of stonkfolio-distributor, done the way
# `solana-verify build --library-name stonkfolio_distributor` does it:
#   - the Solana Foundation's verifiable-build image, pinned by digest, for the
#     Solana version in the root Cargo.toml's [workspace.metadata.cli] (which
#     solana-verify reads before Cargo.lock)
#   - a clean checkout of one commit, mounted at the image's workdir
#   - `cargo build-sbf -- --locked` in the program's directory, on the image's
#     active toolchain
#
# It prints the executable hash (sha256 with trailing zero bytes stripped). That
# is the value `solana-verify get-program-hash -u <cluster> <program id>` reports
# for a deployed program, so the two must match.
#
#   scripts/verifiable-build.sh <commit> [work dir]
#
# Works on Windows (Git Bash + Docker Desktop), where solana-verify itself
# doesn't compile, as well as on Linux and macOS.
set -euo pipefail

COMMIT=${1:?usage: scripts/verifiable-build.sh <commit> [work dir]}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${2:-"$REPO/.verifiable-build"}
# solana-verify's IMAGE_MAP entry for Solana 2.2.20 (src/image_config.rs).
IMAGE="solanafoundation/solana-verifiable-build@sha256:a1c0d5899ee0ffc81412428760662d9ba4643c2003ec3a92ab6f75a6e2e52a1b"
EXPECTED_SOLANA=2.2.20
# Only docker gets MSYS_NO_PATHCONV=1 (so Git Bash leaves container paths like /build
# alone); git needs the usual conversion of this script's own /c/... paths.
dockerx() { MSYS_NO_PATHCONV=1 docker "$@"; }

solana=$(git -C "$REPO" show "$COMMIT:Cargo.toml" | sed -n '/^\[workspace\.metadata\.cli\]/,/^\[/s/^solana = "\(.*\)"$/\1/p' | head -1)
if [ "$solana" != "$EXPECTED_SOLANA" ]; then
  echo "Cargo.toml at $COMMIT sets [workspace.metadata.cli] solana = \"$solana\"; this script's image is for $EXPECTED_SOLANA" >&2
  exit 1
fi

src="$WORK/src"
rm -rf "$src"
mkdir -p "$WORK"
git clone -q "$REPO" "$src"
git -C "$src" checkout -q "$COMMIT"
host_src=$(cygpath -m "$src" 2>/dev/null || echo "$src")

workdir=$(dockerx run --rm "$IMAGE" pwd | tr -d '\r')
container=$(dockerx run --rm -v "$host_src:$workdir" -dit "$IMAGE" bash | tr -d '\r')
trap 'dockerx kill "$container" >/dev/null 2>&1 || true' EXIT
toolchain=$(dockerx exec -w / "$container" rustup show active-toolchain | awk '{print $1}' | tr -d '\r')
dockerx exec -e RUSTUP_TOOLCHAIN="$toolchain" -w "$workdir/programs/stonkfolio-distributor" "$container" \
  cargo build-sbf -- --config 'registries.crates-io.protocol="sparse"' --locked

so="$src/target/deploy/stonkfolio_distributor.so"
hash=$(node -e '
  const b = require("fs").readFileSync(process.argv[1]);
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  console.log(require("crypto").createHash("sha256").update(b.subarray(0, n)).digest("hex"));
' "$so")
echo "commit:          $(git -C "$src" rev-parse HEAD)"
echo "image:           $IMAGE (toolchain $toolchain)"
echo "program:         $so ($(wc -c < "$so") bytes)"
echo "executable hash: $hash"
