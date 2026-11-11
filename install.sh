#!/usr/bin/env bash
set -euo pipefail

download_dir=""
cleanup_download() {
  if [ -n "${download_dir}" ] && [ -d "${download_dir}" ]; then
    rm -rf -- "${download_dir}"
  fi
}
trap cleanup_download EXIT

resolve_python() {
  command -v python3 >/dev/null 2>&1 && { printf '%s\n' python3; return; }
  command -v python >/dev/null 2>&1 && { printf '%s\n' python; return; }
  return 1
}

copy_dir_contents() {
  local source="$1"
  local target="$2"
  [ -d "${source}" ] || return 0
  mkdir -p "${target}"
  cp -R "${source}/." "${target}/"
}

prepare_source() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "${script_dir}/skills/seo/SKILL.md" ]; then
    source_dir="${script_dir}"
    return
  fi

  command -v git >/dev/null 2>&1 || { echo "[ERROR] Git is required for remote install."; exit 1; }
  local repo="${SEO_DUNGEON_REPO:-https://github.com/avalonreset/legends-seo-dungeon}"
  local ref="${SEO_DUNGEON_REF:-main}"
  case "${repo}" in
    https://*) ;;
    *) echo "[ERROR] SEO_DUNGEON_REPO must be an https:// URL." >&2; exit 1 ;;
  esac
  if ! printf '%s' "${ref}" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'; then
    echo "[ERROR] SEO_DUNGEON_REF must be a valid branch or tag name." >&2
    exit 1
  fi
  download_dir="$(mktemp -d)"
  echo "[INFO] Downloading Legends SEO Dungeon (${ref})..." >&2
  git clone --depth 1 --branch "${ref}" -- "${repo}" "${download_dir}/legends-seo-dungeon"
  source_dir="${download_dir}/legends-seo-dungeon"
}

install_python_deps() {
  local skill_dir="$1"
  local python_bin="$2"
  if [ "${SEO_DUNGEON_SKIP_DEPS:-}" = "1" ]; then
    echo "[INFO] Skipping Python dependency install."
    return 0
  fi
  local status=0
  "${python_bin}" "${skill_dir}/scripts/runtime.py" setup || status=$?
  if [ "${status}" -eq 10 ]; then
    echo "[WARN] Core runtime ready; Chromium setup is incomplete."
  elif [ "${status}" -ne 0 ]; then
    echo "[ERROR] Managed Python runtime setup failed." >&2
    return "${status}"
  fi
}

install_codex() {
  local source_dir="$1"
  local python_bin="$2"
  local codex_root="${CODEX_HOME:-${HOME}/.codex}"
  local skills_root="${codex_root}/skills"
  local agents_root="${codex_root}/agents"
  local skill_dir="${skills_root}/seo"

  echo "[INFO] Installing Codex skill tree to ${skills_root}"
  mkdir -p "${skills_root}" "${agents_root}"
  for skill_dir_source in "${source_dir}/skills"/*/; do
    [ -d "${skill_dir_source}" ] || continue
    copy_dir_contents "${skill_dir_source}" "${skills_root}/$(basename "${skill_dir_source}")"
  done
  cp "${source_dir}/agents-codex/"*.toml "${agents_root}/" 2>/dev/null || true
  for name in scripts schema pdf hooks extensions data bin; do
    copy_dir_contents "${source_dir}/${name}" "${skill_dir}/${name}"
  done
  cp "${source_dir}/requirements.txt" "${skill_dir}/requirements.txt" 2>/dev/null || true
  for name in runtime-plugin.json LICENSE-CLAUDE-SEO LICENSE THIRD-PARTY-NOTICES.md; do
    cp "${source_dir}/${name}" "${skill_dir}/${name}"
  done
  "${python_bin}" "${source_dir}/scripts/install_runtime_docs.py" --skills-root "${skills_root}" --agents-root "${agents_root}"
  install_python_deps "${skill_dir}" "${python_bin}"
}

main() {
  local python_bin
  python_bin="$(resolve_python)" || { echo "[ERROR] Python 3 is required."; exit 1; }

  local source_dir
  prepare_source

  if ! "${python_bin}" "${source_dir}/scripts/runtime.py" --check-python >/dev/null 2>&1; then
    echo "[ERROR] Python 3.11+ is required."
    exit 1
  fi

  echo "========================================"
  echo "  Legends SEO Dungeon - Installer"
  echo "  Codex Skill Suite"
  echo "========================================"

  install_codex "${source_dir}" "${python_bin}"

  echo "[OK] Legends SEO Dungeon skills installed for Codex."
  echo "The repo-local AGENTS.md keeps the skill suite portable for compatible terminal agents."
}

main "$@"
