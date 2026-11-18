// Name of the current show/production.
const SHOW_NAME = "RENT";

// Target local filesystem base directory path for show assets.
const LOCAL_FOLDER = `C:\\Users\\ZEST\\Desktop\\${SHOW_NAME}`;

// Google Drive folder ID where generated output files and assets are stored.
const OUTPUT_FOLDER = "1RwTI0YfCxGI4Qk3Ubm5ZenbZKnNTJEfC";

// Patches configured in MultiPlay.
const MULTIPLAY_LX_NETWORK_PATCH = 0;
const MULTIPLAY_SX_AUDIO_PATCH = 1;
const MULTIPLAY_VX_NETWORK_PATCH = 1;

const MULTIPLAY_OUTPUT_LX_PLACEHOLDER_CUES = true;
const MULTIPLAY_OUTPUT_VX_PLACEHOLDER_CUES = false;

// QLab video screens. Keys are the (lower-case) first header line of the sheet's video columns: each screen has
// a `<screen>\nfile` and a `<screen>\nparams` column. `stage` is the name of the QLab video stage it plays on.
// `label` is a short screen name used in the QLab cue names.
const QLAB_SCREENS = {
  "sl screen": { stage: "Window", label: "Window" },
  "sr screen": { stage: "Fence", label: "Fence" },
  "projector": { stage: "Projector", label: "Projector" },
};

// Name of the QLab cue list the generated script (re)creates. Anything in it is replaced on every run.
const QLAB_CUE_LIST_NAME = "ZEST - RENT - video";

// Folder with the video / image files on the QLab Mac, relative to the workspace file (or an absolute path).
const QLAB_MEDIA_FOLDER = "video";

// Default fade-in / crossfade time in seconds when a cell has no $fade-dur.
const QLAB_DEFAULT_FADE = 1;

// Delay in seconds of an auto-cue without $delay after an image, a loop or the camera (which never end by themselves).
const QLAB_DEFAULT_AUTO_DELAY = 5;

/**
 * Parses the active Google Sheet into an array of structured cue objects.
 * 
 * Column headers dictate property names. Headers with newline characters are split into track and property
 * (e.g. `sound\nfile` maps to `cue.tracks.sound.file`).
 * Handles rich link smart chips by extracting their URI and display name.
 */
function parseCuelist() {
  // 1. Read content of the active sheet of the spreadsheet.
  const id = SpreadsheetApp.getActiveSpreadsheet().getId();
  const sheetName = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();
  const range = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getDataRange();

  const response = Sheets.Spreadsheets.get(id, {
    ranges: [`${sheetName}!${range.getA1Notation()}`],
    fields: "sheets(data(rowData(values(formattedValue,chipRuns))))"
  });
  let rows = response.sheets[0].data[0].rowData;
  const headers = rows[0].values.map(x => x.formattedValue.toLowerCase().split("\n"));
  rows = rows.slice(1);

  // 2. Determine types of cues (e.g. lights, video, led, sound). Each type may have columns with the same prefix (e.g. "lights\ndescription").
  let tracks = new Set();
  for (const header of headers) {
    if (header.length > 2) {
      throw new Error("invalid header");
    }
    if (header.length > 1) {
      tracks.add(header[0]);
    }
  }
  console.log("Found cues for", [...tracks].join(", "));

  // 3. Parse each row as a cue.
  let cues = [];
  for (const row of rows) {
    cue = { tracks: {} };
    const values = row.values.map(x => x.chipRuns ? { uri: x.chipRuns[0].chip.richLinkProperties.uri, name: x.formattedValue.trim() } : x.formattedValue);
    for (const [i, value] of values.entries()) {
      if (value == null) {
        continue;
      }
      const header = headers[i];
      if (header.length > 1) {
        cue.tracks[header[0]] = cue.tracks[header[0]] || {};
        cue.tracks[header[0]][header[1]] = value;
      } else {
        cue[header[0]] = value;
      }
    }

    // Rows without a cue number are kept if they have track content: they may hold QLab auto-cues.
    if (cue.cue || Object.keys(cue.tracks).length > 0) {
      cues.push(cue);
    }
  }

  return cues;
}

/**
 * True for rows that MultiPlay doesn't trigger: no cue number, `-` or `n/a`. QLab runs their video automatically
 * after the previous cue (see generateQlab).
 */
function isAutoCue(cue) {
  return ["", "-", "n/a"].includes(String(cue.cue ?? "").trim().toLowerCase());
}

/**
 * Adds the custom "ZEST" menu to the Google Sheets user interface for running generators.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("ZEST")
    .addItem("Generate MultiPlay file", "generateMultiplay")
    .addItem("Generate QLab script", "generateQlab")
    .addItem("Bundle assets", "bundleAssets")
    .addItem("Everything Everywhere All at Once", "updateAll")
    .addToUi();
}

/**
 * Master generator function ("Everything Everywhere All at Once").
 * Parses the cuelist once and triggers MultiPlay production generation,
 * QLab script generation and asset bundling.
 */
function updateAll() {
  const cues = parseCuelist();
  generateMultiplay(cues);
  generateQlab(cues);
  bundleAssets(cues);
}
