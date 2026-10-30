#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  VPS Bot — One-command installer & manager for Ubuntu                ║
# ║                                                                      ║
# ║  bash <(curl -Ls https://raw.githubusercontent.com/OWNER/REPO/main/install.sh)
# ╚══════════════════════════════════════════════════════════════════════╝
#
# Optional environment overrides:
#   VPSBOT_REPO          GitHub "owner/repo" (or a full git URL)
#   VPSBOT_BRANCH        Branch to deploy (default: main)
#   VPSBOT_NPM_REGISTRY  npm registry mirror (useful on restricted networks)

set -uo pipefail
cd /tmp 2>/dev/null || true

# ───────────────────────────── Settings ─────────────────────────────
INSTALLER_VERSION="1.0.0"
DEFAULT_REPO="YOUR_GITHUB_USERNAME/vps-bot-next"   # ← replace with your own repo
APP_USER="vpsbot"
INSTALL_ROOT="/opt/vps-bot"
APP_DIR="$INSTALL_ROOT/app"
ENV_FILE="$APP_DIR/.env.local"
META_FILE="$INSTALL_ROOT/install.conf"
BACKUP_DIR="$INSTALL_ROOT/backups"
SERVICE="vpsbot"
BILLING="vpsbot-billing"
NGINX_CONF="/etc/nginx/sites-available/vpsbot.conf"
NGINX_LINK="/etc/nginx/sites-enabled/vpsbot.conf"
DB_NAME="vpsbot"
DB_USER="vpsbot"
LOG_FILE="/var/log/vpsbot-installer.log"
CMD_PATH="/usr/local/bin/vpsbot"

REPO="${VPSBOT_REPO:-$DEFAULT_REPO}"
BRANCH="${VPSBOT_BRANCH:-main}"
DOMAIN=""
PORT="3000"

# ───────────────────────────── Colors ─────────────────────────────
if [[ -t 1 ]]; then
  R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
  RED=$'\033[38;5;203m'; GRN=$'\033[38;5;78m'; YLW=$'\033[38;5;221m'
  BLU=$'\033[38;5;75m';  CYN=$'\033[38;5;87m'; MAG=$'\033[38;5;177m'; GRY=$'\033[38;5;244m'
else
  R=""; B=""; D=""; RED=""; GRN=""; YLW=""; BLU=""; CYN=""; MAG=""; GRY=""
fi
SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

cleanup() { printf '\033[?25h'; }
trap cleanup EXIT
trap 'printf "\n"; echo "  ${YLW}Interrupted.${R}"; exit 130' INT TERM

# ───────────────────────────── UI helpers ─────────────────────────────
hr()   { printf "  ${GRY}%s${R}\n" "──────────────────────────────────────────────────────────────"; }
ok()   { printf "  ${GRN}✔${R} %s\n" "$*"; }
info() { printf "  ${BLU}ℹ${R} %s\n" "$*"; }
warn() { printf "  ${YLW}⚠${R} %s\n" "$*"; }
err()  { printf "  ${RED}✘${R} %s\n" "$*"; }
die()  { err "$*"; exit 1; }
pause() { printf "\n  ${D}Press Enter to continue…${R}"; read -r _ </dev/tty || true; }

banner() {
  clear 2>/dev/null || true
  printf "${CYN}${B}"
  cat <<'ART'

   __     ______  ____    ____   ___ _____
   \ \   / /  _ \/ ___|  | __ ) / _ \_   _|
    \ \ / /| |_) \___ \  |  _ \| | | || |
     \ V / |  __/ ___) | | |_) | |_| || |
      \_/  |_|   |____/  |____/ \___/ |_|
ART
  printf "${R}"
  printf "   ${MAG}Telegram VPS Seller${R} ${GRY}•${R} ${D}Installer & Manager v%s${R}\n\n" "$INSTALLER_VERSION"
}

section() { printf "\n  ${B}${BLU}▌ %s${R}\n" "$*"; hr; }

# Runs a command in the background with a spinner; output goes to the log file.
run_step() {
  local msg="$1"; shift
  printf '\n──── %s ────\n' "$msg" >>"$LOG_FILE"
  ( set -e; "$@" ) >>"$LOG_FILE" 2>&1 &
  local pid=$! i=0
  printf '\033[?25l'
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYN}%s${R} %s" "${SPIN[i++ % 10]}" "$msg"
    sleep 0.1
  done
  wait "$pid"; local rc=$?
  printf '\r\033[K\033[?25h'
  if (( rc == 0 )); then
    ok "$msg"
  else
    err "$msg ${RED}(failed)${R}"
    printf "\n  ${D}Last log lines (%s):${R}\n" "$LOG_FILE"
    tail -n 12 "$LOG_FILE" | sed "s/^/    ${GRY}/;s/$/${R}/"
    return "$rc"
  fi
}

