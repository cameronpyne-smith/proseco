#!/usr/bin/env bash
set -euo pipefail
umask 022

NODE_VERSION="v24.22.1"
REPO_URL="https://github.com/cameronpyne-smith/proseco.git"
SERVICE_USER="proseco"
SERVICE_HOME="/var/lib/proseco-home"
OPT_DIR="/opt/proseco"
APP_DIR="$OPT_DIR/app"
NODE_DIR="$OPT_DIR/node"
ETC_DIR="/etc/proseco"
UNIT_NAME="proseco-fixer"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"
DROPIN_PATH="/etc/systemd/system/$UNIT_NAME.service.d/docker.conf"
SUBID_FLOOR=100000
SUBID_COUNT=65536
BUS_WAIT_SECONDS=60

DRY_RUN=0
COMMIT=""
APP_MOVED=0
UNIT_CHANGED=0
CHECK_DIR=""
CHECK_FAILED=0
SERVICE_UID=""
RUNTIME_DIR=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: install.sh <commit sha, 40 hex characters> [--dry-run]" >&2
  exit 2
}

report() {
  local status=$2
  if ((DRY_RUN)) && [[ "$status" == done ]]; then
    status="would do"
  fi
  printf '[%s] %s: %s\n' "$1" "$status" "$3"
}

run() {
  if ((DRY_RUN)); then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

write_file() {
  local path=$1 mode=$2 content=$3
  if ((DRY_RUN)); then
    echo "+ write $path (mode $mode)"
    sed 's/^/+     /' <<<"$content"
  else
    install -d -m 0755 "$(dirname "$path")"
    printf '%s\n' "$content" >"$path"
    chmod "$mode" "$path"
  fi
}

append_line() {
  local path=$1 line=$2
  if ((DRY_RUN)); then
    echo "+ append to $path: $line"
  else
    echo "$line" >>"$path"
  fi
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found"
}

check_prerequisites() {
  local tool
  for tool in curl git sudo useradd loginctl systemctl sha256sum tar awk newuidmap newgidmap dockerd-rootless-setuptool.sh docker; do
    need_command "$tool"
  done
  if ((!DRY_RUN)) && ((EUID != 0)); then
    die "run as root: sudo $0 $COMMIT"
  fi
}

parse_arguments() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      --dry-run) DRY_RUN=1 ;;
      -*) usage ;;
      *)
        [[ -z "$COMMIT" ]] || usage
        COMMIT=$argument
        ;;
    esac
  done
  [[ -n "$COMMIT" ]] || usage
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the commit must be a full 40 character lowercase hex sha, not a branch, tag or abbreviation: $COMMIT"
}

resolve_service_ids() {
  if ! SERVICE_UID=$(id -u "$SERVICE_USER" 2>/dev/null); then
    SERVICE_UID="UID_OF_${SERVICE_USER^^}"
  fi
  RUNTIME_DIR="/run/user/$SERVICE_UID"
}

as_service() {
  run sudo -u "$SERVICE_USER" env "HOME=$SERVICE_HOME" "XDG_RUNTIME_DIR=$RUNTIME_DIR" "DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME_DIR/bus" "$@"
}

node_arch() {
  case "$(uname -m)" in
    x86_64) echo x64 ;;
    aarch64) echo arm64 ;;
    *) die "no Node build for architecture $(uname -m)" ;;
  esac
}

fetch_node_tarball() {
  local dir=$1
  local base="https://nodejs.org/dist/$NODE_VERSION"
  local file="node-$NODE_VERSION-linux-$(node_arch).tar.gz"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$dir/$file" "$base/$file"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$dir/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$dir" && awk -v file="$file" '$2 == file' SHASUMS256.txt | sha256sum --check --status) || die "checksum of $file does not match $base/SHASUMS256.txt"
  echo "$dir/$file"
}

