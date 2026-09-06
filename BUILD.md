# Building the .xpi

## Quick start

```powershell
./build.ps1
```

This packages the current `HEAD` via `git archive` and writes
`dist/tb-kanban-<version>.xpi`, with `<version>` read from
[manifest.json](manifest.json).

Useful options:

```powershell
./build.ps1 -Ref v0.1.0        # build a specific tag/branch/commit instead of HEAD
./build.ps1 -Lint              # run `web-ext lint` first (requires `npm i -g web-ext`)
./build.ps1 -OutDir build      # change the output folder (default: dist/, gitignored)
```

## Release checklist

1. Bump `version` in [manifest.json](manifest.json) (and the four
   `_locales/*/messages.json` `extensionName`/`extensionDescription` only if
   they changed).
2. Commit the changes.
3. Tag the release: `git tag vX.Y.Z`.
4. Run `./build.ps1 -Ref vX.Y.Z -Lint`.
5. Push the commit and tag: `git push && git push --tags`.

## Things to watch out for

- **`git archive` only packages committed content.** Uncommitted or staged
  changes are silently left out of the .xpi — always commit (and ideally tag)
  before building. `build.ps1` warns if the working tree is dirty.
- **The manifest version is the single source of truth** for the output
  filename; forgetting to bump it will silently overwrite/reuse the previous
  build's filename.
- **`.gitattributes`** marks dev-only files (`BUILD.md`, `build.ps1`,
  `.gitattributes`, `.gitignore`, `.github/`) as `export-ignore` so they don't
  end up inside the .xpi. If you add new tooling/CI files, exclude them the
  same way.
- **Thunderbird version support**: `manifest.json` pins `strict_min_version`
  under `browser_specific_settings.gecko` (no `strict_max_version`, so newer
  Thunderbird releases are allowed by default). Raise `strict_min_version` if
  a change starts relying on a newer Thunderbird API.
- **Experiment APIs require review.** This add-on uses privileged
  [experiment APIs](thunderbird/calendar) to access Thunderbird's calendar
  backend. Add-ons using experiments cannot be auto-signed like regular
  WebExtensions:
  - For **self-distribution/testing**, install the unsigned `.xpi` as a
    *temporary add-on* (`about:debugging`), or disable signature enforcement
    (`xpinstall.signatures.required = false` in `about:config`, only
    available on Developer/Nightly/ESR-unbranded builds).
  - For **public distribution**, the `.xpi` must be submitted to
    [addons.thunderbird.net](https://addons.thunderbird.net/) and goes
    through manual review before Mozilla/MZLA signs it.
- **Validate before shipping**: run `./build.ps1 -Lint` (or
  `web-ext lint --source-dir .` directly) to catch manifest/permission issues
  early; `web-ext` does not know about Thunderbird-specific experiment
  schemas, so warnings about unknown APIs there are expected and can be
  ignored.