# Gnista's chores. Cargo does the building; these put the steps together.
#
#   make app                  Gnista.app, optimised, on V8 (the default engine)
#   make app ENGINE=quickjs   on QuickJS: a smaller app, about 41 MB against 97
#   make check                every test and clippy, on V8 and on QuickJS
#   make tidy                 delete the build's day-old leftover object files
#
# make app builds target/Gnista.app; open it, or copy it to /Applications.

ENGINE  ?= v8
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP     := target/Gnista.app

ifeq ($(ENGINE),v8)
FEATURES :=
else
FEATURES := --no-default-features --features $(ENGINE)
endif

# QuickJS builds in a target directory of its own: the two engines turn on
# different features of crates they share, so building one in the other's
# directory would rebuild most of the workspace each time.
QUICKJS := CARGO_TARGET_DIR=target/quickjs
QUICKJS_FEATURES := --no-default-features --features quickjs

.PHONY: app clean-app check tidy

app:
	cargo build --release -p gnista-gui $(FEATURES)
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp target/release/gnista-gui $(APP)/Contents/MacOS/
	sed 's/@VERSION@/$(VERSION)/g' crates/gnista-gui/macos/Info.plist > $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)
	@echo "Built $(APP) ($(ENGINE), version $(VERSION))"

clean-app:
	rm -rf $(APP)

# Before a push that touches the script engine, the natives or the
# packages: the tests must pass on both engines (ADR 0054).
check: tidy
	cargo nextest run --workspace
	cargo clippy --all-targets
	$(QUICKJS) cargo nextest run --workspace $(QUICKJS_FEATURES)
	$(QUICKJS) cargo clippy --all-targets $(QUICKJS_FEATURES)

# Cargo keeps each debug build's object files beside the test programs and
# never deletes old ones. macOS's check of a new program looks through the
# folder it is in, so with a million of them every new test program waited
# 45 s to start (docs/performance.md). Deleting those over a day old keeps
# every current program and its debug information.
tidy:
	@for dir in target/debug/deps target/quickjs/debug/deps; do \
		if [ -d $$dir ]; then \
			before=$$(ls -f $$dir | wc -l); \
			find $$dir -maxdepth 1 -name '*.o' -mtime +1 -delete; \
			echo "$$dir: $$before files, now $$(ls -f $$dir | wc -l)"; \
		fi; \
	done
