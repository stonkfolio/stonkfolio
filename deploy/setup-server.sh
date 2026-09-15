#!/usr/bin/env bash
# Sets up a fresh Ubuntu server (24.04 or 26.04) to run the Stonkfolio keeper,
# matching deploy/stonkfolio-keeper.service.
#
# From your PC, in the stonkfolio repo, after committing:
#   git bundle create stonkfolio.bundle HEAD
#   scp stonkfolio.bundle deploy/setup-server.sh <user>@<server-ip>:/tmp/
#   ssh <user>@<server-ip>
# Then on the server:
#   sudo bash /tmp/setup-server.sh base        # updates, firewall, SSH, Node, code, keys
#   (add the printed deploy key to the round-records repo, with write access)
#   sudo bash /tmp/setup-server.sh artifacts   # clone the round-records repo
#   (fill in /etc/stonkfolio/keeper.env)
#
# The keeper service is installed but not started: it starts at launch, once
# the pool and deployment file exist. Safe to re-run; it never prints secrets.
set -euo pipefail

ARTIFACTS_REPO="git@github.com:stonkfolio/stonkfolio-artifacts.git"
ARTIFACTS_BRANCH=main
NODE_MAJOR=22
BUNDLE=/tmp/stonkfolio.bundle
APP=/opt/stonkfolio
ARTIFACTS=/opt/stonkfolio-artifacts
ETC=/etc/stonkfolio
SERVICE_USER=stonkfolio

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script expects Ubuntu (found ${ID:-unknown})"
LOGIN_USER=${SUDO_USER:-}

base() {
  say "system updates and packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get upgrade -yq
  apt-get install -yq git curl ca-certificates xz-utils ufw unattended-upgrades jq gnupg openssh-client

  say "automatic security updates"
  dpkg-reconfigure -f noninteractive unattended-upgrades

  say "firewall: only SSH comes in"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw --force enable

  say "SSH: key login only"
  local login_home=""
  [ -n "$LOGIN_USER" ] && login_home=$(getent passwd "$LOGIN_USER" | cut -d: -f6)
  if [ -n "$LOGIN_USER" ] && [ "$LOGIN_USER" != root ] && [ -s "$login_home/.ssh/authorized_keys" ]; then
    # 10- sorts before cloud images' 50-cloud-init.conf, and sshd keeps the first value it reads.
    cat > /etc/ssh/sshd_config.d/10-stonkfolio.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl restart ssh
      echo "password and root login are off; your key for $LOGIN_USER still works"
    else
      rm -f /etc/ssh/sshd_config.d/10-stonkfolio.conf
      die "the SSH config didn't validate; left SSH unchanged"
    fi
  else
    echo "WARNING: no SSH key found for ${LOGIN_USER:-this user} (or logged in as root)."
    echo "Password login is left ON so you aren't locked out. Add your key with ssh-copy-id, log in as a normal user, and re-run this step."
  fi

  say "Node.js $NODE_MAJOR (official build, checksum checked)"
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
    local arch narch tmp file
    arch=$(dpkg --print-architecture)
    case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) die "unsupported architecture $arch" ;; esac
    tmp=$(mktemp -d)
    # Both files come from nodejs.org over HTTPS; the checksum catches a corrupted download.
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    file=$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${narch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
    [ -n "$file" ] || die "couldn't find a Node $NODE_MAJOR build for $narch"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$file" -o "$tmp/$file"
    (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c -)
    rm -rf /usr/local/lib/nodejs
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs --strip-components=1
    for bin in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$bin" "/usr/bin/$bin"; done
    rm -rf "$tmp"
  fi
  node --version

  say "service user"
  id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"

  say "keeper code from $BUNDLE"
  [ -f "$BUNDLE" ] || die "$BUNDLE not found; copy stonkfolio.bundle from your PC first"
  mkdir -p "$APP"
  [ -d "$APP/.git" ] || git -C "$APP" init -q
  # git can only verify a bundle from inside a repository.
  git -C "$APP" bundle verify -q "$BUNDLE" || die "$BUNDLE is damaged; copy it again from your PC"
  git -C "$APP" fetch -q "$BUNDLE" HEAD
  git -C "$APP" checkout -q --detach --force FETCH_HEAD
  echo "commit $(git -C "$APP" rev-parse --short HEAD): $(git -C "$APP" log -1 --format=%s)"

  say "installing dependencies and building"
  cd "$APP"
  npm ci --ignore-scripts --no-audit --no-fund
  # Keeper, lib and launch scripts only: the validator tests need target/ from a local anchor build.
  npx tsc -p tsconfig.keeper.json
  # Launch scripts run as the service user and write deployments/mainnet.json here.
  chown "$SERVICE_USER:$SERVICE_USER" "$APP/deployments"

  say "settings folder $ETC"
  install -d -m 750 -o root -g "$SERVICE_USER" "$ETC"
  if [ ! -f "$ETC/keeper.env" ]; then
    install -m 640 -o root -g "$SERVICE_USER" "$APP/deploy/keeper.env.example" "$ETC/keeper.env"
    echo "created $ETC/keeper.env from the example; fill it in before launch"
  fi

  say "keeper wallet key"
  if [ ! -f "$ETC/keeper.json" ]; then
    (cd "$APP" && node -e '
      const { Keypair } = require("@solana/web3.js");
      const key = Keypair.generate();
      require("fs").writeFileSync(process.argv[1], JSON.stringify(Array.from(key.secretKey)), { mode: 0o600, flag: "wx" });
    ' "$ETC/keeper.json")
    echo "created a new keeper key"
  fi
  chown "$SERVICE_USER:$SERVICE_USER" "$ETC/keeper.json"
  chmod 600 "$ETC/keeper.json"
  local keeper_address
  keeper_address=$(cd "$APP" && node -e '
    const { Keypair } = require("@solana/web3.js");
    const bytes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    console.log(Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58());
  ' "$ETC/keeper.json")

  say "deploy key for the round-records repo"
  if [ ! -f "$ETC/artifacts_deploy_key" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "stonkfolio-keeper@$(hostname)" -f "$ETC/artifacts_deploy_key"
  fi
  chown "$SERVICE_USER:$SERVICE_USER" "$ETC/artifacts_deploy_key" "$ETC/artifacts_deploy_key.pub"
  chmod 600 "$ETC/artifacts_deploy_key"
  # GitHub's SSH host keys, fetched over HTTPS so the first connection isn't blind trust.
  curl -fsSL https://api.github.com/meta | jq -r '.ssh_keys[]' | sed 's/^/github.com /' > "$ETC/known_hosts"
  chmod 644 "$ETC/known_hosts"

  say "keeper service (installed, not started)"
  install -m 644 "$APP/deploy/stonkfolio-keeper.service" /etc/systemd/system/stonkfolio-keeper.service
  systemctl daemon-reload

  cat <<EOF

================================================================
Base setup done.

Keeper address (the fee claimer; fund it before launch):
  $keeper_address

1) Add this deploy key to github.com/stonkfolio/stonkfolio-artifacts
   (Settings -> Deploy keys -> Add deploy key, tick "Allow write access"):

$(cat "$ETC/artifacts_deploy_key.pub")

   Then run:  sudo bash /tmp/setup-server.sh artifacts

2) Back up the keeper key, encrypted, off this server. It is the fee
   claimer and can never be replaced, so losing it loses fee income.
   As ${LOGIN_USER:-your user} (not root), encrypt it with a passphrase you choose:
     sudo cat $ETC/keeper.json | gpg --symmetric --cipher-algo AES256 --pinentry-mode loopback -o ~/keeper-key.gpg
   Check the backup decrypts to the same key:
     gpg --pinentry-mode loopback --decrypt ~/keeper-key.gpg | sudo cmp - $ETC/keeper.json && echo "backup OK"
   Copy ~/keeper-key.gpg to your PC with scp, keep it in two places, then: rm ~/keeper-key.gpg
   Keep the passphrase in a password manager.

3) Fill in $ETC/keeper.env (sudo nano $ETC/keeper.env).
================================================================
EOF
}

