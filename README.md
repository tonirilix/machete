<img src="resources/icon.png" alt="Machete Folded M icon" width="96" height="96" align="right" />

# Machete

A small desktop space for useful text. Save a command, a link, or a thought;
organize clips into boards; find and copy them when you need them again.

Built for macOS with Electron, React, TypeScript, Tailwind CSS, and shadcn/ui.

## Download and install

1. Open [GitHub Releases](https://github.com/tonirilix/machete/releases) and expand
   the release's **Assets**. Development builds are marked **Pre-release**.
2. Download the DMG ending in `-arm64.dmg` for Apple Silicon (M1 or later), or
   `-x64.dmg` for Intel. ZIP downloads and SHA-256 checksums are also available.
3. Quit the existing Machete app before replacing it. Closing its window leaves
   it running; right-click the menu bar icon and choose **Quit Machete**.
4. Open the disk image, drag **Machete** into Applications, and launch the installed
   copy. Then [enable selection capture](#enable-selection-capture-on-macos).

Your collection is stored separately from the app; replacing `Machete.app` keeps
your saved clips and boards.

The downloads are ad-hoc signed, not notarized by Apple. If macOS blocks the first
launch and you trust the download, follow
[Apple’s opening instructions](https://support.apple.com/en-us/102445).
Updates can also require removing and re-adding Accessibility permission, even
when Machete's switch is already enabled. See
[capture stops working after an update](#capture-stops-working-after-an-update).

## Use Machete

The app opens a compact window and stays in the menu bar when the window closes.
On macOS it keeps a Dock icon as well as its menu bar icon.
Right-click the menu bar icon to quit. New collections start with an empty Inbox.

- **Cmd+Shift+Space:** capture selected text from another app on macOS; capture
  copied text on other platforms. Each capture saves a separate clip in Inbox,
  without opening an editor or changing your manual draft.
- **New clip / Resume draft** or **Cmd+N:** compose a manual draft. Use **Append
  clipboard** inside the editor to collect multiple pieces into that draft, then
  save them as one clip. Shortcut captures always save separate clips.
- **Enter:** insert a newline in the editor.
- **Cmd+Enter:** save a clip.
- **Cmd+K:** focus search while browsing.
- **Cmd/Shift+click:** select clips; **Cmd+C** copies them in visible order.
- **Escape:** dismiss the active dialog/editor or clear selection/search. Keeps the app visible.

Change the capture shortcut in Settings if it conflicts with another app.

On macOS, Settings → Capture shortcut also offers **Double Shift**. Tap and
release the same Shift key twice quickly. Both left and right Shift work. Held
keys, typing, other modifiers, clicking, or changing apps cancel the gesture.
Double Shift uses the same Accessibility permission as selection capture and
does not consume keystrokes. It observes key events only to recognize the gesture
and never records typed text.

### Enable selection capture on macOS

In Machete Settings, click **Enable selection capture**, then allow
**Machete** under **Privacy & Security → Accessibility** in System Settings.
Return to another app, select text, and press your capture shortcut (default:
**Cmd+Shift+Space**). The selection is saved immediately as a new clip in Inbox.
Use the installed, packaged app when granting permission; development mode runs
under Electron's identity. If the app does not recognize a new grant, quit and
reopen it.

The app reads selections only when you invoke the shortcut. It first asks the
source app for accessible selected text. When unavailable, it sends Copy and
restores the previous clipboard's formats, unless something newer was copied.
Unsupported selections produce a message. You can copy the text yourself and use
**New clip → Append clipboard**, then save the draft. The menu bar also offers
**Append clipboard to draft**. There is no background clipboard monitoring.

### Capture stops working after an update

Downloaded and locally packaged builds currently use ad-hoc signing. macOS ties
the permission to a particular build, so an existing **Machete** entry can still
refer to the previous version. Turning that entry off and on may not refresh it.
[Apple explains how signing affects permission identity](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

If selection capture or Double Shift stops working after an update:

1. Quit Machete using **Quit Machete** in its menu bar menu.
2. Open **System Settings → Privacy & Security → Accessibility**.
3. Select the old **Machete** entry and remove it with the minus button.
4. Use the plus button to add the newly installed `Machete.app`, then enable its
   switch. Choose the same copy you launch, such as `/Applications/Machete.app`
   or `~/Applications/Machete.app`.
5. Reopen Machete, select text in another app, and try the capture shortcut again.

## Data

The desktop app keeps `collection.json` in
`~/Library/Application Support/Cliptoboards/`. Clips, boards, Trash, the unfinished
draft, and shortcut settings are stored locally. Writes are serialized and use a
temporary file followed by a rename; failed writes do not replace the in-memory
collection. An unreadable collection is left intact and reported at startup.

Settings provides simple JSON export/import. Export includes boards, saved clips,
and Trash. Import validates the file and asks for confirmation before replacing
the collection; the local shortcut is preserved and the unfinished draft is
cleared. Drafts and device settings are not part of the portable backup.

Machete keeps the original `Cliptoboards` collection directory, backup format
identifier, and macOS bundle identifier for compatibility with existing data and
installations. The app and npm package are now named Machete and `machete`.

Collections are local to one Mac. Use export/import to transfer them between
devices; automatic synchronization is future work.

## Development

Use Node.js 22.12+ and npm from a checkout of this repository. Running the macOS
app from source also requires Xcode Command Line Tools to build the native
selection bridge.

```sh
npm ci
npm run dev
```

Set `MACHETE_DATA_DIR` to a separate directory when testing with disposable
desktop data.

### Browser preview

```sh
npm run dev:web
```

Open `http://localhost:5173`. The browser preview uses a separate collection in
browser storage and browser clipboard permissions. It shares the desktop UI and
domain logic. Native tray access, global shortcuts, and desktop focus behavior
require the Electron app.

### Check and package

```sh
npm run typecheck
npm test
npm run test:native
npm run test:desktop
npm run build
npm run pack
npm run dist:mac
npm run test:launch
npm run test:selection
```

`pack` creates an ad-hoc signed local macOS application in `release/`. This needs
no Apple account and does not notarize the app. A persistent Apple signing identity,
notarization, and automatic updates remain future distribution work.

Open the packaged `Machete.app` under `release/mac/` for x64 builds or
`release/mac-arm64/` for arm64 builds. For example, an x64 build launches with
`open release/mac/Machete.app`. Running that command again brings the existing
window forward.

The app uses the Folded M icon. Its 1024px master is `resources/icon.png`;
after replacing it, run `npm run build:icons` on macOS to regenerate the `.icns`,
header icon, and browser favicon. These generated assets are checked in so
release builds use them without running image conversion tools.

### Automatic checks

The **CI** workflow runs TypeScript checks and unit tests for pull requests and
pushes to `main`. It uses one standard Ubuntu runner, cancels superseded runs,
and retains no artifacts or dependency caches. Like the release workflow, it
only runs for public repositories. Each new commit pushed to an open PR starts
a fresh check; merging into `main` triggers a push check too.

### Release builds

Installer builds use a separate workflow with manual and version-tag triggers.

To create installers, open **Actions → Build macOS release →
Run workflow**, select a branch, and run it. This publishes a development
prerelease named `build-<run-id>` with a unique `-dev.<run-id>` app version. It
does not replace the latest stable release.

For a versioned release, commit a version bump in both `package.json` and
`package-lock.json` (for example, `npm version patch --no-git-tag-version`), then
push a matching tag such as `v0.1.1`. Tags must exactly match `v<package version>`.
Versions containing a prerelease suffix, such as `0.2.0-beta.1`, remain prereleases.

The workflow runs tests, compiles the native module separately on standard Intel
and Apple Silicon macOS runners, and creates a DMG and ZIP for each architecture.
It checks signatures and architectures, then uploads the installers and checksums
directly to a draft GitHub Release. Only after both builds pass is the release
published. Failed runs leave an unpublished draft; rerunning resumes that draft.
Published releases are never overwritten, and previous releases are retained.

No Actions artifacts or dependency caches are uploaded. The workflow only runs
for public repositories, where standard hosted runners are free. Downloads live
in GitHub Releases, which has separate storage from the Actions artifact allowance.
See [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
Account billing budgets are managed separately in GitHub Settings; this workflow
does not change them. No Apple signing credentials are required for these ad-hoc
builds; Developer ID signing, notarization, and automatic app updates remain separate work.

### Desktop and native checks

Packaged launch and selection scripts default to `release/mac/Machete.app`.
For an arm64 build, pass `release/mac-arm64/Machete.app` as the first argument to
each `scripts/check-macos-*.mjs` script, or use
`npm run test:selection -- release/mac-arm64/Machete.app` for the selection check.

The macOS launch check requires a desktop session, Xcode Command Line Tools, and
an existing packaged app. It checks five fresh launches without a debugger,
including launches with `ELECTRON_RUN_AS_NODE=1` from Electron-hosted terminals.
It verifies visible windows and a visible Dock role through macOS, then tests
reopening after hiding, closing, and minimizing. It uses temporary copies with
disposable data and leaves the clipboard untouched. A separate startup check
quits during the initial page load and verifies that shutdown finishes without
showing a startup error.

The desktop smoke test runs the actual Electron app with disposable data and
restores the system clipboard after checking the native bridge. Desktop launch
scripts handle terminals hosted inside other Electron apps, including T3.
The packaged app disables Electron's RunAsNode mode so those terminals cannot
accidentally launch it as a Node process instead of opening its window.

Building the macOS selection bridge requires Xcode Command Line Tools. Native
pasteboard tests use a separate named pasteboard and leave the system clipboard
untouched. The native binary is built for the current architecture and unpacked
beside the packaged app's resources.

The selection check requires Accessibility permission for the packaged app. It
briefly opens native test windows and checks immediate selection saving, draft preservation,
the Copy fallback, clipboard restoration, and explicit saving. It uses a
disposable collection, then reopens the app with your usual collection.

See [the MVP brief](docs/design.md), [domain vocabulary](GLOSSARY.md), and
[architecture decisions](docs/adr/).