clean() { printf '%s' "$1" | tr -d '"$`\\\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; }

# prompt VAR "Label" "default" "regex" "hint"
prompt() {
  local __var="$1" label="$2" def="${3:-}" re="${4:-}" hint="${5:-Invalid value, try again.}" val
  [[ -r /dev/tty ]] || die "No interactive terminal available."
  while true; do
    if [[ -n "$def" ]]; then
      printf "  ${CYN}?${R} %s ${D}[%s]${R}: " "$label" "$def"
    else
      printf "  ${CYN}?${R} %s: " "$label"
    fi
    IFS= read -r val </dev/tty || exit 1
    val="$(clean "$val")"; val="${val:-$def}"
    if [[ -z "$re" || "$val" =~ $re ]]; then printf -v "$__var" '%s' "$val"; return; fi
    warn "$hint"
  done
}

confirm() { # confirm "Question" [default y|n]
  local def="${2:-y}" a hint="Y/n"; [[ "$def" == n ]] && hint="y/N"
  printf "  ${CYN}?${R} %s ${D}[%s]${R}: " "$1" "$hint"
  IFS= read -r a </dev/tty || exit 1
  a="${a:-$def}"; [[ "$a" =~ ^[Yy] ]]
}

# ───────────────────────────── System helpers ─────────────────────────────
need_root() { [[ $EUID -eq 0 ]] || die "Please run as root.  Try:  sudo -i   and then run the command again."; }

check_os() {
  [[ -f /etc/os-release ]] || die "Unsupported system."
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *ubuntu* && "${ID:-}" != "debian" ]]; then
    die "This installer supports Ubuntu (20.04 or newer). Detected: ${PRETTY_NAME:-unknown}"
  fi
  [[ "$(uname -m)" =~ ^(x86_64|aarch64)$ ]] || die "Unsupported CPU architecture: $(uname -m)"
}

is_installed() { [[ -f "$META_FILE" && -d "$APP_DIR/.git" ]]; }

load_meta() {
  [[ -f "$META_FILE" ]] || return 0
  # shellcheck disable=SC1090
  . "$META_FILE"
}

save_meta() {
  mkdir -p "$INSTALL_ROOT"
  cat >"$META_FILE" <<EOF
DOMAIN="$DOMAIN"
PORT="$PORT"
REPO="$REPO"
BRANCH="$BRANCH"
EOF
  chmod 600 "$META_FILE"
}

as_app() {
  runuser -u "$APP_USER" -- env HOME="$INSTALL_ROOT" NEXT_TELEMETRY_DISABLED=1 \
    ${VPSBOT_NPM_REGISTRY:+npm_config_registry="$VPSBOT_NPM_REGISTRY"} "$@"
}
app_run() { as_app bash -c "cd '$APP_DIR' && $*"; }

repo_url() {
  if [[ "$REPO" == *"://"* || "$REPO" == git@* ]]; then echo "$REPO"; else echo "https://github.com/${REPO}.git"; fi
}

env_get() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | sed 's/^"//;s/"$//'; }
env_set() {
  local k="$1" v; v="$(clean "$2")"
  local tmp; tmp="$(mktemp)"
  grep -v "^${k}=" "$ENV_FILE" >"$tmp" 2>/dev/null || true
  printf '%s="%s"\n' "$k" "$v" >>"$tmp"
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}

public_ip() { curl -4fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 6 https://ifconfig.me 2>/dev/null || true; }

port_in_use() { ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .; }

tg_api() { # tg_api METHOD  (uses BOT_TOKEN from .env.local)
  curl -fsS --max-time 15 "https://api.telegram.org/bot$(env_get BOT_TOKEN)/$1" 2>/dev/null
}

svc_state() {
  if ! is_installed; then echo "not installed"
  elif systemctl is-active --quiet "$SERVICE"; then echo "running"
  else echo "stopped"; fi
}

status_dot() {
  case "$(svc_state)" in
    running)         printf "${GRN}● running${R}" ;;
    stopped)         printf "${RED}● stopped${R}" ;;
    *)               printf "${GRY}○ not installed${R}" ;;
  esac
}

