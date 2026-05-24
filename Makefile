SYNTH     ?= ../holoso-synth
WHEEL     := holoso-0.1.0-py3-none-any.whl
STATIC    := index.html app.js worker.js driver.py closure.js yosys-worker.js yosys-job.js nanotar.js
DIST      := dist
PORT      ?= 8137
YOSYS_GEN := tools/node_modules/@yowasp/yosys/gen

.PHONY: dist wheel node-deps vendor vendor-yosys vendor-hdl test serve clean image deploy

dist: wheel vendor vendor-yosys vendor-hdl
	rm -rf $(DIST)
	mkdir -p $(DIST)/wheels $(DIST)/pyodide $(DIST)/yosys $(DIST)/hdl
	cp $(STATIC) $(DIST)/
	cp wheels/$(WHEEL) $(DIST)/wheels/
	cp -R pyodide/. $(DIST)/pyodide/
	cp -R yosys/. $(DIST)/yosys/
	cp -R hdl/. $(DIST)/hdl/
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

vendor-hdl:
	node tools/vendor-hdl.mjs $(SYNTH)

test: wheel vendor vendor-hdl
	cd tools && npm run test && npm run vendor:check && npm run test:closure

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1

image:
	act -W .github/workflows/build.yml

deploy:
	act -W .github/workflows/deploy.yml

clean:
	rm -rf $(DIST) wheels/*.whl pyodide yosys hdl tools/node_modules
