SYNTH     ?= ../holoso-synth
WHEEL     := holoso-0.1.0-py3-none-any.whl
STATIC    := index.html app.js worker.js driver.py closure.js yosys-worker.js yosys-job.js nanotar.js
DIST      := dist
PORT      ?= 8137
YOSYS_GEN := tools/node_modules/@yowasp/yosys/gen
NPNR_GEN  := tools/node_modules/@yowasp/nextpnr-ecp5/gen

.PHONY: dist wheel node-deps vendor vendor-yosys vendor-nextpnr vendor-hdl vendor-examples test serve clean image deploy

dist: wheel vendor vendor-yosys vendor-nextpnr vendor-hdl vendor-examples
	rm -rf $(DIST)
	mkdir -p $(DIST)/wheels $(DIST)/pyodide $(DIST)/yosys $(DIST)/nextpnr-ecp5 $(DIST)/hdl $(DIST)/demos
	cp $(STATIC) $(DIST)/
	cp wheels/$(WHEEL) $(DIST)/wheels/
	cp -R pyodide/. $(DIST)/pyodide/
	cp -R yosys/. $(DIST)/yosys/
	cp -R nextpnr-ecp5/. $(DIST)/nextpnr-ecp5/
	cp -R hdl/. $(DIST)/hdl/
	cp -R demos/. $(DIST)/demos/
	@echo "assembled $(DIST)/ ($$(du -sh $(DIST) | cut -f1))"

wheel:
	cd $(SYNTH) && uv build --wheel
	mkdir -p wheels
	cp $(SYNTH)/dist/$(WHEEL) wheels/

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

vendor-hdl:
	node tools/vendor-hdl.mjs $(SYNTH)

vendor-examples:
	node tools/vendor-examples.mjs $(SYNTH)

test: wheel vendor vendor-hdl vendor-examples
	cd tools && npm run test && npm run vendor:check && npm run test:closure

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1

image:
	act -W .github/workflows/build.yml

deploy:
	act -W .github/workflows/deploy.yml

clean:
	rm -rf $(DIST) wheels/*.whl pyodide yosys nextpnr-ecp5 hdl tools/node_modules
