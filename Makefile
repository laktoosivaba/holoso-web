SYNTH     ?= ../holoso-synth
STATIC    := index.html app.js worker.js driver.py closure.js yosys-worker.js yosys-job.js nanotar.js marked.esm.js README.md favicon.png
DIST      := dist
PORT      ?= 8137
YOSYS_GEN := tools/node_modules/@yowasp/yosys/gen
NPNR_GEN  := tools/node_modules/@yowasp/nextpnr-ecp5/gen

.PHONY: dist wheel node-deps vendor vendor-yosys vendor-nextpnr vendor-examples vendor-jaxtyping test serve clean image deploy

dist: wheel vendor vendor-yosys vendor-nextpnr vendor-examples vendor-jaxtyping
	node tools/wheels-manifest.mjs
	rm -rf $(DIST)
	mkdir -p $(DIST)/wheels $(DIST)/pyodide $(DIST)/yosys $(DIST)/nextpnr-ecp5 $(DIST)/demos
	cp $(STATIC) $(DIST)/
	cp wheels/*.whl wheels/manifest.json $(DIST)/wheels/
	cp -R pyodide/. $(DIST)/pyodide/
	cp -R yosys/. $(DIST)/yosys/
	cp -R nextpnr-ecp5/. $(DIST)/nextpnr-ecp5/
	cp -R demos/. $(DIST)/demos/
	@echo "assembled $(DIST)/ ($$(du -sh $(DIST) | cut -f1))"

wheel:
	cd $(SYNTH) && uv build --wheel
	mkdir -p wheels
	rm -f wheels/holoso-*.whl
	cp $(SYNTH)/dist/holoso-*.whl wheels/

node-deps:
	cd tools && npm ci --no-audit --no-fund

vendor: node-deps
	cd tools && npm run vendor

vendor-yosys: node-deps
	rm -rf yosys && mkdir -p yosys
	cp -R $(YOSYS_GEN)/. yosys/

# nextpnr-ecp5 ships the ECP5 chipdb for every device variant (~170 MB); served lazily, only on Route.
vendor-nextpnr: node-deps
	rm -rf nextpnr-ecp5 && mkdir -p nextpnr-ecp5
	cp -R $(NPNR_GEN)/. nextpnr-ecp5/

vendor-examples:
	node tools/vendor-examples.mjs $(SYNTH)

vendor-jaxtyping:
	node tools/vendor-jaxtyping.mjs

test: wheel vendor vendor-examples vendor-jaxtyping
	cd tools && npm run test && npm run vendor:check && npm run test:closure

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1

image:
	act -W .github/workflows/build.yml

deploy:
	act -W .github/workflows/deploy.yml

clean:
	rm -rf $(DIST) wheels/*.whl wheels/extra-manifest.json wheels/manifest.json pyodide yosys nextpnr-ecp5 demos tools/node_modules