# ───────────────────────────── Install steps ─────────────────────────────
step_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=180 update -y
  apt-get -o DPkg::Lock::Timeout=180 install -y --no-install-recommends \
    curl ca-certificates gnupg git openssl nginx certbot python3-certbot-nginx \
    postgresql postgresql-contrib iproute2 dnsutils
}

step_node() {
  export DEBIAN_FRONTEND=noninteractive
  local major=0
  command -v node >/dev/null 2>&1 && major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major >= 20 )); then return 0; fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -o DPkg::Lock::Timeout=180 install -y nodejs
}

step_swap() {
  local mem_mb; mem_mb="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
  if (( mem_mb < 1800 )) && [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  return 0
}

step_user() {
  id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$INSTALL_ROOT" --shell /usr/sbin/nologin "$APP_USER"
  mkdir -p "$INSTALL_ROOT" "$BACKUP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$INSTALL_ROOT"
}

step_database() {
  systemctl enable --now postgresql
  local i
  for i in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
  if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}'"
  else
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}'"
  fi
  if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"
  fi
}

step_clone() {
  rm -rf "$APP_DIR"
  as_app git clone --depth 1 --branch "$BRANCH" "$(repo_url)" "$APP_DIR"
}

step_env() {
  umask 077
  cat >"$ENV_FILE" <<EOF
BOT_TOKEN="${BOT_TOKEN}"
WEBHOOK_SECRET="${WEBHOOK_SECRET}"
APP_URL="https://${DOMAIN}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
ADMIN_IDS="${ADMIN_IDS}"
SUPPORT_USERNAME="${SUPPORT}"
CARD_NUMBER="${CARD_NUMBER}"
CARD_OWNER="${CARD_OWNER}"
MIN_TOPUP="${MIN_TOPUP}"
MIN_BALANCE_TO_BUY="${MIN_BALANCE}"
REF_PERCENT="${REF_PERCENT}"
CRON_SECRET="${CRON_SECRET}"
VIRT_URL="${VIRT_URL}"
VIRT_API_KEY="${VIRT_API_KEY}"
VIRT_API_PASS="${VIRT_API_PASS}"
VIRT_INSECURE_TLS="${VIRT_INSECURE}"
VIRT_TYPE="kvm"
VIRT_OWNER_EMAIL="${VIRT_OWNER_EMAIL}"
VIRT_OWNER_PASS="${VIRT_OWNER_PASS}"
EOF
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

step_npm_install() { app_run "npm ci --no-audit --no-fund || npm install --no-audit --no-fund"; }
step_migrate()     { app_run "npm run migrate"; }
step_build()       { app_run "npm run build"; }

step_systemd() {
  local node_bin; node_bin="$(command -v node)"
  cat >"/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=VPS Telegram Bot (Next.js)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=${node_bin} ${APP_DIR}/node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${PORT}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  cat >"/etc/systemd/system/${BILLING}.service" <<EOF
[Unit]
Description=VPS Bot hourly billing tick
After=${SERVICE}.service

[Service]
Type=oneshot
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/curl -fsS -m 55 -H "Authorization: Bearer \${CRON_SECRET}" http://127.0.0.1:${PORT}/api/cron/billing
EOF

  cat >"/etc/systemd/system/${BILLING}.timer" <<EOF
[Unit]
Description=Run VPS Bot billing every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=1s
Unit=${BILLING}.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${SERVICE}.service" "${BILLING}.timer"
}

step_nginx() {
  cat >"$NGINX_CONF" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
EOF
  sed -i "s/__DOMAIN__/${DOMAIN}/g; s/__PORT__/${PORT}/g" "$NGINX_CONF"
  ln -sf "$NGINX_CONF" "$NGINX_LINK"
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
}

step_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
  return 0
}

step_ssl() {
  local mail_args=(--register-unsafely-without-email)
  [[ -n "${SSL_EMAIL:-}" ]] && mail_args=(-m "$SSL_EMAIL")
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${mail_args[@]}"
}

wait_for_app() {
  local i
  for i in $(seq 1 45); do
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/" && return 0
    sleep 1
  done
  return 1
}

step_webhook() {
  local out; out="$(app_run "npm run webhook" 2>&1)"
  echo "$out"
  grep -q '"ok":true' <<<"$out" || grep -q "ok: true" <<<"$out"
}

