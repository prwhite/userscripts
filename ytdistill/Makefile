# ytdistill — phase 1 CLI shortcuts. Run `make help` for the list.
.DEFAULT_GOAL := help

# Load a gitignored .env (e.g. OPENAI_API_KEY=sk-...) if present; an
# already-exported key in the environment works too.
-include .env
export

VENV   := .venv
PY     := $(VENV)/bin/python
PIP    := $(VENV)/bin/pip
SYS_PY ?= python3

# Override on the command line, e.g. make review URL=dQw4w9WgXcQ PROVIDER=anthropic
URL      ?=
PROVIDER ?= openai
MODEL    ?=
OUT      ?= out
ARGS     ?=

MODELFLAG := $(if $(strip $(MODEL)),--model $(strip $(MODEL)),)
RUN       := $(PY) -m ytdistill

.PHONY: help run review saverun corpus compare test compile setup deps clean

help: ## Show this help
	@sed \
		-e '/^[a-zA-Z0-9_\-]*:.*##/!d' \
		-e 's/:.*##\s*/:/' \
		-e 's/^\(..*\):\(.*\)/$(shell tput setaf 6)\1$(shell tput sgr0):\2/' \
		$(MAKEFILE_LIST) | column -c2 -t -s :

run: setup ## Distill a video → terminal  (make run URL=<id|url> [PROVIDER=] [MODEL=])
	@test -n "$(URL)" || { echo "usage: make run URL=<id|url>"; exit 1; }
	$(RUN) "$(URL)" --provider $(PROVIDER) $(MODELFLAG) $(ARGS)

review: setup ## Distill → HTML review + saved run  (make review URL=<id|url>)
	@test -n "$(URL)" || { echo "usage: make review URL=<id|url>"; exit 1; }
	$(RUN) "$(URL)" --provider $(PROVIDER) $(MODELFLAG) --review "$(OUT).review.html" --save-run $(ARGS)
	@echo "review written: $(OUT).review.html"

saverun: setup ## Distill and save a runs/<id>/ bundle for the compare step
	@test -n "$(URL)" || { echo "usage: make saverun URL=<id|url>"; exit 1; }
	$(RUN) "$(URL)" --provider $(PROVIDER) $(MODELFLAG) --save-run --save-transcript $(ARGS)

corpus: setup ## Distill every video in eval/corpus.md → runs/<id>/ (for the compare)
	$(PY) eval/run_corpus.py --provider $(PROVIDER) $(MODELFLAG)

compare: ## Build the OpenAI-vs-Claude comparison page → eval/compare.html
	$(SYS_PY) eval/build_compare.py

test: ## Run the caption unit tests (stdlib only, no venv)
	$(SYS_PY) tests/test_captions.py

compile: ## Byte-compile all modules (fast syntax check, no venv)
	@$(SYS_PY) -m py_compile ytdistill/*.py ytdistill/providers/*.py eval/*.py && echo "compile OK"

setup: $(VENV)/bin/python ## Create the venv and install dependencies

deps: ## Reinstall/upgrade dependencies into the venv
	$(PIP) install -U -r requirements.txt

clean: ## Remove caches and build artifacts
	@find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null; \
	rm -rf build dist *.egg-info *.review.html; echo "cleaned"

# Internal: provision the venv on first use (no help line — not a shortcut).
$(VENV)/bin/python:
	$(SYS_PY) -m venv $(VENV)
	$(PIP) install -U pip >/dev/null
	$(PIP) install -r requirements.txt
