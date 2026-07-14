#!/usr/bin/env bash
set -euo pipefail

bundle_root="${1:-src-tauri/target/release/bundle}"
expected_arch="${2:-}"
expected_version="${3:-}"
if [[ -z "$expected_version" ]] && command -v node >/dev/null 2>&1 && [[ -f package.json ]]; then
  expected_version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
fi
audit_root="$(mktemp -d)"
trap 'rm -rf "$audit_root"' EXIT

find_one() {
  local directory="$1"
  local pattern="$2"
  local candidate
  local matches=()
  while IFS= read -r -d '' candidate; do
    if [[ -z "$expected_version" || "$(basename "$candidate")" == *"$expected_version"* ]]; then
      matches+=("$candidate")
    fi
  done < <(find "$directory" -maxdepth 1 -type f -name "$pattern" -print0)
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one $pattern for version ${expected_version:-unknown} under $directory, found ${#matches[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

assert_no_missing_libraries() {
  local executable="$1"
  local report="$2"
  ldd "$executable" | tee "$report"
  if grep -q 'not found' "$report"; then
    echo "Unresolved shared libraries in $executable" >&2
    exit 1
  fi
}

assert_bundled_library() {
  local report="$1"
  local soname="$2"
  local appdir="$3"
  if ! grep -F "$soname => $appdir/" "$report" >/dev/null; then
    echo "$soname is not resolved from inside the AppImage" >&2
    exit 1
  fi
}

assert_sidecar() {
  local sidecar="$1"
  test -x "$sidecar"
  file "$sidecar" | grep -q 'statically linked'
  "$sidecar" --version
}

assert_binary_architecture() {
  local executable="$1"
  local description
  [[ -z "$expected_arch" ]] && return
  description="$(file "$executable")"
  case "$expected_arch" in
    amd64) grep -q 'x86-64' <<<"$description" ;;
    arm64) grep -Eq 'aarch64|ARM64' <<<"$description" ;;
    *) echo "Unsupported expected architecture: $expected_arch" >&2; exit 1 ;;
  esac
}

appimage="$(readlink -f "$(find_one "$bundle_root/appimage" '*.AppImage')")"
deb="$(readlink -f "$(find_one "$bundle_root/deb" '*.deb')")"
rpm="$(readlink -f "$(find_one "$bundle_root/rpm" '*.rpm')")"

chmod +x "$appimage"
mkdir "$audit_root/appimage"
(
  cd "$audit_root/appimage"
  "$appimage" --appimage-extract >/dev/null
)
appimage_main="$audit_root/appimage/squashfs-root/usr/bin/starhub"
appimage_sidecar="$audit_root/appimage/squashfs-root/usr/bin/starhub-sidecar"
test -x "$appimage_main"
assert_sidecar "$appimage_sidecar"
assert_binary_architecture "$appimage_main"
assert_binary_architecture "$appimage_sidecar"
assert_no_missing_libraries "$appimage_main" "$audit_root/appimage-ldd.txt"
assert_bundled_library "$audit_root/appimage-ldd.txt" "libwebkit2gtk-4.1.so.0" "$audit_root/appimage/squashfs-root"
assert_bundled_library "$audit_root/appimage-ldd.txt" "libgtk-3.so.0" "$audit_root/appimage/squashfs-root"

mkdir "$audit_root/deb"
dpkg-deb -x "$deb" "$audit_root/deb"
deb_main="$audit_root/deb/usr/bin/starhub"
deb_sidecar="$audit_root/deb/usr/bin/starhub-sidecar"
test -x "$deb_main"
assert_sidecar "$deb_sidecar"
assert_binary_architecture "$deb_main"
assert_binary_architecture "$deb_sidecar"
assert_no_missing_libraries "$deb_main" "$audit_root/deb-ldd.txt"
deb_dependencies="$(dpkg-deb -f "$deb" Depends)"
[[ -z "$expected_version" || "$(dpkg-deb -f "$deb" Version)" == "$expected_version" ]]
grep -q 'libwebkit2gtk-4.1-0' <<<"$deb_dependencies"
grep -q 'libgtk-3-0' <<<"$deb_dependencies"
grep -Eq 'lib(appindicator3|ayatana-appindicator3)-1' <<<"$deb_dependencies"

if [[ -n "$expected_arch" ]]; then
  actual_deb_arch="$(dpkg-deb -f "$deb" Architecture)"
  if [[ "$actual_deb_arch" != "$expected_arch" ]]; then
    echo "Expected DEB architecture $expected_arch, got $actual_deb_arch" >&2
    exit 1
  fi
fi

mkdir "$audit_root/rpm"
(
  cd "$audit_root/rpm"
  rpm2cpio "$rpm" | cpio -idm --quiet
)
rpm_main="$audit_root/rpm/usr/bin/starhub"
rpm_sidecar="$audit_root/rpm/usr/bin/starhub-sidecar"
test -x "$rpm_main"
assert_sidecar "$rpm_sidecar"
assert_binary_architecture "$rpm_main"
assert_binary_architecture "$rpm_sidecar"
assert_no_missing_libraries "$rpm_main" "$audit_root/rpm-ldd.txt"
rpm_dependencies="$(rpm -qpR "$rpm")"
[[ -z "$expected_version" || "$(rpm -qp --queryformat '%{VERSION}' "$rpm")" == "$expected_version" ]]
grep -q 'libwebkit2gtk-4.1.so.0' <<<"$rpm_dependencies"
grep -q 'libgtk-3.so.0' <<<"$rpm_dependencies"
if [[ -n "$expected_arch" ]]; then
  expected_rpm_arch="$([[ "$expected_arch" == 'amd64' ]] && printf 'x86_64' || printf 'aarch64')"
  actual_rpm_arch="$(rpm -qp --queryformat '%{ARCH}' "$rpm")"
  if [[ "$actual_rpm_arch" != "$expected_rpm_arch" ]]; then
    echo "Expected RPM architecture $expected_rpm_arch, got $actual_rpm_arch" >&2
    exit 1
  fi
fi

printf 'Verified AppImage, DEB and RPM bundles under %s\n' "$bundle_root"
