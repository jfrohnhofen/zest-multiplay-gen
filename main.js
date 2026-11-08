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

/**
 * Parses the active Google Sheet into an array of structured cue objects.
 * 
 * Column headers dictate property names. Headers with newline characters are split into track and property
 * (e.g. `sound\nfile` maps to `cue.tracks.sound.file`).
 * Handles rich link smart chips by extracting their URI and display name.
 *
 * Each cue carries the sheet row it was parsed from (`cue.row`, 1-based, including the header row).
 *
 * Warnings and errors are logged via a "parse" context before returning. Returns null if there were any
 * errors, so that the generators do not run and leave existing output untouched.
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
  // Headers with more than two parts nest generically (e.g. "a\nb\nc" maps to `cue.tracks.a.b.c`).
  const tracks = new Map(); // track -> set of its properties
  for (const [i, header] of headers.entries()) {
    ctx.at({ row: 1 });
    if (header.length > 1) {
      if (!tracks.has(header[0])) tracks.set(header[0], new Set());
      tracks.get(header[0]).add(header.slice(1).join("."));
    }
  }
  ctx.at();
  console.log(`[parse] found tracks: ${[...tracks].map(([track, props]) => `${track} (${[...props].join(", ")})`).join(", ")}`);

  // 3. Parse each row as a cue.
  let cues = [];
  const cueRows = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    let cue = { tracks: {} };
    const values = row.values.map(x => x.chipRuns ? { uri: x.chipRuns[0].chip.richLinkProperties.uri, name: x.formattedValue.trim() } : x.formattedValue);
    for (const [i, value] of values.entries()) {
      if (value == null) {
        continue;
      }
      const header = headers[i];
      if (header.length > 1) {
        // Nests generically: "<track>\n<a>\n<b>" maps to cue.tracks.<track>.<a>.<b>.
        let target = cue.tracks;
        for (const key of header.slice(0, -1)) {
          target = target[key] = target[key] || {};
        }
        target[header.at(-1)] = value;
      } else {
        cue[header[0]] = value;
      }
    }

    // +2: skip the header row, and sheet rows are 1-based.
    cue.row = rowIndex + 2;
    if (typeof cue.cue === "string") {
      cue.cue = cue.cue.trim();
    }

    // Rows with the cue id "N/A" are explicitly ignored. Rows without a cue id are ignored with a warning.
    if (typeof cue.cue === "string" && cue.cue.toUpperCase() === "N/A") {
      continue;
    }
    if (!cue.cue) {
      ctx.at(cue).warn("missing cue id, ignoring row (use n/a to silence this warning)");
      continue;
    }

    ctx.at(cue);
    if (cueRows.has(cue.cue)) {
      ctx.err(`duplicate cue id (first used in row ${cueRows.get(cue.cue)})`);
    } else {
      cueRows.set(cue.cue, cue.row);
    }

    cues.push(cue);
  }
  ctx.at();
  console.log(`[parse] parsed ${cues.length} cue${cues.length === 1 ? "" : "s"}`);

  ctx.report("parse errors, aborting");
  return ctx.hasErrors() ? null : cues;
}

/** Converts a 0-based column index to a sheet column letter (0 -> A, 26 -> AA). */
function columnLetter(i) {
  let letters = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    letters = String.fromCharCode(65 + (i - 1) % 26) + letters;
  }
  return letters;
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
