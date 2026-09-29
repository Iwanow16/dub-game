#!/usr/bin/env bash
# Local development (§21.4): api + game-server + media-worker + web (+ studio) with hot reload.
#   ./scripts/dev.sh            start everything
#   ./scripts/dev.sh --seed     also generate and publish the starter clips
#   ./scripts/dev.sh --tunnel   also open a Cloudflare quick tunnel to test from a phone
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

usage() {
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
}

SEED=0
TUNNEL=0
for a in "$@"; do
  case $a in
    --seed) SEED=1 ;;
    --tunnel) TUNNEL=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "неизвестный флаг: $a" ;;
  esac
done

cd "$DUBROOM_ROOT"
need node pnpm
have ffmpeg || warn "ffmpeg не найден — обработка клипов (media-worker, --seed) работать не будет"

ENV_FILE="$DUBROOM_ROOT/.env.dev"
if [[ ! -f $ENV_FILE ]]; then
  need openssl
  umask 077
  {
    echo "DATA_DIR=$DUBROOM_ROOT/data"
    echo "TOKEN_SIGNING_KEY=$(random_secret 48)"
    echo "STUDIO_KEY=$(random_secret 24)"
    echo "API_INTERNAL_URL=http://localhost:3000"
    echo "LOG_LEVEL=info"
  } >"$ENV_FILE"
  ok "создан $ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ -d node_modules ]] || pnpm install

# ports must be free — a stale process from an earlier run would serve old code
for port in 3000 3001 5173 5174 5175; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    die "порт $port занят (старый dev.sh?) — освободите: fuser -k $port/tcp"
  fi
done

# every service runs in its own process group, so stopping kills node grandchildren too
set -m
pgids=()
cleanup() {
  trap - EXIT INT TERM
  for g in "${pgids[@]}"; do kill -TERM -- "-$g" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

run() {
  local name=$1
  shift
  ("$@" 2>&1 | sed -u "s/^/[$name] /") &
  pgids+=($!)
}

run api pnpm -F @dubroom/api dev
run game pnpm -F @dubroom/game-server dev
run worker pnpm -F @dubroom/media-worker dev
run web pnpm -F @dubroom/web dev
if [[ -d apps/studio ]]; then run studio pnpm -F @dubroom/studio dev; fi
if [[ -d apps/help ]]; then run help pnpm -F @dubroom/help dev; fi

wait_http http://localhost:3000/api/health 60 || die "api не поднялся"
ok "api: http://localhost:3000"
ok "игра: http://localhost:5173"
[[ -d apps/studio ]] && ok "Clip Studio: http://localhost:5174 (ключ: STUDIO_KEY в .env.dev)"

if [[ $SEED == 1 ]]; then
  DUBROOM_API=http://localhost:3000 "$DUBROOM_ROOT/scripts/seed-clips.sh" "$DUBROOM_ROOT/content/starter-pack" --approve || warn "seed завершился с ошибкой"
fi

if [[ $TUNNEL == 1 ]]; then
  if have cloudflared; then
    run tunnel cloudflared tunnel --no-autoupdate --url http://localhost:5173
    info "адрес *.trycloudflare.com появится в логе [tunnel]"
  else
    warn "cloudflared не установлен — см. docs/admin/README.md"
  fi
fi

wait