install_node() {
  local current
  current=$("$NODE_DIR/bin/node" --version 2>/dev/null || true)
  if [[ "$current" == "$NODE_VERSION" ]]; then
    report node already "$NODE_DIR is $current"
    return
  fi
  if ((DRY_RUN)); then
    echo "+ download node-$NODE_VERSION-linux-$(node_arch).tar.gz and SHASUMS256.txt from https://nodejs.org/dist/$NODE_VERSION, verify the checksum"
    echo "+ extract into $NODE_DIR"
    report node done "install $NODE_VERSION at $NODE_DIR (found ${current:-none})"
    return
  fi
  local dir tarball
  dir=$(mktemp -d)
  tarball=$(fetch_node_tarball "$dir")
  install -d -m 0755 "$OPT_DIR" "$NODE_DIR.new"
  tar -xzf "$tarball" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$dir"
  [[ "$("$NODE_DIR/bin/node" --version)" == "$NODE_VERSION" ]] || die "$NODE_DIR/bin/node is not $NODE_VERSION after extraction"
  report node done "installed $NODE_VERSION at $NODE_DIR"
}

checkout_app() {
  local current
  current=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)
  if [[ "$current" == "$COMMIT" ]]; then
    report app already "$APP_DIR is at $COMMIT"
    return
  fi
  if [[ -d "$APP_DIR/.git" ]]; then
    run git -C "$APP_DIR" fetch --quiet --tags origin
  else
    run install -d -m 0755 "$OPT_DIR"
    run git clone --quiet --no-checkout "$REPO_URL" "$APP_DIR"
  fi
  if ((!DRY_RUN)); then
    git -C "$APP_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null || die "commit $COMMIT is not in $REPO_URL"
  fi
  run git -C "$APP_DIR" checkout --quiet --detach "$COMMIT"
  APP_MOVED=1
  report app done "$APP_DIR moved from ${current:-nothing} to $COMMIT"
}

ensure_subid_range() {
  local file=$1 start
  if grep -q "^$SERVICE_USER:" "$file" 2>/dev/null; then
    report "$(basename "$file")" already "$SERVICE_USER has a range"
    return
  fi
  start=$SUBID_FLOOR
  if [[ -f "$file" ]]; then
    start=$(awk -F: -v floor="$SUBID_FLOOR" 'BEGIN { top = floor } { end = $2 + $3; if (end > top) top = end } END { print top }' "$file")
  fi
  append_line "$file" "$SERVICE_USER:$start:$SUBID_COUNT"
  report "$(basename "$file")" done "$SERVICE_USER:$start:$SUBID_COUNT"
}

ensure_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    report user already "$SERVICE_USER exists"
  else
    run useradd --system --user-group --create-home --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
    report user done "created $SERVICE_USER with home $SERVICE_HOME"
  fi
  resolve_service_ids
  ensure_subid_range /etc/subuid
  ensure_subid_range /etc/subgid
}

ensure_linger() {
  if [[ -f "/var/lib/systemd/linger/$SERVICE_USER" ]]; then
    report linger already "enabled for $SERVICE_USER"
    return
  fi
  run loginctl enable-linger "$SERVICE_USER"
  report linger done "enabled for $SERVICE_USER"
}

wait_for_path() {
  local test_flag=$1 path=$2 waited=0
  if ((DRY_RUN)); then
    echo "+ wait up to ${BUS_WAIT_SECONDS}s for $path"
    return
  fi
  until test "$test_flag" "$path"; do
    ((waited >= BUS_WAIT_SECONDS)) && die "$path did not appear within ${BUS_WAIT_SECONDS}s"
    sleep 1
    waited=$((waited + 1))
  done
}

ensure_rootless_docker() {
  if [[ -S "$RUNTIME_DIR/docker.sock" ]]; then
    report docker already "rootless daemon socket at $RUNTIME_DIR/docker.sock"
    return
  fi
  wait_for_path -S "$RUNTIME_DIR/bus"
  as_service dockerd-rootless-setuptool.sh install
  as_service systemctl --user enable --now docker
  wait_for_path -S "$RUNTIME_DIR/docker.sock"
  report docker done "rootless docker enabled for $SERVICE_USER"
}

install_config_file() {
  local name=$1 example=$2
  if [[ -f "$ETC_DIR/$name" ]]; then
    report "$name" already "$ETC_DIR/$name is kept as it is"
    return
  fi
  run install -d -m 0755 "$ETC_DIR"
  run install -m 0644 -o root -g root "$APP_DIR/deploy/$example" "$ETC_DIR/$name"
  report "$name" done "created $ETC_DIR/$name from deploy/$example"
}

