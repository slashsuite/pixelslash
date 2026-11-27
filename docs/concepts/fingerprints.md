# Fingerprints and environments

The same page renders differently on another machine. Fonts differ, the browser build differs, and text moves by a pixel. A fingerprint records what rendered a shot, so PixelSlash can tell a change in your code from a change in the machine.

## What a fingerprint is

Every shot's manifest entry records three things:

```text
fingerprint: {"image":"bare","browser":"chromium 156.0.8078.4","fonts":"sha256:2344…"}
```

- **`image`** is the capture image's digest (`PIXELSLASH_IMAGE_DIGEST`) when the run is given one. Inside the pinned image without that, it is `version:<v>`.
- **`browser`** is the browser and its version.
- **`fonts`** is a hash of every font file fontconfig can see, so installing one font changes it.

## `bare`

`bare` means the shot was taken outside the pinned image, using whatever browser and fonts this machine has. It works, and it warns you:

```text
warning: capturing outside the pinned PixelSlash image; local fonts skew rendering. Fingerprint recorded as bare.
```

A bare fingerprint is fine when both sides come from one machine. To get the same pixels on any machine, capture in [the pinned image](../cli.md#snapshot-capture-the-pinned-image).

PNGs brought in with `import` have the fingerprint `{ "image": "external", "browser": LABEL, "fonts": "unknown" }`, where `--renderer` gives the label.

## On your own machine: diffed with a warning

`compare` and `check` compare whatever you give them. You named both sides, so PixelSlash assumes you meant it. It warns on stderr and diffs anyway:

```bash
npx pixelslash compare snapshots/main snapshots/m4 --out cmp9
```

```text
warning: home (chromium 1280x720): rendered by a different image; diffing anyway
warning: pricing (chromium 1280x720): rendered by a different image; diffing anyway
pixelslash: 0 changed, 2 unchanged, 0 new, 0 removed
fingerprint: 2 differ (diffed anyway)
report: file:///…/my-site/cmp9/index.html
```

The report's index says so as well. A change here may be the font's and not yours.

## On a server: not compared

A server keeps a long history and many people rely on its verdict, so it doesn't guess. A shot from another environment is measured against nothing and is marked `rebaseline_needed`.

What happens next depends on the branch.

**On the default branch**, the shot is accepted and becomes the new baseline. This is how you move a project to a new environment:

```bash
PIXELSLASH_IMAGE_DIGEST=sha256:newimage2 npx pixelslash capture --upload --out snapshots/m4
```

```text
pixelslash: uploaded 2 snapshots
build: a981b89f-… (608fbfc on main)
```

**On any other branch**, the build errors, naming both environments, and `upload` exits 1. The build's page shows the same reason:

```text
3/3 shots sent and finalised; the failure came after
UPLOAD FAILED: build 4c98d50e-… errored on the server: 3 of 3 shots were captured in another environment than their baselines, so they were not compared. This build: image sha256:newimage, browser chromium 156.0.8078.4, fonts sha256:9e1c…. Its baseline: image bare, browser chromium 156.0.8078.4, fonts sha256:2344…. Upload from CI or the pinned capture image, so every build is captured in the same environment; to move the project to this environment, upload the default branch from it, then rebase this branch onto that commit and upload it again
```

Usually the branch was captured somewhere else by mistake, such as a laptop. Upload it again from CI or the pinned image, where the default branch was captured.

When the project is meant to move to the new environment:

1. Upload the default branch from the new environment.
2. Rebase your branch onto that commit.
3. Upload the branch again. It is measured against the default branch's new shots, whether the server diffs or CI does.

## Keeping them equal

- Capture Main and Branch in the same place. In CI, use the pinned image on both.
- Pin the browser and the CLI's version. [Pin your versions](../ci/pin-versions.md) has how.
- When you bring in PNGs with `import`, change the `--renderer` label when you change the tool or its version, and keep it stable otherwise.

A browser or font update is a good reason to re-baseline on purpose, as one change on the default branch.

## Next

- [Baselines and branches](baselines-and-branches.md): how a baseline is picked.
- [Pin your versions](../ci/pin-versions.md): keep the environment still.
- [Troubleshooting](../help/troubleshooting.md): the exact messages.
