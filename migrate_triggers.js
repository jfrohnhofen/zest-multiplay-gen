/**
 * One-off migration of a cue list sheet from auto-cues (`n/a` rows and `$delay`) to cue triggers: adds the Trigger
 * column to the active sheet, and keeps the timing the auto-cues had before:
 * - rows with a cue id: `go`
 * - `n/a` / `-` / empty id rows with video or sound (the old auto-cues): a new id `<previous id>.<n>` and
 *   `continue +Ns`, where N comes from their `$delay` (counted from the previous cue, as before), or 5 s after an
 *   image, loop or camera (the old default). `$delay` lines are removed from the params.
 * - `n/a` / `-` rows without video or sound, and empty id rows with other content (e.g. lights only): `skip`
 * Smart chips are kept: only the Cue, Trigger and params cells of the changed rows are written.
 *
 * Run it once from the Apps Script editor (select migrateToTriggers, then Run). It refuses to run twice.
 */
function migrateToTriggers() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const values = sheet.getDataRange().getDisplayValues();
  const plan = planTriggerMigration(values);
  if (plan.error) {
    throw new Error(plan.error);
  }

  sheet.insertColumnAfter(plan.cueColumn + 1); // 1-based column of Cue
  const triggerColumn = plan.cueColumn + 2;
  // Columns after the Cue column moved one to the right.
  const column = c => c > plan.cueColumn ? c + 2 : c + 1;
  sheet.getRange(1, triggerColumn).setValue("Trigger");
  sheet.getRange(2, triggerColumn, plan.triggers.length, 1).setValues(plan.triggers.map(t => [t]));
  for (const edit of plan.edits) {
    sheet.getRange(edit.row + 1, column(edit.column)).setValue(edit.value);
  }
  const report = plan.messages.join("\n");
  console.log(report);
  SpreadsheetApp.getUi().alert("Trigger column added", report, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * The migration of a sheet given as rows of display values (the first row is the header). Returns
 * { cueColumn (0-based), triggers (one per row after the header), edits: [{ row, column (0-based), value }],
 * messages }, or { error }.
 */
function planTriggerMigration(values) {
  const headers = values[0].map(h => String(h).toLowerCase().split("\n").map(s => s.trim()));
  if (headers.some(h => h.length === 1 && h[0] === "trigger")) {
    return { error: "This sheet already has a Trigger column." };
  }
  const cueColumn = headers.findIndex(h => h.length === 1 && h[0] === "cue");
  if (cueColumn < 0) {
    return { error: "No Cue column." };
  }
  const columns = (track, prop) => headers.map((h, i) => h[0] === track && h[1] === prop ? i : -1).filter(i => i >= 0);
  const screens = [...new Set(headers.filter(h => h.length > 1 && h[0].match(/screen|projector/)).map(h => h[0]))];
  const videoFile = screens.flatMap(s => columns(s, "file"));
  const videoParams = screens.flatMap(s => columns(s, "params"));
  const soundFile = columns("sound", "file");
  const soundParams = columns("sound", "params");
  const lights = columns("lights", "description");
  const filled = (row, cols) => cols.some(i => String(row[i] ?? "").trim() !== "");
  const ids = new Set(values.slice(1).map(r => String(r[cueColumn]).trim().toLowerCase()));
  const delayOf = text => {
    const m = String(text ?? "").match(/^\s*\$delay\s+(\S+)\s*$/m);
    return m ? Number(m[1]) : null;
  };
  const withoutDelay = text => String(text).split("\n").filter(l => !/^\s*\$delay\b/.test(l)).join("\n");
  const endless = row => videoFile.some(i => /^@camera$|\.(png|jpe?g|gif|bmp|tiff?|heic|psd|webp)$/i.test(String(row[i]).trim()))
    || videoParams.some(i => /^\s*\$loop\s*$/m.test(String(row[i])));

  const triggers = [];
  const edits = [];
  const messages = [];
  let head = null; // { id, row, offset (of the last auto row), count, endless (of the previous row with video) }
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const id = String(row[cueColumn] ?? "").trim();
    const hasVideo = filled(row, videoFile) || filled(row, videoParams);
    const hasSound = filled(row, soundFile) || filled(row, soundParams);

    if (id !== "" && !["n/a", "-"].includes(id.toLowerCase())) {
      triggers.push("go");
      for (const i of [...videoParams, ...soundParams].filter(i => delayOf(row[i]) != null)) {
        messages.push(`Row ${r + 1} (${id}): $delay on a go row, fix by hand: ${headers[i].join(" ")}`);
      }
      head = { id, offset: 0, count: 0, endless: hasVideo ? endless(row) : false };
      continue;
    }
    if (!hasVideo && !hasSound) {
      // Ignored before; now an explicit skip if the row has anything in it.
      triggers.push(id !== "" || filled(row, lights) ? "skip" : "");
      continue;
    }
    if (head == null) {
      triggers.push("skip");
      messages.push(`Row ${r + 1}: video / sound before the first cue, set to skip`);
      continue;
    }

    // An old auto-cue: its own id, started N s after the head (offsets add up along a chain of auto-cues).
    const videoDelays = videoParams.map(i => delayOf(row[i])).filter(d => d != null);
    const soundDelays = soundParams.map(i => delayOf(row[i])).filter(d => d != null);
    let delay;
    if (hasVideo) {
      delay = videoDelays[0];
      if (delay == null) {
        if (!head.endless) {
          messages.push(`Row ${r + 1}: video after a video that ends, it used to start when that ends: set continue +Ns to when that video ends`);
        }
        delay = 5;
      }
    } else {
      delay = soundDelays[0] ?? 0;
    }
    if (hasVideo && hasSound && (soundDelays[0] ?? 0) !== delay) {
      messages.push(`Row ${r + 1}: video and sound used to have different delays (${delay} s, ${soundDelays[0] ?? 0} s), now both start after ${delay} s`);
    }
    head.offset += delay;
    let newId;
    do {
      newId = `${head.id}.${++head.count}`;
    } while (ids.has(newId.toLowerCase()));
    ids.add(newId.toLowerCase());
    const trigger = head.offset > 0 ? `continue +${head.offset}s` : "continue";
    triggers.push(trigger);
    edits.push({ row: r, column: cueColumn, value: newId });
    for (const i of [...videoParams, ...soundParams].filter(i => delayOf(row[i]) != null)) {
      edits.push({ row: r, column: i, value: withoutDelay(row[i]) });
    }
    messages.push(`Row ${r + 1}: ${id || "(no id)"} -> ${newId}, ${trigger}`);
    if (hasVideo) {
      head.endless = endless(row);
    }
  }
  return { cueColumn, triggers, edits, messages };
}
