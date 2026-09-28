#!/usr/bin/env bash
# Imports a set of clip packages through the Studio API (§21.4, §9.4).
#   seed-clips.sh <dir> [--approve] [--force]
#     <dir>      folder with one sub-folder per clip (manifest.json [+ synth.json | source/])
#     --approve  publish right after processing (trusted starter pack only)
#     --force    re-import clips that are already in the catalog
# Env: DUBROOM_API (default http://localhost:3000 or the local install), STUDIO_KEY.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

DIR=""
APPROVE=0
FORCE=0
for a in "$@"; do
  case $a in
    --approve) APPROVE=1 ;;
    --force) FORCE=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "неизвестный флаг: $a" ;;
    *) DIR=$a ;;
  esac
done
[[ -n $DIR && -d $DIR ]] || die "укажите каталог с клипами (например content/starter-pack)"

# pick up config of a local install or dev env
for f in "$INSTALL_DIR/.env" "$DUBROOM_ROOT/.env.dev"; do
  if [[ -z ${STUDIO_KEY:-} && -r $f ]]; then STUDIO_KEY=$(env_get "$f" STUDIO_KEY); fi
done
DUBROOM_API=${DUBROOM_API:-http://localhost:3000}
[[ -n ${STUDIO_KEY:-} ]] || die "STUDIO_KEY не задан"
need node curl

CLI=("node" "$DUBROOM_ROOT/packages/clip-format/bin/dubroom-clip.mjs")
catalog=$(curl -fsS "$DUBROOM_API/api/catalog" || die "API недоступен: $DUBROOM_API")

count=0
failed=0
for clip in "$DIR"/*/; do
  [[ -f $clip/manifest.json ]] || continue
  id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id)' "$clip/manifest.json")
  name=$(basename "$clip")
  if [[ $FORCE == 0 && $catalog == *"\"$id\""* ]]; then
    info "$name — уже в каталоге, пропускаю"
    continue
  fi
  step "$name"
  if [[ ! -f $clip/source/original.mp4 && -f $clip/synth.json ]]; then
    "${CLI[@]}" synth "$clip" >/dev/null
    ok "исходник сгенерирован"
  fi
  args=(publish "$clip" --api "$DUBROOM_API" --key "$STUDIO_KEY" --wait)
  [[ $APPROVE == 1 ]] && args+=(--approve)
  if "${CLI[@]}" "${args[@]}"; then
    count=$((count + 1))
  else
    failed=$((failed + 1))
    warn "$name не импортирован"
  fi
done

ok "импортировано: $count, ошибок: $failed"
[[ $failed == 0 ]]
