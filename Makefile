# Builds Ember.app, the GUI as a macOS app, into target/.
#
#   make app                  optimised, on V8 (the default engine)
#   make app ENGINE=quickjs   on QuickJS: a smaller app, about 41 MB against 97
#
# Then open target/Ember.app, or copy it to /Applications.

ENGINE  ?= v8
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP     := target/Ember.app

ifeq ($(ENGINE),v8)
FEATURES :=
else
FEATURES := --no-default-features --features $(ENGINE)
endif

.PHONY: app clean-app

app:
	cargo build --release -p ember-gui $(FEATURES)
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp target/release/ember-gui $(APP)/Contents/MacOS/
	sed 's/@VERSION@/$(VERSION)/g' crates/ember-gui/macos/Info.plist > $(APP)/Contents/Info.plist
	codesign --force --deep --sign - $(APP)
	@echo "Built $(APP) ($(ENGINE), version $(VERSION))"

clean-app:
	rm -rf $(APP)
