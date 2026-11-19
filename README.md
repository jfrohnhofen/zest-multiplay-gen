# ZEST Multiplay Generator

An automated Google Apps Script project for theatre productions that parses master cue list spreadsheets in Google Sheets and generates [MultiPlay](http://www.da-share.com/software/multiplay/) 3.0 production cue files (`.mpp`), network cues (grandMA2 telnet, QLab OSC), a [QLab](https://qlab.app/) 5 AppleScript that builds the matching video cue list, and organized Google Drive asset bundles.

---

## Features

- **Google Sheets Cue List Parser**: Reads structured cue data directly from the active Google Sheet, including multi-track headers (LX, SX, VX) and Google Drive smart link chips.
- **MultiPlay 3.0 XML File Generator**: Outputs `.mpp` production files ready to load directly into MultiPlay.
- **Sound Cueing & Parameter DSL**:
  - File playback with local path resolution.
  - Parameter controls: `$loop`, `$fade-in-dur`, `$fade-out-dur`, `$delay`, `$volume`, `$start-pos`, `$stop-pos`.
  - Cue targeting & control actions: `#label` tags, `!stop`, `!pause`, `!resume`, `!fade-out`, and `!inc-volume`.
- **Network Cue Integration**:
  - **LX (Lighting)**: Sends Telnet login and `goto cue <X>` commands to grandMA2 consoles.
  - **VX (Video)**: Sends OSC `/cue/<X>/start` triggers to QLab for every cue with content in a video screen column.
- **QLab Video Cue List Generator**: Outputs an AppleScript that rebuilds the QLab video cue list from the sheet, with cue numbers matching the MultiPlay triggers.
  - Multiple screens (QLab stages), each with its own file and params column.
  - Video, image and live camera (`@camera`) cues, with automatic fade-ins and crossfades.
  - Auto-cues: rows without a cue number run in QLab by themselves, after the previous cue.
  - Parameter controls: `$fade-dur`, `$delay`, `$loop`, `$keep`, `$layer`.
  - Cue targeting & control actions: `#label` tags, `!fade-out`, `!stop`, `!pause` and `!resume`.
- **Asset Bundler**: Automatically creates Google Drive shortcuts for all referenced media files inside track-specific subfolders (`sound`, `video`, etc.) in the designated output folder. Files from all video screens are collected in one `video` folder.
- **Custom Google Sheets UI**: Adds a custom **ZEST** menu item directly to the spreadsheet toolbar for easy execution.

---

## Project Structure

```
.
├── appsscript.json   # Google Apps Script manifest (V8 runtime, Sheets v4 API)
├── main.js           # Configuration constants, spreadsheet parser, and UI menu bindings
├── multiplay.js      # MultiPlay XML template builder & parameter DSL parser
├── qlab.js           # QLab AppleScript generator & video parameter DSL parser
├── assets.js         # Google Drive media asset bundler
├── util.js           # Utility helpers (XmlService converter, drive helper, assertions)
├── flake.nix         # Nix development environment shell (Node.js + clasp)
└── LICENSE           # MIT License
```

---

## Spreadsheet Schema

The Google Sheet is structured as follows:

### Column Headers

Headers support multi-line values to denote track-specific properties (`track\nproperty`):

| Cue | Pg | Scene | Description | Sound<br>File | Sound<br>Params | Lights<br>Description | Video<br>Description | SL screen<br>File | SL screen<br>Params | SR screen<br>File | SR screen<br>Params |
|-----|----|-------|-------------|---------------|-----------------|--------------------|-------------------|-------------------|---------------------|-------------------|---------------------|
| `1` | 5  | Sc 1  | Opening     | `track1.mp3`  | `$fade-in-dur 2` | Warm amber wash    | Title graphic     | `title.png`       | `$fade-dur 3`       | `@camera`         | `#cam`              |

Rows without a cue number (empty, `-` or `n/a`) are not triggered by the operator: their video becomes QLab
auto-cues and their sound fires with the previous cue (see [Auto-cues](#auto-cues)); other columns are ignored. Header names are case-insensitive.

The video screen columns (`SL screen`, `SR screen`, … above) are not fixed: each screen listed in `QLAB_SCREENS`
gets a `<Screen>\nFile` and a `<Screen>\nParams` column, using the screen's key as the first header line. For a
single screen, `Video\nFile` and `Video\nParams` work as well. `Video\nDescription` is used to name the cues in
MultiPlay and QLab.

### Sound Parameter Syntax (`Sound\nParams`)

Sound cues support parameter controls (`$`) and cross-cue control actions (`!`) targeting cue labels (`#`):

#### Parameter Controls (`$`)
- `#<label>` — Assigns a targetable label name to the cue (e.g. `#bgm1`).
- `$loop [count]` — Sets the loop count.
- `$fade-in-dur <sec>` — Fade-in duration in seconds.
- `$fade-out-dur <sec>` — Fade-out duration in seconds.
- `$delay <sec>` — Pre-wait delay in seconds.
- `$volume <dB>` — Audio volume in dB.
- `$start-pos <sec>` — File start offset position in seconds.
- `$stop-pos <sec>` — File stop position in seconds.

#### Control Actions (`!`)
- `!stop <#label>` — Stops the targeted labeled cue.
- `!pause <#label>` — Pauses the targeted labeled cue.
- `!resume <#label>` — Resumes the targeted labeled cue.
- `!fade-out <#label>` — Fades out the targeted labeled cue.
- `!inc-volume <#label> +<dB>dB <fade_sec>` — Relative volume change over time.

---

## QLab Video Cues

**ZEST > Generate QLab script** writes `<SHOW_NAME>.applescript` to the output folder. Copy it to the QLab Mac,
open the show workspace, open the script in Script Editor and press **Run**. It deletes the cue list named
`QLAB_CUE_LIST_NAME` and rebuilds it, so re-run it whenever the sheet changes. Missing media files, unknown stage
names and cue numbers already used elsewhere in the workspace are listed in a dialog at the end. (The script
generates an AppleScript because a `.qlab5` workspace is an undocumented binary format with macOS file bookmarks.)

Each screen has its own column pair, `<Screen>\nFile` and `<Screen>\nParams`, configured in `QLAB_SCREENS`
(e.g. `SL screen`, `SR screen`, `Projector`). Each row with video becomes a QLab group with the sheet's cue number,
which MultiPlay starts via OSC `/cue/<X>/start`. Inside, numbered `<X>-1`, `<X>-2`, … (so tech inserts like `<X>.5` never collide): the new media, a fade-in,
and fade-and-stop cues for whatever it replaces on that screen.

### Auto-cues

A row with video but no cue number (empty, `-` or `n/a`) becomes a group `auto-1`, `auto-2`, … (numbered through the
whole show) that QLab starts by itself:

- by default when the previous cue ends (auto-follow), e.g. the next video after a clip finishes;
- with `$delay <sec>`, that many seconds after the previous cue starts (auto-continue plus pre-wait).

The previous cue is the row above with video, triggered or auto. If the triggered cue above has no video itself,
it gets an empty QLab group (and a MultiPlay VX trigger) for its auto-cues to follow. Images, `$loop` videos and
`@camera` never end, so an auto-cue without `$delay` after them starts `QLAB_DEFAULT_AUTO_DELAY` seconds (default 5)
after they start.

Sound in a row without a cue number is fired by MultiPlay together with the previous cue, after the row's sound
`$delay` (MultiPlay's pre-wait timer). It is timed independently of the row's video.

### File column

A file name (or Drive smart chip) inside `QLAB_MEDIA_FOLDER` on the QLab Mac, or `@camera` for a live camera cue.

### Video Parameter Syntax (`<Screen>\nParams`)

- `#<label>` — Names the media in this cell so later cues can target it.
- `$fade-dur <sec>` — Fade-in time of the new media and fade-out time of what it replaces (default `QLAB_DEFAULT_FADE`; `0` = cut).
- `$delay <sec>` — Pre-wait of the whole cue (all screens in the row). On an auto-cue, counted from the start of the previous cue.
- `$loop` — Loop the video forever.
- `$keep` — Keep what is already on this screen and layer the new media on top.
- `$layer <n>` — QLab video layer (higher is on top).
- `!fade-out [#label] [<sec>]` — Fade out and stop the labeled media, or everything on this screen (nothing if the screen is empty).
- `!stop [#label]` — Stop immediately (blackout), like `!fade-out`.
- `!pause [#label]` — Pause the labeled video, or everything playing on this screen (the frame stays on screen).
- `!resume [#label]` — Resume the labeled video, or everything paused on this screen.

---

## Configuration

Production settings are managed in [main.js](main.js):

- `SHOW_NAME`: Production identifier used for generated filenames (e.g. `"TGWDLM"`).
- `LOCAL_FOLDER`: Base local filesystem path for audio files (e.g. `C:\Users\ZEST\Desktop\TGWDLM`).
- `OUTPUT_FOLDER`: Google Drive Folder ID where generated `.mpp` / `.applescript` files and asset folders are written.
- **Network Patches**:
  - `MULTIPLAY_LX_NETWORK_PATCH`: Patch index for grandMA2 network connection.
  - `MULTIPLAY_SX_AUDIO_PATCH`: Patch index for audio channels.
  - `MULTIPLAY_VX_NETWORK_PATCH`: Patch index for QLab OSC connection.
- **Placeholders**: `MULTIPLAY_OUTPUT_LX_PLACEHOLDER_CUES` / `MULTIPLAY_OUTPUT_VX_PLACEHOLDER_CUES` add an LX / VX cue to every row, even without lighting / video content.
- **QLab**:
  - `QLAB_SCREENS`: Video screens, keyed by the lower-case first header line of their columns. `stage` is the QLab stage name, `label` a short name used in cue names (e.g. `{ "sl screen": { stage: "SL", label: "SL" } }`).
  - `QLAB_CUE_LIST_NAME`: Name of the generated QLab cue list (replaced on every run).
  - `QLAB_MEDIA_FOLDER`: Media folder on the QLab Mac, relative to the workspace file or absolute (default `video`).
  - `QLAB_DEFAULT_FADE`: Default fade-in / crossfade time in seconds.
  - `QLAB_DEFAULT_AUTO_DELAY`: Delay of an auto-cue without `$delay` after an image, loop or camera (default 5 s).

---

## Setup & Deployment for a New Project

### 1. Development Environment

If using Nix:

```bash
nix develop
```

Alternatively, install [clasp](https://github.com/google/clasp) globally using npm:

```bash
npm install -g @google/clasp
```

### 2. Login to Google Apps Script

Log in to your Google Account using `clasp`:

```bash
clasp login
```

### 3. Connect to a Google Apps Script Project

Since `.clasp.json` is not committed to the repository, initialize your local configuration using one of the following methods:

#### Option A: Create a New Script Bound to Google Sheets

To create a new standalone script or container-bound script:

```bash
clasp create --title "My Show MultiPlay Generator" --type sheets
```

This will automatically create a `.clasp.json` file in your project directory containing your new `scriptId`.

#### Option B: Link an Existing Google Apps Script Project

If you already created a script in Google Drive or container-bound to a Google Sheet:

1. Obtain your **Script ID** from your Apps Script project settings (`Project Settings` > `IDs` > `Script ID`).
2. Create a `.clasp.json` file in the project root directory:

```json
{
  "scriptId": "YOUR_SCRIPT_ID_HERE",
  "rootDir": ""
}
```

Or clone it directly using `clasp`:

```bash
clasp clone "YOUR_SCRIPT_ID_HERE"
```

### 4. Enable Google Sheets API v4

In the Google Apps Script web editor:
1. Go to **Services** (`+` button).
2. Add **Google Sheets API** (`sheets` v4).

### 5. Push Code

Deploy your code from your local environment to Google Apps Script:

```bash
clasp push
```

---

## Usage

1. Open the connected Google Sheet.
2. Click the **ZEST** menu item in the spreadsheet menu bar:
   - **Generate MultiPlay file**: Parses the sheet and writes `<SHOW_NAME>.mpp` to Google Drive.
   - **Generate QLab script**: Writes `<SHOW_NAME>.applescript`, which builds the QLab video cue list (see above).
   - **Bundle assets**: Organizes shortcuts to drive files into `sound/`, `video/`, etc. subfolders.
   - **Everything Everywhere All at Once**: Generates the MultiPlay file and the QLab script, and bundles assets.

---

## License

This project is licensed under the [MIT License](LICENSE).
