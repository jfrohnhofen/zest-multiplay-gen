# zest-multiplay-gen

An automated Google Apps Script project for theatre productions that parses master cue list spreadsheets in Google Sheets and generates [MultiPlay](http://www.da-share.com/software/multiplay/) 3.0 production cue files (`.mpp`), network cues (grandMA2 telnet, QLab OSC), and organized Google Drive asset bundles.

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
  - **VX (Video)**: Sends OSC `/cue/<X>/start` triggers to QLab.
- **Asset Bundler**: Automatically creates Google Drive shortcuts for all referenced media files inside track-specific subfolders (`sound`, `video`, etc.) in the designated output folder.
- **Custom Google Sheets UI**: Adds a custom **ZEST** menu item directly to the spreadsheet toolbar for easy execution.

---

## Project Structure

```
.
├── appsscript.json   # Google Apps Script manifest (V8 runtime, Sheets v4 API)
├── main.js           # Configuration constants, spreadsheet parser, and UI menu bindings
├── multiplay.js      # MultiPlay XML template builder & parameter DSL parser
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

| Cue | Pg | Scene | Description | Sound<br>File | Sound<br>Params | Lights<br>Description | Video<br>Description |
|-----|----|-------|-------------|---------------|-----------------|--------------------|-------------------|
| `1` | 5  | Sc 1  | Opening     | `track1.mp3`  | `$fade-in-dur 2` | Warm amber wash    | Title graphic     |

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

## Configuration

Production settings are managed in [main.js](file:///home/jf/Projects/archived/zest-multiplay-gen/main.js):

- `SHOW_NAME`: Production identifier used for generated filenames (e.g. `"TGWDLM"`).
- `LOCAL_FOLDER`: Base local filesystem path for audio files (e.g. `C:\Users\ZEST\Desktop\TGWDLM`).
- `OUTPUT_FOLDER`: Google Drive Folder ID where generated `.mpp` files and asset folders are written.
- **Network Patches**:
  - `MULTIPLAY_LX_NETWORK_PATCH`: Patch index for grandMA2 network connection.
  - `MULTIPLAY_SX_AUDIO_PATCH`: Patch index for audio channels.
  - `MULTIPLAY_VX_NETWORK_PATCH`: Patch index for QLab OSC connection.

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
   - **Bundle assets**: Organizes shortcuts to drive files into `sound/`, `video/`, etc. subfolders.
   - **Everything Everywhere All at Once**: Runs both generation and asset bundling.

---

## License

This project is licensed under the [MIT License](file:///home/jf/Projects/archived/zest-multiplay-gen/LICENSE).
