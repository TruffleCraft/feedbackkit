# Masking and public-repo safety

Status: proposed concept for Gate 1, drafted 2026-11-10 (decision D-07 in [scope.md](scope.md)). It answers one question: how does a report with an image stay safe when its destination is a public GitHub repository, without making the widget hard to use?

## The problem

A report that lands in a public issue is readable by everyone. GitHub's image proxy also caches the image, so deleting it later does not recall it ([SECURITY.md](../SECURITY.md#camo-residual-risk)). The safe moment to protect data is therefore before the first byte leaves the visitor's browser.

What the code does today (read on 2026-11-10 at `3f3caba`):

| Fact | Where |
|---|---|
| A page screenshot is taken when the visitor presses the button, annotated in an editor, re-encoded to WebP at most 800 px wide, and uploaded when the visitor presses Send | `src/widget/index.ts:239`, `src/widget/lib/screenshot.ts:61-68`, `index.ts:301-305` |
| The capture filter skips only the widget's own host element. Nothing hides form values, password fields or marked elements | `src/widget/lib/screenshot.ts:58` |
| The annotation tools draw frames, arrows and text. None hides pixels | `src/widget/ui/annotate-model.ts` |
| A picked image uploads on pick and as the file itself, so metadata such as GPS stays. Removing it drops only the key | `src/widget/index.ts:396-404`, `src/widget/lib/api.ts:43-45` |
| The AI endpoint receives the stored image as a base64 data URL | `src/worker/orchestrate.ts:185`, `:459-468` |
| The page URL is cut to origin and path. Console capture is on by default and filtered by patterns for emails, tokens and long numbers | `index.ts:313`, `src/shared/contract.ts:154`, `src/widget/lib/pii-filter.ts` |

## What can leak

| Surface | Who can see it | Concept |
|---|---|---|
| Page pixels: the visitor's data, other people's data on the page, form values | Issue readers, GitHub's image proxy, the AI provider | Mask known sensitive elements before rasterizing, let the visitor mask the rest, bake the result |
| A picked image: photos, other windows | Same | Keep it in the browser until Send, mask it the same way, re-encode it to drop metadata |
| Console text | Issue readers | Off in the strict profile. The pattern filter stays as a second layer |
| Text the visitor types | Issue readers | A visible hint that the report may be public. No detection |
| Context the host page passes in | Issue readers | Documented as public in the strict profile |
| Page URL, device info | Issue readers | Unchanged: origin and path only, browser and viewport |

## Principles

1. Nothing leaves the browser until the visitor confirms exactly what will be sent.
2. A mask is destroyed pixels, baked into a re-encoded image. An overlay, a blur or a pixelation is not a mask.
3. Safe defaults beat settings. New projects start strict.
4. The server enforces what it can verify and says plainly what it cannot. It cannot see inside a pixel.
5. We promise no detection. We protect what the host page marks and what we know is sensitive, and we give the visitor a tool for the rest.

## The concept

### One profile per project

`privacy.profile` is `strict` or `standard`.

| Control | strict | standard |
|---|---|---|
| Form values and password fields in a capture | masked | masked |
| Elements with `data-fk-private` | blocked out | blocked out |
| Images stay in the browser until Send, then are re-encoded | yes | yes |
| Review screen with the final image and a mask tool | required for every image | offered |
| Server requires the widget marker on uploads | yes | no |
| Console capture | off | as configured |
| Hint "this report may be public" | when the destination is public or unknown | never |

New projects start strict. `standard` is allowed only for destinations that are private: the local inbox, and a GitHub repository or Project that the gateway has read as private. A public or unreadable destination forces strict, and the config check refuses `standard` with a clear error.

### How the gateway knows a repository is public

With the project's token, the config check, the deep `/diag` and the test report read the repository from the GitHub API. The response has a `private` flag. This repository answers `private=false` today. A failed or unauthorized read counts as unknown, and unknown counts as public.

### The image path

![Image path in the strict profile](diagrams/privacy-image-path.png)

[Open the explorable diagram](diagrams/privacy-image-path.html).

1. The visitor adds a screenshot or picks an image. Nothing is uploaded.
2. For a page capture, the widget clones the DOM, blocks out marked elements, masks form values and password fields, and rasterizes the clone. A picked image skips this step.
3. The review screen shows the final image. The visitor adds opaque rectangles over anything else, or removes the image.
4. On Send the widget bakes the image: it re-encodes from a canvas, so metadata is gone and every mask is an opaque pixel.
5. The widget uploads the baked bytes with a marker, then sends the report with the returned key.
6. The AI endpoint and the issue link receive the same stored bytes.

### The server contract

| Check | strict | standard |
|---|---|---|
| Marker present, else 409 | yes | no |
| Magic bytes, size cap, image only (exists today) | yes | yes |
| No metadata segments in the file (EXIF, XMP, text chunks), else 400 | yes | no |
| An upload that no report claims expires | yes | yes |

The marker keeps honest but outdated clients out. It does not stop a client that forges it. That client belongs to the visitor, who can only leak their own data. The host page is the other risk, and the host page controls the widget's environment anyway.

### The host page

A site marks what must never appear: `data-fk-private` on any element. Password fields need no mark. The widget documentation lists both.

### What we do not promise

- Detection of personal data in pixels or in text.
- Protection against a visitor who chooses to send data.
- Recall of an image that GitHub's proxy has already cached.
- Protection against a malicious host page.

## Acceptance

One Chromium test intercepts every request body and decodes the images.

| Test | Proves |
|---|---|
| A page with sentinel pixels, a sentinel in an input and in a marked element. The uploaded image has opaque fill in those regions and no sentinel. The same test with masking off fails | Masks are destroyed pixels, and the test can fail |
| The same assertions for capture, pick, paste, drop and retry | Every input path is covered |
| Zero upload requests before Send, one per image after | Staging works |
| A JPEG with GPS metadata is picked. The uploaded bytes contain no metadata | Metadata is dropped |
| A strict project refuses an upload without the marker (409) and one with metadata (400), and accepts a baked image | The server contract |
| The bytes the AI endpoint receives hash equal to the stored bytes | One image, one truth |
| A mocked GitHub answers `private: false`, `true` and an error. The profile is forced, allowed, and forced | The visibility rule |

Whether the current capture copies input values is not verified yet. The sentinel test answers it, and the fix is part of Gate 1.

## Rollout inside Gate 1

1. Widget: staging, re-encode, review screen and mask tool. Mock before build. The mask tool loads on demand, because the widget budget has 0.2 kB gz left.
2. Widget: automatic layer (form values, password fields, `data-fk-private`).
3. Gateway: profile setting, visibility check, marker and metadata checks, error codes in `docs/ERRORS.md`.
4. Tests and documentation, with the claim table of Step C updated.

## Open points for the PRs

- The marker's name and the new error codes.
- Wording of the public hint and the review screen, with `en` and `de` keys.
- Whether an operator may override the console default inside `standard`.

Co-created by Michel with NORA (AI Agent)