artifacts() {
  [ -f "$ETC/artifacts_deploy_key" ] || die "run the base step first"
  local ssh_cmd="ssh -i $ETC/artifacts_deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$ETC/known_hosts -o StrictHostKeyChecking=yes"

  say "checking the deploy key with GitHub"
  local reply
  reply=$(sudo -u "$SERVICE_USER" env HOME=/nonexistent $ssh_cmd -T git@github.com 2>&1 || true)
  echo "$reply" | grep -q "successfully authenticated" || die "GitHub didn't accept the deploy key: $reply"
  echo "$reply" | head -1

  say "cloning the round-records repo into $ARTIFACTS"
  install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ARTIFACTS"
  if [ ! -d "$ARTIFACTS/.git" ]; then
    sudo -u "$SERVICE_USER" env HOME=/nonexistent GIT_SSH_COMMAND="$ssh_cmd" git clone -q "$ARTIFACTS_REPO" "$ARTIFACTS"
  fi
  local git_as=(sudo -u "$SERVICE_USER" env HOME=/nonexistent git -C "$ARTIFACTS")
  "${git_as[@]}" config core.sshCommand "$ssh_cmd"
  "${git_as[@]}" config user.name "Stonkfolio keeper"
  "${git_as[@]}" config user.email "keeper@stonkfolio.invalid"
  # An empty clone starts on git's default branch name; publish to the repo's main branch.
  if ! "${git_as[@]}" rev-parse -q --verify HEAD >/dev/null; then
    "${git_as[@]}" symbolic-ref HEAD "refs/heads/$ARTIFACTS_BRANCH"
  fi
  echo "ready: the keeper publishes round records to $ARTIFACTS_REPO ($ARTIFACTS_BRANCH)"
}

case "${1:-}" in
  base) base ;;
  artifacts) artifacts ;;
  *) echo "usage: sudo bash setup-server.sh base|artifacts" >&2; exit 2 ;;
esac
