#!/bin/sh
# Provisions the isolated Paper document worker's interpreter.
#
# One-shot setup, never run by a test: tests take their interpreter from OFFICEHUM_PAPER_PYTHON and
# skip visibly when it is unset. The pins are the frozen set in ../requirements.lock, which the
# receipt records; the interpreter must be Python 3.13 because the worker refuses anything else.
#
# Usage:
#   packages/tools-paper-office/scripts/provision-worker.sh [target-directory]
#
# Then, in the shell that runs the host or the tests:
#   export OFFICEHUM_PAPER_PYTHON="$PWD/packages/tools-paper-office/.worker/bin/python"

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package=$(dirname -- "$here")
target=${1:-"$package/.worker"}

if ! command -v uv >/dev/null 2>&1; then
  echo "provision-worker: uv is required (https://docs.astral.sh/uv/)" >&2
  exit 1
fi

mkdir -p -- "$target"
uv venv --python 3.13 --allow-existing "$target"
uv pip install --python "$target/bin/python" --require-hashes --requirements "$package/requirements.lock"

# The three sentinels are the gate: they prove each fork owns the module it installed.
"$target/bin/python" -m paper_docx_doctor
"$target/bin/python" -m paper_pptx_doctor
"$target/bin/python" -m paper_xlsx_doctor

echo "provision-worker: OFFICEHUM_PAPER_PYTHON=$target/bin/python"