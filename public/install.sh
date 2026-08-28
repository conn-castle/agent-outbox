#!/bin/sh

set -eu

repository_url="https://github.com/conn-castle/agent-outbox"

if ! command -v curl >/dev/null 2>&1; then
  echo "agent-outbox installer requires curl." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "agent-outbox installer requires tar." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) target_os="darwin" ;;
  Linux) target_os="linux" ;;
  *)
    echo "agent-outbox supports macOS and Linux." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) target_arch="amd64" ;;
  arm64 | aarch64) target_arch="arm64" ;;
  *)
    echo "agent-outbox supports amd64 and arm64 processors." >&2
    exit 1
    ;;
esac

release_tag="${AGENT_OUTBOX_VERSION:-}"
if [ -z "$release_tag" ]; then
  latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$repository_url/releases/latest")"
  release_tag="${latest_url##*/}"
fi
case "$release_tag" in
  v*) release_version="${release_tag#v}" ;;
  *)
    release_version="$release_tag"
    release_tag="v$release_tag"
    ;;
esac
if [ -z "$release_version" ]; then
  echo "could not determine the latest agent-outbox release." >&2
  exit 1
fi

asset="agent-outbox_${release_version}_${target_os}_${target_arch}.tar.gz"
release_url="$repository_url/releases/download/$release_tag"
temporary_dir="$(mktemp -d)"
temporary_binary=""
cleanup() {
  rm -rf "$temporary_dir"
  if [ -n "$temporary_binary" ]; then
    rm -f "$temporary_binary"
  fi
}
trap cleanup EXIT HUP INT TERM

curl -fsSL "$release_url/$asset" -o "$temporary_dir/$asset"
curl -fsSL "$release_url/checksums.txt" -o "$temporary_dir/checksums.txt"

expected_checksum="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' "$temporary_dir/checksums.txt")"
if [ -z "$expected_checksum" ]; then
  echo "release checksum is missing for $asset." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$temporary_dir/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$temporary_dir/$asset" | awk '{print $1}')"
elif command -v openssl >/dev/null 2>&1; then
  actual_checksum="$(openssl dgst -sha256 "$temporary_dir/$asset" | awk '{print $NF}')"
else
  echo "agent-outbox installer requires sha256sum, shasum, or openssl to verify the download." >&2
  exit 1
fi
if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "checksum verification failed for $asset." >&2
  exit 1
fi

tar -xzf "$temporary_dir/$asset" -C "$temporary_dir"
if [ ! -f "$temporary_dir/agent-outbox" ]; then
  echo "release archive did not contain the agent-outbox binary." >&2
  exit 1
fi

install_dir="${AGENT_OUTBOX_INSTALL_DIR:-${HOME:-}/.local/bin}"
if [ -z "$install_dir" ] || [ "$install_dir" = "/.local/bin" ]; then
  echo "set HOME or AGENT_OUTBOX_INSTALL_DIR to choose an installation directory." >&2
  exit 1
fi
mkdir -p "$install_dir"
temporary_binary="$(mktemp "$install_dir/.agent-outbox-install.XXXXXX")"
cp "$temporary_dir/agent-outbox" "$temporary_binary"
chmod 755 "$temporary_binary"
mv -f "$temporary_binary" "$install_dir/agent-outbox"

echo "Installed agent-outbox $release_tag to $install_dir/agent-outbox"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH to run agent-outbox from any directory." ;;
esac
