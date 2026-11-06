// use-package, after Emacs's use-package.el with its :vc keyword: a
// configuration names each package it uses, from its git repository, and
// use-package installs it if it is missing, activates it and requires it.
// init.ts calls it as e8.usePackage, which loads this package:
//
//   e8.usePackage("e8-editor/e8-org-roam", { rev: "v0.3.1" });
//   e8.usePackage("vertico", { url: "https://codeberg.org/someone/e8-vertico" });
//
// `owner/name` is a GitHub repository; `url` names any other, the first
// argument then being the package's name. Without `rev` the package is at
// its newest version tag when first installed, and stays at the commit the
// lock file records after that, until M-x package-vc-upgrade.

import { ensurePackage } from "package-vc";

export interface UsePackageOptions {
  /** A tag, branch or commit; the newest version tag if left out. */
  rev?: string;
  /** The repository, when the first argument is the package's name. */
  url?: string;
  /** Whether to require the package once it is active; true unless false, as use-package without :defer. */
  require?: boolean;
}

/** Installs a package if it is missing, activates it and requires it, giving its name. */
export function usePackage(source: string, options: UsePackageOptions = {}): string {
  const name = ensurePackage(source, {
    rev: options.rev,
    url: options.url,
    name: options.url === undefined ? undefined : source,
  });
  if (options.require !== false) e8.require(name);
  return name;
}

e8.defun("use-package", (source: string, options?: UsePackageOptions) => usePackage(source, options ?? {}));