step_command() {
  local src="$APP_DIR/install.sh"
  [[ -f "$src" ]] || return 0
  install -m 0755 "$src" "${CMD_PATH}.new"
  mv -f "${CMD_PATH}.new" "$CMD_PATH"
}

step_virt_test() { app_run "npm run --silent virt:discover"; }

do_virt() {
  need_root
  is_installed || { err "Not installed."; return 1; }
  section "Virtualizor connection"
  app_run "npm run --silent virt:discover" || err "Connection failed. Check VIRT_URL / VIRT_API_KEY / VIRT_API_PASS."
  echo
  info "Define what users can buy from the bot (Telegram, as admin):"
  printf "    ${CYN}/addloc iran|🇮🇷 Iran|<serid>${R}\n    ${CYN}/addos u22|Ubuntu 22.04|<osid>${R}\n"
}

# ───────────────────────────── Install flow ─────────────────────────────
do_install() {
  need_root; check_os
  banner
  if is_installed; then
    warn "The bot is already installed."
    info "Use ${B}Update${R} to upgrade, or ${B}Uninstall${R} first to start over."
    return
  fi

  if [[ "$REPO" == *YOUR_GITHUB_USERNAME* ]]; then
    warn "No GitHub repository configured in this installer."
    prompt REPO "GitHub repository (owner/name)" "" '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' "Format: owner/repo"
  fi

  section "Configuration"
  info "Have your ${B}BotFather token${R}, your ${B}numeric Telegram ID${R} and a ${B}domain${R} (A-record → this server) ready."
  echo

  # Bot token (verified against Telegram when reachable)
  local bot_user="" code
  while true; do
    prompt BOT_TOKEN "Bot token" "" '^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$' "That doesn't look like a valid token (123456:ABC…)."
    code="$(curl -s -o /tmp/.vpsbot_getme -w '%{http_code}' --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" || true)"
    if [[ "$code" == "200" ]]; then
      bot_user="$(grep -o '"username":"[^"]*"' /tmp/.vpsbot_getme | head -1 | cut -d'"' -f4)"
      ok "Token accepted — bot: ${B}@${bot_user}${R}"; break
    elif [[ "$code" == "401" || "$code" == "404" ]]; then
      warn "Telegram rejected this token. Please check it."
    else
      warn "Could not reach Telegram to verify the token (network/proxy?). Continuing anyway."; break
    fi
  done
  rm -f /tmp/.vpsbot_getme

  prompt ADMIN_IDS "Admin numeric ID(s), comma separated" "" '^[0-9]+(,[0-9]+)*$' "Use digits only, e.g. 123456789 or 111,222."
  prompt DOMAIN "Domain name (e.g. bot.example.com)" "" '^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$' "Enter a valid domain name."
  DOMAIN="$(tr 'A-Z' 'a-z' <<<"$DOMAIN")"

  local sip dip
  sip="$(public_ip)"; dip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
  if [[ -z "$dip" ]]; then
    warn "${DOMAIN} does not resolve yet. SSL issuance will fail until DNS points to ${sip:-this server}."
    confirm "Continue anyway?" n || { info "Aborted."; return; }
  elif [[ -n "$sip" && "$dip" != "$sip" ]]; then
    warn "${DOMAIN} resolves to ${dip}, but this server is ${sip}."
    confirm "Continue anyway?" n || { info "Aborted."; return; }
  else
    ok "DNS looks good (${DOMAIN} → ${dip})"
  fi

  prompt SSL_EMAIL      "E-mail for SSL notices (optional)" "" '^([^@ ]+@[^@ ]+\.[^@ ]+)?$' "Enter a valid e-mail or leave empty."
  prompt SUPPORT        "Support username"        "@support" '^@?[A-Za-z0-9_]{3,}$' "Example: @my_support"
  [[ "$SUPPORT" == @* ]] || SUPPORT="@${SUPPORT}"
  prompt CARD_NUMBER    "Bank card number"        "6037-0000-0000-0000" '^[0-9-]{8,25}$' "Digits and dashes only."
  prompt CARD_OWNER     "Card owner name"         "Card Owner" '.+' "Cannot be empty."
  prompt MIN_TOPUP      "Minimum top-up (Toman)"  "10000"  '^[0-9]+$' "Numbers only."
  prompt MIN_BALANCE    "Minimum balance to buy (Toman)" "100000" '^[0-9]+$' "Numbers only."
  prompt REF_PERCENT    "Referral commission (%)" "10"     '^[0-9]{1,2}$' "A number between 0 and 99."

  section "Virtualizor panel (VPS provider)"
  info "Admin API credentials: Virtualizor Admin → ${B}Configuration → API Credentials${R}. Leave URL empty to set it up later."
  prompt VIRT_URL "Panel URL (e.g. https://panel.example.com:4085)" "" '^(https?://[^ ]+)?$' "Enter a full URL starting with http(s)://"
  VIRT_URL="${VIRT_URL%/}"
  VIRT_API_KEY=""; VIRT_API_PASS=""; VIRT_INSECURE="0"
  VIRT_OWNER_EMAIL="bot@${DOMAIN}"; VIRT_OWNER_PASS="$(openssl rand -hex 12)"
  if [[ -n "$VIRT_URL" ]]; then
    prompt VIRT_API_KEY  "API key"  "" '^[A-Za-z0-9]{8,}$' "Letters and digits only."
    prompt VIRT_API_PASS "API pass" "" '^[A-Za-z0-9]{8,}$' "Letters and digits only."
    prompt VIRT_OWNER_EMAIL "E-mail of the panel user that will own the VPSs (auto-created)" "$VIRT_OWNER_EMAIL" '^[^@ ]+@[^@ ]+\.[^@ ]+$' "Enter a valid e-mail."
    confirm "Does the panel use a self-signed / invalid SSL certificate?" n && VIRT_INSECURE="1"
  fi

  PORT=3000; while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
  WEBHOOK_SECRET="$(openssl rand -hex 24)"
  CRON_SECRET="$(openssl rand -hex 24)"
  DB_PASS="$(openssl rand -hex 16)"

  section "Summary"
  printf "  %-18s %s\n" "Bot"        "${bot_user:+@$bot_user}"
  printf "  %-18s %s\n" "Admin IDs"  "$ADMIN_IDS"
  printf "  %-18s %s\n" "Domain"     "https://${DOMAIN}"
  printf "  %-18s %s\n" "Repository" "$(repo_url) (${BRANCH})"
  printf "  %-18s %s\n" "Virtualizor" "${VIRT_URL:-not configured (set later)}"
  printf "  %-18s %s\n" "App port"   "127.0.0.1:${PORT}"
  printf "  %-18s %s\n" "Install dir" "$APP_DIR"
  echo
  confirm "Start installation?" y || { info "Aborted."; return; }

  : >"$LOG_FILE"
  section "Installing"
  run_step "Installing system packages (nginx, postgresql, certbot…)" step_packages || return 1
  run_step "Installing Node.js 22"                                     step_node     || return 1
  run_step "Preparing swap space (low-memory servers only)"            step_swap
  run_step "Creating service user"                                     step_user     || return 1
  run_step "Setting up PostgreSQL database"                            step_database || return 1
  run_step "Downloading project from GitHub"                           step_clone    || { warn "Check that VPSBOT_REPO ('$REPO') exists and is public."; return 1; }
  run_step "Writing configuration (.env.local)"                        step_env      || return 1
  save_meta
  run_step "Installing dependencies (npm)"                             step_npm_install || return 1
  run_step "Creating database tables"                                  step_migrate  || return 1
  run_step "Building the application (this can take a few minutes)"    step_build    || return 1
  run_step "Registering systemd services + billing timer"              step_systemd  || return 1
  run_step "Configuring nginx reverse proxy"                           step_nginx    || return 1
  run_step "Opening firewall ports 80/443"                             step_firewall
  if ! run_step "Issuing free SSL certificate (Let's Encrypt)"         step_ssl; then
    warn "SSL failed — Telegram webhooks require HTTPS. Fix DNS, then run: ${B}vpsbot${R} → Settings → SSL retry (or: certbot --nginx -d ${DOMAIN})"
  fi
  run_step "Waiting for the app to come online"                        wait_for_app  || warn "App is slow to start; check logs with: vpsbot logs"
  if ! run_step "Registering Telegram webhook"                         step_webhook; then
    warn "Webhook not set (Telegram unreachable or SSL missing). Retry later: ${B}vpsbot webhook${R}"
  fi
  run_step "Installing the 'vpsbot' management command"                step_command
  if [[ -n "$VIRT_URL" ]]; then
    run_step "Testing Virtualizor API connection"                      step_virt_test \
      || warn "Could not reach Virtualizor — check URL/API keys: ${B}vpsbot → Bot settings${R}"
  fi

  section "Done"
  printf "  ${GRN}${B}✔ Installation complete!${R}\n\n"
  printf "  ${B}Bot${R}       %s\n" "${bot_user:+https://t.me/$bot_user}"
  printf "  ${B}Website${R}   https://%s\n" "$DOMAIN"
  printf "  ${B}Manage${R}    run ${CYN}vpsbot${R} anywhere to open this menu\n"
  printf "  ${B}Logs${R}      ${CYN}vpsbot logs${R}\n\n"
  printf "  ${D}Open your bot in Telegram, send /start, then use the ${R}${B}🛠 Admin Panel${R}${D} button.${R}\n"
  printf "  ${D}Don't forget: edit service prices/plans and wire up src/lib/provider.ts to your VPS provider.${R}\n"
}

