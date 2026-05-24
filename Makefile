SYNTH    ?= ../holoso-synth
WHEEL    := holoso-0.1.0-py3-none-any.whl
STATIC   := index.html app.js worker.js driver.py
DIST     := dist
PORT     ?= 8137

.PHONY: dist wheel vendor test serve clean image deploy

dist: wheel vendor
	rm -rf $(DIST)
	mkdir -p $(DIST)/wheels $(DIST)/pyodide
	cp $(STATIC) $(DIST)/
	cp wheels/$(WHEEL) $(DIST)/wheels/
	cp -R pyodide/. $(DIST)/pyodide/
	@echo "assembled $(DIST)/ ($$(du -sh $(DIST) | cut -f1))"

wheel:
	cd $(SYNTH) && uv build --wheel
	mkdir -p wheels
	cp $(SYNTH)/dist/$(WHEEL) wheels/

vendor:
	cd tools && npm ci --no-audit --no-fund && npm run vendor

test: wheel vendor
	cd tools && npm run test && npm run vendor:check

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1

image:
	act -W .github/workflows/build.yml

deploy:
	act -W .github/workflows/deploy.yml

clean:
	rm -rf $(DIST) wheels/*.whl pyodide tools/node_modules
