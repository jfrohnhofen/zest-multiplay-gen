// Name of the current show/production.
const SHOW_NAME = "RENT";

// Target local filesystem base directory path for show assets.
const LOCAL_FOLDER = `C:\\Users\\ZEST\\Desktop\\${SHOW_NAME}`;

// Google Drive folder ID where generated output files and assets are stored.
const OUTPUT_FOLDER = "1_yVMIcbWtE49IguFixpRchhYeve1zBwg";

// Patches configured in MultiPlay.
const MULTIPLAY_LX_NETWORK_PATCH = 0;
const MULTIPLAY_SX_AUDIO_PATCH = 1;
const MULTIPLAY_VX_NETWORK_PATCH = 1;

const MULTIPLAY_OUTPUT_LX_PLACEHOLDER_CUES = true;
const MULTIPLAY_OUTPUT_VX_PLACEHOLDER_CUES = false;

// Plain columns (i.e. without a track prefix) that are used by the generators.
const KNOWN_COLUMNS = new Set(["cue", "pg", "scene", "line", "description"]);

/**
 * Parses the active Google Sheet into an array of structured cue objects.
 * 
 * Column headers dictate property names. Headers with newline characters are split into track and property
 * (e.g. `sound\nfile` maps to `cue.tracks.sound.file`).
 * Handles rich link smart chips by extracting their URI and display name.
 *
 * Each cue carries the sheet row it was parsed from (`cue.row`, 1-based, including the header row).
 *
 * Warnings and errors are logged via a "parse" context before returning. Returns an empty array if there were any
 * errors, so that the generators have nothing to do and leave existing output untouched.
 */
function parseCuelist() {
  const ctx = new Context("parse");
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
  // Columns with an invalid header are ignored.
  const invalidColumns = new Set();
  let tracks = new Set();
  for (const [i, header] of headers.entries()) {
    ctx.at(1);
    if (header.length > 2) {
      ctx.err(`invalid header "${header.join("\\n")}", expected "<property>" or "<track>\\n<property>"`);
      invalidColumns.add(i);
    } else if (header.length > 1) {
      tracks.add(header[0]);
    } else if (!KNOWN_COLUMNS.has(header[0])) {
      ctx.warn(`unknown column "${header[0]}" is not used`);
    }
  }
  ctx.at();
  console.log("Found cues for", [...tracks].join(", "));

  // 3. Parse each row as a cue.
  let cues = [];
  const cueRows = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    cue = { tracks: {} };
    const values = row.values.map(x => x.chipRuns ? { uri: x.chipRuns[0].chip.richLinkProperties.uri, name: x.formattedValue.trim() } : x.formattedValue);
    for (const [i, value] of values.entries()) {
      if (value == null || invalidColumns.has(i)) {
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

    // +2: skip the header row, and sheet rows are 1-based.
    cue.row = rowIndex + 2;
    if (typeof cue.cue === "string") {
      cue.cue = cue.cue.trim();
    }

    // Rows with the cue id "N/A" are explicitly ignored. Any other row needs a cue id.
    if (typeof cue.cue === "string" && cue.cue.toUpperCase() === "N/A") {
      continue;
    }
    if (!cue.cue) {
      ctx.at(cue.row).err("missing cue id (use N/A to ignore the row)");
      continue;
    }

    ctx.at(cue.row, cue.cue);
    if (cueRows.has(cue.cue)) {
      ctx.err(`duplicate cue id (first used in row ${cueRows.get(cue.cue)})`);
    } else {
      cueRows.set(cue.cue, cue.row);
    }

    cues.push(cue);
  }
  ctx.at();
  
  ctx.report();
  return ctx.hasErrors() ? [] : cues;
}

/**
 * Adds the custom "ZEST" menu to the Google Sheets user interface for running generators.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("ZEST")
    .addItem("Generate MultiPlay file", "generateMultiplay")
    .addItem("Bundle assets", "bundleAssets")
    .addItem("Everything Everywhere All at Once", "updateAll")
    .addToUi();
}

/**
 * Master generator function ("Everything Everywhere All at Once").
 * Parses the cuelist once and triggers MultiPlay production generation,
 * and asset bundling.
 */
function updateAll() {
  const cues = parseCuelist();
  generateMultiplay(cues);
  bundleAssets(cues);
}