# ───────────────────────────── Update ─────────────────────────────
do_backup() {
  need_root
  is_installed || { err "Not installed."; return 1; }
  mkdir -p "$BACKUP_DIR"
  local f; f="$BACKUP_DIR/${DB_NAME}-$(date +%Y%m%d-%H%M%S).sql.gz"
  if runuser -u postgres -- pg_dump "$DB_NAME" | gzip >"$f"; then
    chmod 600 "$f"; ok "Backup saved: ${B}${f}${R} ($(du -h "$f" | cut -f1))"
    ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f   # keep last 10
  else
    err "Backup failed."; return 1
  fi
}

do_update() {
  need_root
  is_installed || { err "Not installed yet — choose Install first."; return 1; }
  load_meta
  banner; section "Update"
  : >>"$LOG_FILE"
  local old new
  old="$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null)"

  run_step "Backing up the database"        do_backup || warn "Continuing without a fresh backup."
  run_step "Fetching latest code"           app_run "git fetch --depth 1 origin '$BRANCH' && git reset --hard FETCH_HEAD" || return 1
  new="$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null)"
  if [[ "$old" == "$new" ]]; then
    info "Already on the latest version (${new})."
    confirm "Rebuild and restart anyway?" n || return 0
  fi
  run_step "Installing dependencies"        step_npm_install || return 1
  run_step "Applying database migrations"   step_migrate     || return 1
  run_step "Building the application"       step_build       || return 1
  run_step "Restarting the bot"             systemctl restart "$SERVICE" || return 1
  run_step "Refreshing the 'vpsbot' command" step_command
  echo; ok "Updated ${GRY}${old}${R} → ${B}${new}${R}"
}