install_unit_file() {
  local source="$APP_DIR/deploy/$UNIT_NAME.service"
  if ((!DRY_RUN)) && [[ ! -f "$source" ]]; then
    die "$COMMIT has no deploy/$UNIT_NAME.service"
  fi
  if [[ -f "$UNIT_PATH" ]] && cmp -s "$source" "$UNIT_PATH"; then
    report unit already "$UNIT_PATH"
  else
    run install -m 0644 -o root -g root "$source" "$UNIT_PATH"
    UNIT_CHANGED=1
    report unit done "installed $UNIT_PATH"
  fi
  local dropin
  dropin=$(printf '[Service]\nEnvironment=DOCKER_HOST=unix://%s/docker.sock' "$RUNTIME_DIR")
  if [[ -f "$DROPIN_PATH" ]] && [[ "$(cat "$DROPIN_PATH")" == "$dropin" ]]; then
    report drop-in already "$DROPIN_PATH"
  else
    write_file "$DROPIN_PATH" 0644 "$dropin"
    UNIT_CHANGED=1
    report drop-in done "wrote $DROPIN_PATH"
  fi
}

reload_systemd() {
  if ((UNIT_CHANGED)); then
    run systemctl daemon-reload
    report systemd done "daemon-reload"
  else
    report systemd already "units unchanged, no reload needed"
  fi
}

restart_if_moved() {
  local active=0
  systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null && active=1
  if ((APP_MOVED && active)); then
    run systemctl restart "$UNIT_NAME"
    report service done "restarted $UNIT_NAME because the checkout moved"
  elif ((APP_MOVED)); then
    report service already "$UNIT_NAME is not running, nothing to restart"
  elif ((UNIT_CHANGED && active)); then
    report service already "$UNIT_NAME runs with the old unit, restart it to apply the change"
  else
    report service already "no restart needed"
  fi
}

cleanup_check_dir() {
  [[ -z "$CHECK_DIR" ]] || rm -rf "$CHECK_DIR"
}

run_fixer_check() {
  if [[ ! -f "$ETC_DIR/private-key.pem" ]]; then
    report check skipped "$ETC_DIR/private-key.pem is absent; copy the key, then run the check by hand (see below)"
    return
  fi
  local credentials="<temporary credentials directory>"
  if ((!DRY_RUN)); then
    CHECK_DIR=$(mktemp -d)
    trap cleanup_check_dir EXIT
    credentials=$CHECK_DIR
  fi
  run install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$credentials"
  run install -m 0400 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ETC_DIR/private-key.pem" "$credentials/private-key"
  echo "running the fixer's own check as $SERVICE_USER"
  if ! (
    cd "$APP_DIR" 2>/dev/null || cd /
    run sudo -u "$SERVICE_USER" env \
      "HOME=$SERVICE_HOME" \
      "PROSECO_CONFIG=$ETC_DIR/config.json" \
      "PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
      "DOCKER_HOST=unix://$RUNTIME_DIR/docker.sock" \
      "CREDENTIALS_DIRECTORY=$credentials" \
      "$NODE_DIR/bin/node" "$APP_DIR/src/fixer/main.ts" check
  ); then
    CHECK_FAILED=1
  fi
  cleanup_check_dir
  CHECK_DIR=""
  if ((CHECK_FAILED)); then
    report check FAILED "see the output above; fix it and run the check again"
  else
    report check done "check ran as $SERVICE_USER and exited 0"
  fi
}

print_next_steps() {
  cat <<NEXT

Left for you:
  1. Copy the GitHub App private key (root only), if not done:
       sudo install -m 0600 -o root -g root /path/to/private-key.pem $ETC_DIR/private-key.pem
  2. Edit the config and the image routing file for your organisation:
       sudoedit $ETC_DIR/config.json $ETC_DIR/image-repos.json
  3. Start the service and watch it:
       sudo systemctl enable --now $UNIT_NAME
       journalctl -fu $UNIT_NAME
NEXT
}

main() {
  parse_arguments "$@"
  cd /
  check_prerequisites
  resolve_service_ids
  ((DRY_RUN)) && echo "dry run: commands are printed with a leading +, nothing is changed"
  install_node
  checkout_app
  ensure_user
  ensure_linger
  ensure_rootless_docker
  install_config_file config.json config.example.json
  install_config_file image-repos.json image-repos.example.json
  install_unit_file
  reload_systemd
  restart_if_moved
  run_fixer_check
  print_next_steps
  ((!CHECK_FAILED)) || exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
