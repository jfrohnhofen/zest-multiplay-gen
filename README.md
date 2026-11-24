# ZEST Multiplay Generator

An automated Google Apps Script project for theatre productions that parses master cue list spreadsheets in Google Sheets and generates [MultiPlay](http://www.da-share.com/software/multiplay/) 3.0 production cue files (`.mpp`), network cues (grandMA2 telnet, QLab OSC), a [QLab](https://qlab.app/) 5 AppleScript that builds the matching video cue list, and organized Google Drive asset bundles.

---

## Features

- **Google Sheets Cue List Parser**: Reads structured cue data directly from the active Google Sheet, including multi-track headers (LX, SX, VX) and Google Drive smart link chips.
- **MultiPlay 3.0 XML File Generator**: Outputs `.mpp` production files ready to load directly into MultiPlay.
- **Cue Triggers**: A `Trigger` column says how each row starts: operator `go`, `continue +Ns` after the block's GO, or `follow #label +Ns` after a labeled sound ends (see [Cue Triggers](#cue-triggers)).
- **Sound Cueing & Parameter DSL**:
  - File playback with local path resolution.
  - Parameter controls: `$loop`, `$fade-in-dur`, `$fade-out-dur`, `$volume`, `$start-pos`, `$stop-pos`.
  - Cue targeting & control actions: `#label` tags, `!stop`, `!pause`, `!resume`, `!fade-out`, and `!inc-volume`.
- **Network Cue Integration**:
  - **LX (Lighting)**: Sends Telnet login and `goto cue <X>` commands to grandMA2 consoles.
  - **VX (Video)**: Sends OSC `/cue/<X>/start` triggers to QLab for every cue with content in a video screen column.
- **QLab Video Cue List Generator**: Outputs an AppleScript that rebuilds the QLab video cue list from the sheet, with cue numbers matching the MultiPlay triggers.
  - Multiple screens (QLab stages), each with its own file and params column.
  - Video, image and live camera (`@camera`) cues, with automatic fade-ins and crossfades.
  - Parameter controls: `$fade-dur`, `$loop`, `$keep`, `$layer`, `$rotate`, `$scale`.
  - Cue targeting & control actions: `#label` tags, `!fade-out`, `!stop`, `!pause` and `!resume`.
  - An update script that changes the existing cue list in place and keeps the changes made in QLab, after showing a
    preview of the changes to approve (see [Updating the cue list](#updating-the-cue-list)).
- **Asset Bundler**: Automatically creates Google Drive shortcuts for all referenced media files inside track-specific subfolders (`sound`, `video`, etc.) in the designated output folder. Files from all video screens are collected in one `video` folder.
- **Custom Google Sheets UI**: Adds a custom **ZEST** menu item directly to the spreadsheet toolbar for easy execution.

---

## Project Structure

```
.
├── appsscript.json   # Google Apps Script manifest (V8 runtime, Sheets v4 API)
├── main.js           # Configuration constants, spreadsheet parser, and UI menu bindings
├── schedule.js       # Cue triggers: trigger parser, blocks / anchors resolution and validation
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

| Cue | Trigger | Pg | Scene | Description | Sound<br>File | Sound<br>Params | Lights<br>Description | Video<br>Description | SL screen<br>File | SL screen<br>Params | SR screen<br>File | SR screen<br>Params |
|-----|---------|----|-------|-------------|---------------|-----------------|--------------------|-------------------|-------------------|---------------------|-------------------|---------------------|
| `Q1` | `go`   | 5  | Sc 1  | Opening     | `track1.mp3`  | `$fade-in-dur 2` | Warm amber wash    | Title graphic     | `title.png`       | `$fade-dur 3`       | `@camera`         | `#cam`              |

Every active row needs its own unique cue id (`Q12` or `Q12.5`; it is used in OSC addresses and as QLab cue number). The `Trigger` column is required and says how the row
starts, see [Cue Triggers](#cue-triggers); rows with the trigger `skip` are ignored, and so are completely empty rows. Header names are case-insensitive.

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

## Cue Triggers

The sheet is the single source of truth: every active row has its own unique id and produces at most one command per
program (MultiPlay for sound and lights, QLab for video). The `Trigger` column says how the row starts:

```
trigger := skip | go | continue [+<N>s] | follow #<label> [+<N>s]
```

| Trigger | Meaning |
|---------|---------|
| `skip` | Ignored (deliberately disabled). |
| `go` | The operator triggers it in MultiPlay. Has no delay. |
| `continue [+Ns]` | Starts N s after the GO of the block's head (0 if omitted). |
| `follow #label [+Ns]` | Starts N s after the labeled sound of an earlier row ends. |

A **block** is a `go` row (the head) plus the non-`go` rows below it, up to the next `go`. `continue` counts from the
head, never from the previous row, so inserting a row never shifts other timings. The first active row must be `go`.

All delays live in MultiPlay (QLab groups are started via OSC); only sounds can be followed. For a video use `continue +Ns`.

| Trigger | MultiPlay | QLab | grandMA |
|---------|-----------|------|---------|
| `go` | Manual cue with SX / LX / VX lines chained | Group `<id>`, started by OSC | `goto cue <id>` from MultiPlay |
| `continue +N` | SX / LX / VX lines chained to the head, with a pre-wait | Group started via OSC | `goto cue <id>` from MultiPlay |
| `follow` a sound | Follow-on-end after the sound, plus a pre-wait of N | Group started via OSC | `goto cue <id>` from MultiPlay |

Validation (errors with row numbers; no output is written):

- `follow #label`: the label must be defined on a sound in an earlier row of the same block. The sound has to end, so
  looping sounds are errors, and so is a label on a video: use `continue +Ns` there.
- No row between the sound and the follower may stop, pause or fade the sound.
- `continue` offsets within a block must not decrease.
- Several followers of one label are allowed.
- A MultiPlay cue starts one successor, so a sound that has followers must be the last cue of its chain: no `continue`
  row may come after the row with that sound.

MultiPlay pre-waits are stored as the difference to the previous cue of the chain (hence non-decreasing offsets).
Placeholder cues (`MULTIPLAY_OUTPUT_*_PLACEHOLDER_CUES`) are only added to `go` rows.

Cue ids are upper-cased (`q12` becomes `Q12` in MultiPlay, QLab and the OSC addresses). In MultiPlay's cue list only the
head of a block (the `go` cue) is green; all other cues are grey, and `continue` / `follow` cues have `[AUTO]` in front of the
cue number.

---

## QLab Video Cues

**ZEST > Generate QLab script** writes two AppleScripts to the output folder. Copy them to the QLab Mac, open the
show workspace, open a script in Script Editor and press **Run**:

- `<SHOW_NAME>.applescript` deletes the cue list named `QLAB_CUE_LIST_NAME` and rebuilds it from the sheet.
- `<SHOW_NAME> update.applescript` updates that cue list in place and keeps the changes made in QLab, see
  [Updating the cue list](#updating-the-cue-list).

Missing media files, unknown stage names and cue numbers already used elsewhere in the workspace are listed at the
end (in a dialog, or on the preview page of the update script). (The script generates an AppleScript because a
`.qlab5` workspace is an undocumented binary format with macOS file bookmarks.)

Each screen has its own column pair, `<Screen>\nFile` and `<Screen>\nParams`, configured in `QLAB_SCREENS`
(e.g. `SL screen`, `SR screen`, `Projector`). Each row with video becomes a QLab group with the sheet's cue number,
which MultiPlay starts via OSC `/cue/<X>/start` (after the row's pre-wait, see [Cue Triggers](#cue-triggers)). Inside, numbered `<X>-1`, `<X>-2`, … (so tech inserts like `<X>.5` never collide): the new media, a fade-in,
and fade-and-stop cues for whatever it replaces on that screen.

The first line of each generated cue's Notes is a key like `zest:Q12/Window/media`. It says what the cue does for
the sheet, independently of its cue number. The second line remembers the values the sheet set, like
`name=Window: a.mp4|file=a.mp4|opacity=0|…` (times and opacities in thousandths). Don't edit these two lines in QLab.

### Updating the cue list

The update script finds the cues it generated before by their keys, so it doesn't depend on cue numbers:

- **The sheet controls** each cue's name, file, stage, opacity, loop, layer, rotation, scale, fade duration, stop-when-done, pre-wait
  and continue mode, and the cue numbers, targets and order.
- **The second line of the Notes remembers the sheet's values from the last run.** That tells the script who changed
  a value since then:
  - Only the sheet changed it: the script sets the sheet's value.
  - Only QLab changed it: the script keeps the QLab value, until the sheet changes it again.
  - Both changed it: the script keeps the QLab value, unless you choose the sheet's in the preview (see below).
- **QLab controls everything else**, e.g. geometry, effects, levels, colours and notes below the first two lines.
  Cues without a key (added by hand) are left alone, and stay right after the cue they follow.
- **New rows** get new cues. **Removed rows** keep their cues, but switched off for you to delete: disarmed, without
  a number, red, named `REMOVED …`, and moved to the end of the cue list. If the row comes back, so do its cues. A cue
  whose type changes (e.g. a video that becomes `@camera`) is replaced, and the old one marked as removed.
- **Moved rows** keep their keys, so their cues keep their QLab changes and move to the row's new place.
- **Renamed rows** (a new cue id) get new keys, so they would look like a removed row plus a new one. If a removed row
  and a new row show the same files on the same screens (and no other removed or new row does), the script treats it
  as renamed, unless you choose otherwise in the preview (see below). Then its cues keep their QLab changes and get the
  new keys and numbers.

Before changing anything, the script shows all changes on a page in Safari, saved next to the workspace (or on the
Desktop) as `<QLAB_CUE_LIST_NAME> update <date> <time>.html`. It has a section for each row that changes, with a line
for each change. A new row, a row removed from the sheet, and a row renumbered with all its cues (e.g. renamed) are a
single line, as are the cue names that only change with a new file and a cue replaced by a new one (e.g. a fade-out of
other media); the details are one click away. The rows are in sheet order, green when new, yellow when changed and red
when removed from the sheet. The page is always dark, like QLab.

```
+ new   ~ changed   # renumbered   > moves   - marked as removed   ^ back from removed   = kept from QLab   ! problem
```

The renamed rows and the values changed in both places are questions at the top; the changes below follow the answers
right away. **Apply** makes the changes in QLab, **Cancel** (or closing the page) leaves the cue list unchanged. After
applying, the script adds the result and any problems to the page and saves it again, so the pages are also a log of
the updates.

The script reads the page through Safari, which needs a one-time setting: in Safari's Settings > Advanced, turn on
**Show features for web developers**, then turn on **Develop > Allow JavaScript from Apple Events**. The script says so
if it is off.

A workspace built before keys existed has none, so the update script would add a second copy of every cue. Run the
rebuild script once first.

### File column

A file name (or Drive smart chip) inside `QLAB_MEDIA_FOLDER` on the QLab Mac, or `@camera` for a live camera cue.

### Video Parameter Syntax (`<Screen>\nParams`)

- `#<label>` — Names the media in this cell so later cues can target it.
- `$fade-dur <sec>` — Fade-in time of the new media and fade-out time of what it replaces (default `QLAB_DEFAULT_FADE`; `0` = cut).
- `$loop` — Loop the video forever.
- `$keep` — Keep what is already on this screen and layer the new media on top.
- `$layer <n>` — QLab video layer (higher is on top).
- `$rotate <degrees>` — Rotate the media around the Z axis, e.g. `90` or `-90` (whole degrees). The script sets the
  cue's Geometry mode to Custom and rotates it with OSC, as AppleScript can't. If the workspace doesn't allow OSC
  without a passcode (Workspace Settings > Network > OSC Access), the script asks for the passcode with Edit
  permission; it isn't saved. Like `$layer`, the sheet only controls the rotation of cues that have `$rotate`.
- `$scale <factor>` — Scale the media horizontally and vertically by this factor, e.g. `1.8`. The script sets the cue's
  Geometry mode to Custom and both scale values.
- `$scale fit`, `$scale fill`, `$scale stretch` — Fill Stage, fitting the media in the stage, filling it (cropping the
  media) or stretching it. These can't be combined with `$rotate`, which needs Geometry mode Custom: use a factor.
- Without `$scale`, a video is in Fill Stage with `fill`. A rotated one stays in Custom; if it had a `$scale` before, it
  goes back to scale 1. A live camera's scale is only set by `$scale` (removing it puts the camera back in Fill Stage).
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
  - `QLAB_CUE_LIST_NAME`: Name of the generated QLab cue list.
  - `QLAB_MEDIA_FOLDER`: Media folder on the QLab Mac, relative to the workspace file or absolute (default `video`).
  - `QLAB_DEFAULT_FADE`: Default fade-in / crossfade time in seconds.

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
   - **Generate QLab script**: Writes `<SHOW_NAME>.applescript` and `<SHOW_NAME> update.applescript`, which build or update the QLab video cue list (see above).
   - **Bundle assets**: Organizes shortcuts to drive files into `sound/`, `video/`, etc. subfolders.
   - **Everything Everywhere All at Once**: Generates the MultiPlay file and the QLab script, and bundles assets.

---

## License

This project is licensed under the [MIT License](LICENSE).