# ───────────────────────────── Service control ─────────────────────────────
show_status() {
  section "Status"
  printf "  %-14s " "Bot service";   status_dot; echo
  printf "  %-14s %s\n" "Domain"    "${DOMAIN:-—}"
  printf "  %-14s %s\n" "Port"      "${PORT:-—}"
  printf "  %-14s %s\n" "Version"   "$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo —)"
  printf "  %-14s %s\n" "Nginx"     "$(systemctl is-active nginx 2>/dev/null)"
  printf "  %-14s %s\n" "PostgreSQL" "$(systemctl is-active postgresql 2>/dev/null)"
  printf "  %-14s %s\n" "Billing timer" "$(systemctl is-active ${BILLING}.timer 2>/dev/null)"
  local wh; wh="$(tg_api getWebhookInfo || true)"
  if [[ -n "$wh" ]]; then
    printf "  %-14s %s\n" "Webhook URL"  "$(grep -o '"url":"[^"]*"' <<<"$wh" | head -1 | cut -d'"' -f4)"
    printf "  %-14s %s\n" "Pending"      "$(grep -o '"pending_update_count":[0-9]*' <<<"$wh" | cut -d: -f2)"
    local le; le="$(grep -o '"last_error_message":"[^"]*"' <<<"$wh" | cut -d'"' -f4)"
    [[ -n "$le" ]] && printf "  %-14s ${RED}%s${R}\n" "Last error" "$le"
  else
    printf "  %-14s ${YLW}%s${R}\n" "Webhook" "could not query Telegram"
  fi
}

service_menu() {
  need_root
  is_installed || { err "Not installed."; pause; return; }
  while true; do
    banner; section "Service control"
    printf "  Current state: "; status_dot; echo; echo
    printf "   ${CYN}1${R}  Start\n   ${CYN}2${R}  Stop\n   ${CYN}3${R}  Restart\n   ${CYN}4${R}  Full status\n   ${CYN}0${R}  Back\n\n"
    printf "  ${B}Select${R} ▸ "; read -r c </dev/tty || return
    case "$c" in
      1) systemctl start "$SERVICE" && ok "Started"; pause ;;
      2) systemctl stop "$SERVICE" && ok "Stopped"; pause ;;
      3) systemctl restart "$SERVICE" && ok "Restarted"; pause ;;
      4) show_status; pause ;;
      0|"") return ;;
    esac
  done
}

