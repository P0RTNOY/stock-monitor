#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
python_bin=${PYTHON_BIN:-"$project_root/.venv312/bin/python"}
analysis_pid=""

cleanup() {
  if [ -n "$analysis_pid" ] && kill -0 "$analysis_pid" 2>/dev/null; then
    kill -TERM "$analysis_pid" 2>/dev/null || true
    wait "$analysis_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ ! -x "$python_bin" ]; then
  echo "Python runtime not found at $python_bin" >&2
  echo "Set PYTHON_BIN to a Python environment with requirements.txt installed." >&2
  exit 1
fi

cd "$project_root"
"$python_bin" -m analysis.api --host 127.0.0.1 --port 8502 &
analysis_pid=$!

attempt=0
while [ "$attempt" -lt 50 ]; do
  if curl -fsS http://127.0.0.1:8502/health >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$analysis_pid" 2>/dev/null; then
    echo "Northstar analysis API failed to start." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if ! curl -fsS http://127.0.0.1:8502/health >/dev/null 2>&1; then
  echo "Northstar analysis API did not become healthy." >&2
  exit 1
fi

cd "$project_root/market-monitor-web"
npm run dev -- --host 0.0.0.0 --port 8501