show_logs() {
  need_root
  is_installed || { err "Not installed."; return 1; }
  info "Live logs — press ${B}Ctrl+C${R} to return."
  trap ':' INT
  journalctl -u "$SERVICE" -n 80 -f --no-hostname -o cat
  trap 'printf "\n"; echo "  ${YLW}Interrupted.${R}"; exit 130' INT
  echo
}

# ───────────────────────────── Settings ─────────────────────────────
do_webhook() {
  need_root
  is_installed || { err "Not installed."; return 1; }
  run_step "Registering Telegram webhook" step_webhook \
    && ok "Webhook set to ${B}$(env_get APP_URL)/api/telegram${R}" \
    || warn "Failed. Make sure HTTPS works and Telegram is reachable from this server."
}

settings_menu() {
  need_root
  is_installed || { err "Not installed."; pause; return; }
  load_meta
  local keys=(BOT_TOKEN ADMIN_IDS SUPPORT_USERNAME CARD_NUMBER CARD_OWNER MIN_TOPUP MIN_BALANCE_TO_BUY REF_PERCENT VIRT_URL VIRT_API_KEY VIRT_API_PASS VIRT_INSECURE_TLS VIRT_OWNER_EMAIL VPS_DOMAIN)
  local labels=("Bot token" "Admin IDs" "Support username" "Card number" "Card owner" "Minimum top-up" "Minimum balance to buy" "Referral percent" "Virtualizor URL" "Virtualizor API key" "Virtualizor API pass" "Self-signed SSL (1/0)" "Panel owner e-mail" "VPS hostname domain")
  while true; do
    banner; section "Bot settings"
    local i v
    for i in "${!keys[@]}"; do
      v="$(env_get "${keys[$i]}")"
      [[ "${keys[$i]}" == BOT_TOKEN ]] && v="${v%%:*}:••••••••"
      [[ "${keys[$i]}" == VIRT_API_* && -n "$v" ]] && v="${v:0:4}••••••••"
      printf "   ${CYN}%d${R}  %-24s ${D}%s${R}\n" "$((i + 1))" "${labels[$i]}" "$v"
    done
    printf "   ${CYN}e${R}  Edit .env.local in nano\n"
    printf "   ${CYN}v${R}  Test Virtualizor connection / list node & OS IDs\n"
    printf "   ${CYN}s${R}  Retry SSL certificate\n"
    printf "   ${CYN}0${R}  Back\n\n"
    printf "  ${B}Select${R} ▸ "; read -r c </dev/tty || return
    case "$c" in
      0|"") return ;;
      [0-9]|1[0-9]|2[0-9])
        (( c >= 1 && c <= ${#keys[@]} )) || continue
        local k="${keys[$((c - 1))]}" nv
        prompt nv "New value for ${labels[$((c - 1))]}" "" '.+' "Cannot be empty."
        env_set "$k" "$nv"
        systemctl restart "$SERVICE" && ok "Saved and restarted."
        [[ "$k" == BOT_TOKEN ]] && do_webhook
        pause ;;
      e|E) command -v nano >/dev/null || apt-get install -y nano >/dev/null 2>&1
         nano "$ENV_FILE"; systemctl restart "$SERVICE" && ok "Restarted."; pause ;;
      v|V) do_virt; pause ;;
      s|S) DOMAIN="${DOMAIN}"; SSL_EMAIL=""; run_step "Issuing SSL certificate" step_ssl && do_webhook; pause ;;
    esac
  done
}

# ───────────────────────────── Uninstall ─────────────────────────────
do_uninstall() {
  need_root
  is_installed || { err "Nothing to uninstall."; return 1; }
  load_meta
  banner; section "Uninstall"
  warn "This removes the bot, its services and nginx site."
  local drop_db=n
  confirm "Also DELETE the database and all users/services data?" n && drop_db=y
  printf "\n  Type ${B}${RED}uninstall${R} to confirm: "
  local a; read -r a </dev/tty || return
  [[ "$a" == "uninstall" ]] || { info "Cancelled."; return; }

  : >>"$LOG_FILE"
  if [[ "$drop_db" == y ]]; then
    local f; f="/root/vpsbot-final-backup-$(date +%Y%m%d-%H%M%S).sql.gz"
    runuser -u postgres -- pg_dump "$DB_NAME" 2>/dev/null | gzip >"$f" && ok "Final backup saved: ${B}${f}${R}"
  fi
  tg_api deleteWebhook >/dev/null 2>&1 || true
  run_step "Stopping services" bash -c "systemctl disable --now ${SERVICE}.service ${BILLING}.timer 2>/dev/null; true"
  run_step "Removing service files" bash -c "rm -f /etc/systemd/system/${SERVICE}.service /etc/systemd/system/${BILLING}.service /etc/systemd/system/${BILLING}.timer; systemctl daemon-reload"
  run_step "Removing nginx site" bash -c "rm -f '$NGINX_LINK' '$NGINX_CONF'; nginx -t && systemctl reload nginx; true"
  if [[ "$drop_db" == y ]]; then
    run_step "Dropping database" bash -c "runuser -u postgres -- psql -c 'DROP DATABASE IF EXISTS ${DB_NAME}'; runuser -u postgres -- psql -c 'DROP ROLE IF EXISTS ${DB_USER}'"
  fi
  run_step "Deleting files and user" bash -c "rm -rf '$INSTALL_ROOT'; userdel '$APP_USER' 2>/dev/null; true"
  rm -f "$CMD_PATH"
  echo; ok "Uninstalled. ${D}(SSL certificate for ${DOMAIN} was left in /etc/letsencrypt)${R}"
}

# ───────────────────────────── Main menu ─────────────────────────────
main_menu() {
  while true; do
    load_meta
    banner
    printf "  ${B}Status${R}   "; status_dot
    if is_installed; then
      printf "     ${B}Domain${R}  %s\n" "${DOMAIN:-—}"
      printf "  ${B}Version${R}  %s" "$(as_app git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo —)"
      printf "             ${B}Port${R}    %s\n" "${PORT:-—}"
    else
      echo
    fi
    echo; hr
    printf "   ${CYN}${B}1${R}  ⚡  Install\n"
    printf "   ${CYN}${B}2${R}  ⬆️   Update to latest version\n"
    printf "   ${CYN}${B}3${R}  🎛  Service control (start / stop / restart)\n"
    printf "   ${CYN}${B}4${R}  📜  View live logs\n"
    printf "   ${CYN}${B}5${R}  ⚙️   Bot settings\n"
    printf "   ${CYN}${B}6${R}  🔗  Re-set Telegram webhook\n"
    printf "   ${CYN}${B}7${R}  💾  Backup database\n"
    printf "   ${CYN}${B}8${R}  🗑  Uninstall\n"
    printf "   ${CYN}${B}0${R}  🚪  Exit\n"
    hr
    printf "  ${B}Select an option${R} ▸ "
    local c; read -r c </dev/tty || exit 0
    case "$c" in
      1) do_install;      pause ;;
      2) do_update;       pause ;;
      3) service_menu ;;
      4) show_logs ;;
      5) settings_menu ;;
      6) do_webhook;      pause ;;
      7) do_backup;       pause ;;
      8) do_uninstall;    pause ;;
      0|q|Q) echo; exit 0 ;;
      *) ;;
    esac
  done
}

usage() {
  cat <<EOF
Usage: vpsbot [command]

  (no command)   open the interactive menu
  install        run the guided installer
  update         update to the latest version
  start|stop|restart
  status         show service & webhook status
  logs           follow live logs
  webhook        re-register the Telegram webhook
  virt           test the Virtualizor connection and list node/OS IDs
  backup         dump the database to ${BACKUP_DIR}
  uninstall      remove the bot
EOF
}

# ───────────────────────────── Entry point ─────────────────────────────
need_root
mkdir -p "$(dirname "$LOG_FILE")"; touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
load_meta

case "${1:-menu}" in
  menu|"")        check_os; main_menu ;;
  install)        do_install ;;
  update)         do_update ;;
  start)          systemctl start "$SERVICE" && ok "Started" ;;
  stop)           systemctl stop "$SERVICE" && ok "Stopped" ;;
  restart)        systemctl restart "$SERVICE" && ok "Restarted" ;;
  status)         show_status ;;
  logs)           show_logs ;;
  webhook)        do_webhook ;;
  virt)           do_virt ;;
  backup)         do_backup ;;
  uninstall)      do_uninstall ;;
  -h|--help|help) usage ;;
  *)              usage; exit 1 ;;
esac
