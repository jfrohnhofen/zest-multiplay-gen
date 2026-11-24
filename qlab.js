/**
 * Generates two AppleScripts that build the QLab video cue list, `<SHOW_NAME>.applescript` and
 * `<SHOW_NAME> update.applescript`.
 *
 * Writing a QLab workspace file directly is not feasible (it is an undocumented, nested binary plist with macOS
 * file bookmarks inside). Instead, the generated scripts are run on the QLab Mac with the show workspace open. The
 * first deletes the previously generated cue list (named QLAB_CUE_LIST_NAME) and recreates it from scratch. The
 * update script finds the cues it made before by their keys (see below) and only changes what the sheet controls.
 *
 * Every sheet row with video content becomes a group cue numbered like the sheet cue (e.g. `4`), which is what
 * MultiPlay triggers via OSC `/cue/4/start` (after the row's pre-wait, see schedule.js). The group fires all its
 * children at once:
 *   4-1  video / image / camera cue (starts at opacity 0 when it fades in)
 *   4-2  fade cue: opacity 0 -> 1 over the fade duration
 *   4-3  fade cue: fades out and stops whatever was showing on that screen before
 *
 * Each screen (stage) has its own pair of columns, configured in QLAB_SCREENS:
 *   `<screen>\nfile`    file name or Drive smart chip, or `@camera` for a live camera cue
 *   `<screen>\nparams`  one parameter / action per line (see parseVideoParams)
 *
 * Every generated cue has a key in the first line of its Notes, `zest:<key>`, that names what it does for the sheet
 * independently of its cue number (which depends on the order of the cues):
 *   Q4                                    the group of the row with id Q4
 *   Q4/Window/media                       the media that row Q4 starts on the Window screen
 *   Q4/Window/fade-in                     its fade-in
 *   Q4/Window/fade-out:Q2/Window          a fade-out (or stop, pause, resume) by row Q4 of the media of row Q2
 */
function generateQlab(cues) {
  cues = cues ?? parseCuelist();
  if (cues == null) return; // parse errors already reported
  if (cues.length === 0) {
    // Nothing to generate (empty sheet). Bail out so existing output is not overwritten.
    console.warn("[qlab] no cues, nothing to do");
    return;
  }

  const ctx = new Context("qlab");

  const ops = [];                // flat list of cue-creation operations, consumed by the AppleScript runtime
  const state = {
    labels: new Map(),           // #label -> media index
    media: [],                   // media index -> { name, screen, key }
    onScreen: {},                // screen track -> array of media indices currently visible
    paused: new Set(),           // media indices that are paused (and still visible)
  };
  for (const screen in QLAB_SCREENS) {
    state.onScreen[screen] = [];
  }

  for (const row of cues) {
    if (!hasVideo(row)) {
      continue;
    }
    // The cue id is validated when parsing (Q<number>), so it is safe in the OSC address /cue/<number>/start.
    const number = row.cue;
    // The parsing / validation helpers below throw on the first problem in a row (see assert): report it and skip
    // the row, so that one run reports the problems of all rows.
    let children;
    try {
      children = buildVideoCue(row, "video", state); // message prefix; the row and cue id are added by the context
    } catch (e) {
      ctx.at(row).err(e.message);
      continue;
    }
    // The files the row shows on each screen, which tell a renamed row (new id) in the update script.
    const files = children.filter(c => c.op === "video" || c.op === "camera")
      .map(c => `${c.key.split("/")[1]}:${c.op === "camera" ? "@camera" : c.file}`).sort().join(",");
    ops.push({ op: "group", key: row.cue, parent: "", number, name: row.tracks.video?.description || row.description || "", delay: 0, continueMode: "", files });
    // The children are chained with auto-continue, so they all start together with the group.
    children.forEach((child, i) => ops.push({
      ...child,
      parent: row.cue,
      number: `${number}-${i + 1}`,
      continueMode: i < children.length - 1 ? "continue" : "",
    }));
  }

  ctx.at();
  ctx.report("output not updated");
  if (ctx.hasErrors()) {
    // Do not overwrite the existing scripts with incomplete / broken ones.
    return ops;
  }
  getOrCreateFile(`${SHOW_NAME}.applescript`).setContent(qlabScript(ops, true));
  getOrCreateFile(`${SHOW_NAME} update.applescript`).setContent(qlabScript(ops, false));
  return ops;
}

/**
 * The AppleScript for the ops: `rebuild` deletes the cue list and builds it again, otherwise the script updates the
 * existing cue list in place (see QLAB_SCRIPT_TEMPLATE).
 *
 * Both carry out steps planned by qlabPlan. The rebuild script has them built in (planned for an empty cue list). The
 * update script has the preview page built in instead (see qlabPage), which plans the steps from the cue list as it is
 * when the script runs, and hands them back to the script once they are approved.
 */
function qlabScript(ops, rebuild) {
  const sheet = qlabSheetCues(ops);
  const fill = {
    SHOW: asString(SHOW_NAME),
    PURPOSE: rebuild
      ? `It deletes the cue list ${asString(QLAB_CUE_LIST_NAME)} and rebuilds it from the sheet, so it is safe to re-run.`
      : `It updates the cue list ${asString(QLAB_CUE_LIST_NAME)} to match the sheet. It sets the values the sheet changed since the last run, and keeps the ones changed in QLab and everything the sheet doesn't control (e.g. geometry, effects, cues added by hand). It shows the changes in Safari first, and makes them once Apply is clicked there.`,
    CUE_LIST: asString(QLAB_CUE_LIST_NAME),
    MEDIA_FOLDER: asString(QLAB_MEDIA_FOLDER),
    REBUILD: String(rebuild),
    STEPS: asTextLines("stepsJSON", rebuild ? JSON.stringify(qlabPlan(sheet, { listID: "", mediaPath: "", files: null, cues: [] }, {}).steps) : ""),
    OSC_PERL: asString(QLAB_OSC_PERL),
    PAGE: asTextLines("pageJSON", rebuild ? "" : JSON.stringify([qlabPage(sheet)])),
  };
  // In one pass, so that a placeholder inside a filled in text (e.g. a cue name) stays as it is.
  return QLAB_SCRIPT_TEMPLATE.replace(/%%([A-Z_]+)%%/g, (placeholder, name) => fill[name] ?? placeholder);
}

/**
 * The cues of the sheet, as qlabPlan takes them: the op's kind, QLab cue type, key, parent key ("" for the cue list),
 * cue number, target key ("" if none), the files of a row (see generateQlab) and the values the sheet controls.
 */
function qlabSheetCues(ops) {
  return ops.map(op => ({
    key: op.key,
    kind: op.op,
    type: QLAB_CUE_TYPES[op.op],
    parent: op.parent ?? "",
    number: op.number,
    target: op.target ?? "",
    files: String(op.files ?? "").replace(/[|\r\n]+/g, " "),
    values: sheetValues(op),
  }));
}

/**
 * The preview page of the update script (see QLAB_PAGE), with the cues of the sheet and the planning code built in.
 * The script fills in the cue list as it is when it runs.
 */
function qlabPage(sheet) {
  const code = [qlabPlan, qlabSummaryLines, qlabDecide, qlabRenamedKey, qlabLongestRisingRun, qlabShownValue, qlabPreviewHtml, qlabEscape]
    .map(String).join("\n\n");
  assert(!/<\/script/i.test(code), "the planning code can't contain </script>");
  const fill = {
    SHOW: qlabEscape(SHOW_NAME),
    SHEET: JSON.stringify(sheet).replace(/</g, "\\u003c"), // so that no text in it can end the <script>
    CODE: code,
  };
  return QLAB_PAGE.replace(/%%(SHOW|SHEET|CODE)%%/g, (placeholder, name) => fill[name]);
}

/**
 * AppleScript lines that set the variable `name` to the text, in pieces (AppleScript chokes on very long lines).
 */
function asTextLines(name, text) {
  const lines = [`set ${name} to ""`];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 2000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) {
      end--; // don't split a character in two
    }
    lines.push(`set ${name} to ${name} & ${asString(text.slice(i, end))}`);
    i = end;
  }
  return lines.join("\n");
}

/**
 * Builds the children of one row's group, and updates what is on each screen.
 */
function buildVideoCue(row, where, { labels, media, onScreen, paused }) {
  const children = [];
  // Adds a child with its key (see generateQlab). A row can't do the same thing twice, so keys are unique.
  const keys = new Set();
  const mediaCue = t => `${media[t].key}/media`; // key of the cue that plays media t
  const add = (screenLabel, role, child) => {
    const key = `${row.cue}/${screenLabel}/${role}`;
    assert(!keys.has(key), `${where} / ${screenLabel}: ${role.split(":")[0]} of the same media twice`);
    keys.add(key);
    children.push({ ...child, key });
  };

  for (const screen of Object.keys(QLAB_SCREENS).filter(s => hasVideo(row, s))) {
    const { stage, label: screenLabel } = QLAB_SCREENS[screen];
    const file = row.tracks[screen].file;
    const fileName = file == null ? null : (file.name ?? file).trim();
    const p = parseVideoParams(row.tracks[screen].params, `${where} / ${screenLabel}`);

    assert(fileName || (p.label == null && !p.hasMediaParams), `${where} / ${screenLabel}: params for a file, but no file`);

    // 1. Control actions on media that is already running.
    for (const action of p.actions) {
      const isPause = action.type === "!pause";
      const isResume = action.type === "!resume";
      let targets;
      if (action.target != null) {
        assert(labels.has(action.target), `${where} / ${screenLabel}: unknown label #${action.target}`);
        targets = [labels.get(action.target)];
        assert(!isPause || !paused.has(targets[0]), `${where} / ${screenLabel}: #${action.target} is already paused`);
        assert(!isResume || paused.has(targets[0]), `${where} / ${screenLabel}: #${action.target} is not paused`);
      } else {
        // Without a label: everything on this screen (that is playing for !pause, paused for !resume).
        targets = onScreen[screen].filter(t => isPause ? !paused.has(t) : !isResume || paused.has(t));
      }
      // Fading out / stopping an empty screen is fine (e.g. "make sure all screens are black"); pausing nothing is a mistake.
      assert(targets.length > 0 || action.type === "!fade-out" || action.type === "!stop", `${where} / ${screenLabel}: ${action.type} but nothing to ${action.type.slice(1)} on screen`);
      for (const t of targets) {
        if (isPause) {
          add(screenLabel, `pause:${media[t].key}`, { op: "pause", name: `${screenLabel}: pause ${media[t].name}`, target: mediaCue(t) });
          paused.add(t);
        } else if (isResume) {
          // A start cue resumes a paused cue in QLab.
          add(screenLabel, `resume:${media[t].key}`, { op: "resume", name: `${screenLabel}: resume ${media[t].name}`, target: mediaCue(t) });
          paused.delete(t);
        } else {
          add(screenLabel, `${action.type.slice(1)}:${media[t].key}`, action.type === "!stop"
            ? { op: "stop", name: `${screenLabel}: stop ${media[t].name}`, target: mediaCue(t) }
            : { op: "fade", name: `${screenLabel}: fade out ${media[t].name}`, target: mediaCue(t), duration: action.duration, opacity: 0, stop: true });
          removeFromScreens(onScreen, t);
          paused.delete(t);
        }
      }
    }

    // 2. New media, crossfading out whatever it replaces (unless $keep).
    if (fileName) {
      const isCamera = fileName.toLowerCase() === "@camera";
      const idx = media.length;
      media.push({ name: isCamera ? "live camera" : fileName, screen, key: `${row.cue}/${screenLabel}` });
      if (p.label != null) {
        assert(!labels.has(p.label), `${where}: duplicate label #${p.label}`);
        labels.set(p.label, idx);
      }

      const fade = p.fade ?? QLAB_DEFAULT_FADE;
      const replaced = p.keep ? [] : [...onScreen[screen]];
      add(screenLabel, "media", {
        op: isCamera ? "camera" : "video",
        name: `${screenLabel}: ${media[idx].name}`,
        file: isCamera ? "" : fileName,
        stage,
        opacity: fade > 0 ? 0 : 1,
        loop: p.loop,
        layer: p.layer,
        rotation: p.rotate,
        scale: p.scale,
      });
      if (fade > 0) {
        add(screenLabel, "fade-in", { op: "fade", name: `${screenLabel}: fade in ${media[idx].name}`, target: mediaCue(idx), duration: fade, opacity: 1, stop: false });
      }
      for (const t of replaced) {
        add(screenLabel, `fade-out:${media[t].key}`, { op: "fade", name: `${screenLabel}: fade out ${media[t].name}`, target: mediaCue(t), duration: fade, opacity: 0, stop: true });
        removeFromScreens(onScreen, t);
        paused.delete(t);
      }
      onScreen[screen].push(idx);
    }
  }
  return children;
}

/** Removes a media index from whichever screen it is currently on. */
function removeFromScreens(onScreen, idx) {
  for (const screen in onScreen) {
    onScreen[screen] = onScreen[screen].filter(x => x !== idx);
  }
}

/**
 * Parses line-delimited video parameters for one screen of one cue. Same style as the sound params.
 *
 * Labels name the media in this cell so later cues can target it: `#<label>`.
 *
 * Parameters affect the media in this cell (they require a file):
 * - `$fade-dur <sec>`: fade-in time of the new media, and fade-out time of the media it replaces
 *   (default QLAB_DEFAULT_FADE; `0` = hard cut).
 * - `$loop`: loop the video forever.
 * - `$keep`: don't fade out what is already on this screen; the new media is layered on top.
 * - `$layer <n>`: QLab video layer (higher is on top).
 * - `$rotate <degrees>`: rotate the media around the Z axis, in whole degrees (e.g. 90 or -90).
 * - `$scale <factor>`: scale the media horizontally and vertically by this factor (e.g. 1.8).
 * - `$scale fit|fill|stretch`: Fill Stage, fitting the media in the stage, filling it (cropping the media) or stretching
 *   it. Without `$scale` a video fits in the stage (`fit`), unless it is rotated. Can't be used with `$rotate`, which needs
 *   Geometry mode Custom.
 *
 * Control actions target media that is already running, without needing a file:
 * - `!fade-out [#label] [<sec>]`: fade out and stop the labeled media, or everything on this screen (default 1s).
 * - `!stop [#label]`: stop immediately (blackout).
 * - `!pause [#label]`: pause the labeled video, or everything playing on this screen (the frame stays visible).
 * - `!resume [#label]`: resume the labeled video, or everything paused on this screen.
 */
function parseVideoParams(input, where) {
  const result = { label: null, fade: null, loop: false, keep: false, layer: null, rotate: null, scale: null, actions: [], hasMediaParams: false };
  const num = (v, name) => {
    assert(v != null && !isNaN(Number(v)), `${where}: ${name} needs a number of seconds`);
    return Number(v);
  };

  for (const rawLine of input?.split("\n") || []) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const [name, ...args] = line.split(/\s+/);

    if (name.startsWith("#")) {
      assert(args.length === 0 && result.label == null, `${where}: invalid label line "${line}"`);
      result.label = name.slice(1);
      continue;
    }

    switch (name) {
      case "$fade-dur":
        assert(args.length === 1, `${where}: usage $fade-dur <sec>`);
        result.fade = num(args[0], name);
        result.hasMediaParams = true;
        break;
      case "$loop":
        assert(args.length === 0, `${where}: usage $loop`);
        result.loop = true;
        result.hasMediaParams = true;
        break;
      case "$keep":
        assert(args.length === 0, `${where}: usage $keep`);
        result.keep = true;
        result.hasMediaParams = true;
        break;
      case "$layer":
        assert(args.length === 1, `${where}: usage $layer <n>`);
        result.layer = num(args[0], name);
        result.hasMediaParams = true;
        break;
      case "$rotate":
        assert(args.length === 1 && !isNaN(Number(args[0])), `${where}: usage $rotate <degrees>`);
        result.rotate = Number(args[0]);
        result.hasMediaParams = true;
        break;
      case "$scale": {
        const style = String(args[0] ?? "").toLowerCase();
        // A factor of at least one thousandth, the precision the script compares it in (see sheetValues).
        assert(args.length === 1 && (QLAB_FILL_STYLES.includes(style) || Number(args[0]) >= 0.001),
          `${where}: usage $scale <factor> (a number above 0, e.g. 1.8) or $scale fit|fill|stretch`);
        result.scale = QLAB_FILL_STYLES.includes(style) ? style : Number(args[0]);
        result.hasMediaParams = true;
        break;
      }
      case "!fade-out":
      case "!stop":
      case "!pause":
      case "!resume": {
        const target = args[0]?.startsWith("#") ? args.shift().slice(1) : null;
        let duration = 0;
        if (name === "!fade-out") {
          assert(args.length <= 1, `${where}: usage !fade-out [#label] [<sec>]`);
          duration = args.length ? num(args[0], name) : QLAB_DEFAULT_FADE;
        } else {
          assert(args.length === 0, `${where}: usage ${name} [#label]`);
        }
        result.actions.push({ type: name, target, duration });
        break;
      }
      default:
        assert(false, `${where}: invalid video param "${name}"`);
    }
  }
  assert(!(typeof result.scale === "string" && result.rotate != null),
    `${where}: $scale ${result.scale} can't be used with $rotate (rotating needs Geometry mode Custom: use $scale <factor>)`);
  return result;
}

// The Fill Stage styles of a video cue, as QLab's AppleScript names them (`fill style`).
const QLAB_FILL_STYLES = ["fit", "fill", "stretch"];

/** Quotes a JS string as an AppleScript string literal. */
function asString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
}

/**
 * The values of a cue that the sheet controls, as [name, value] pairs of text. The script sets them (see setValue in
 * QLAB_SCRIPT_TEMPLATE) and remembers them in the second line of the cue's Notes, as `name=value|name=value|...`.
 * Times and opacities are whole thousandths, so the text doesn't depend on the Mac's decimal separator.
 */
function sheetValues(op) {
  const text = s => String(s ?? "").replace(/[|\r\n]+/g, " ").trim(); // "|" separates the values in the Notes
  const thousandths = x => String(Math.round(x * 1000));
  const values = [["name", text(op.name)], ["continue", op.continueMode || "none"]];
  if (op.op === "group") {
    values.push(["preWait", thousandths(op.delay ?? 0)]);
  }
  if (op.op === "video") {
    values.push(["file", text(op.file)]);
  }
  if (op.op === "video" || op.op === "camera") {
    values.push(["stage", text(op.stage)], ["opacity", thousandths(op.opacity)]);
    if (op.op === "video") {
      values.push(["loop", String(!!op.loop)]);
    }
    if (op.layer != null) {
      values.push(["layer", String(Math.round(op.layer))]);
    }
    if (op.rotation != null) {
      // In whole degrees from -179 to 180, as the script reads it back (see QLAB_OSC_PERL).
      const degrees = ((Math.round(op.rotation) % 360) + 360) % 360;
      values.push(["rotation", String(degrees > 180 ? degrees - 360 : degrees)]);
    }
    if (op.scale != null) {
      values.push(["scale", typeof op.scale === "string" ? op.scale : thousandths(op.scale)]);
    } else if (op.op === "video" && op.rotation == null) {
      // Without $scale a video fits in the stage. A rotated one stays in Geometry mode Custom (see qlabPlan).
      values.push(["scale", "fit"]);
    }
  }
  if (op.op === "fade") {
    values.push(["duration", thousandths(op.duration)], ["opacity", thousandths(op.opacity)], ["stopWhenDone", String(!!op.stop)]);
  }
  return values;
}

// The QLab cue type of each op.
const QLAB_CUE_TYPES = { group: "Group", video: "Video", camera: "Camera", fade: "Fade", stop: "Stop", pause: "Pause", resume: "Start" };

/**
 * Works out how to bring the QLab cue list in line with the sheet, without changing anything yet.
 *
 * - sheet: the cues of the sheet (see qlabSheetCues).
 * - qlab: the cue list as it is (see scanCues in QLAB_SCRIPT_TEMPLATE): { listID, mediaPath, files (the names in the
 *   media folder, or null if unknown), cues: [{ id (uniqueID), type, parent (uniqueID), number, name, notes, target
 *   (uniqueID or ""), values ([name, value] pairs, of a cue with a key) }] }. For a rebuild, it has no cues.
 * - answers: { notRenamed: the renames answered "no", takeSheet: the conflicts answered "take the sheet's value" }
 *   (by id).
 *
 * Every cue the sheet had before has the key of what it does for the sheet in the first line of its Notes, and the
 * sheet's values of last time in the second line (see sheetValues). A cue of the sheet reuses the cue with its key,
 * and only its values the sheet changed since last time are set (see qlabDecide). Cues the sheet doesn't have anymore
 * are marked as removed. Cues without a key (added by hand) aren't changed.
 *
 * Returns:
 * - renames: the rows that look renamed, { id, from, to, accepted }.
 * - conflicts: the values both changed, { id, number, name, qlab, sheet, takeSheet }.
 * - sections: the preview (see qlabPreviewHtml), a section for each row with changes, with a line for each change
 *   and a shorter summary of them (see qlabSummaryLines).
 * - unchanged: the number of rows without changes; changes: the number of changes; counts.
 * - steps: what the script does to carry it out (see runSteps in QLAB_SCRIPT_TEMPLATE), lists of text:
 *     clearNumber <cue>                        clear its number (so it isn't taken when set again)
 *     create <cue> <type> <holder>             make a cue at the end of a group or the cue list
 *     restore <cue> <name>                     unmark a removed cue: name, armed, no color
 *     number <cue> <number>
 *     target <cue> <target cue>
 *     set <cue> <value name> <value> <number>  set a value (see setValue), the number is for problems
 *     notes <cue> <key> <values> <extra>       write the Notes: the key, the values to remember ([name, value, value
 *                                              if it couldn't be set (null: none)]) and the lines added in QLab
 *     place <holder> <cues>                    put the cues in this order (see placeCues)
 *     remove <cue> <new name or ""> <yes/no>   mark a cue as removed, and move it to the end of the cue list (yes)
 *   A <cue> is a uniqueID, "new:<key>" for a cue created by an earlier step, or "list" for the cue list.
 *
 * This also runs in the preview page, so it can only use the functions qlabPage builds in.
 */
function qlabPlan(sheet, qlab, answers) {
  const lower = s => String(s).toLowerCase();
  const notRenamed = answers.notRenamed || [];
  const takeSheet = answers.takeSheet || [];

  // The cues in QLab, with their key and the sheet's values of last time from the Notes.
  const cues = qlab.cues.map(c => {
    const notes = String(c.notes ?? "").split(/\r\n|\r|\n/);
    const remembered = new Map();
    for (const pair of (notes[1] ?? "").split("|")) {
      const eq = pair.indexOf("=");
      if (eq > 0 && !remembered.has(pair.slice(0, eq))) {
        remembered.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    return {
      ...c,
      number: String(c.number ?? ""),
      name: String(c.name ?? ""),
      key: notes[0].startsWith("zest:") ? notes[0].slice(5) : "",
      values: new Map(c.values ?? []),
      remembered,
      extra: notes.length > 2 ? "\n" + notes.slice(2).join("\n") : "", // lines added in QLab
    };
  });

  // Keys are matched ignoring case, like cue ids (q12 and Q12 are the same row).
  const sheetIndex = new Map(sheet.map((o, d) => [lower(o.key), d]));
  const indexOfKey = k => sheetIndex.get(lower(k)) ?? -1;
  const originalKeys = new Set(cues.filter(c => c.key).map(c => lower(c.key)));

  // A renamed row (new cue id) looks like a removed row plus a new one. A row group the sheet doesn't have anymore and
  // a new one that show the same files on the same screens are a rename, unless another removed or new row shows the
  // same files too, or it is answered otherwise.
  const renames = [];
  for (const o of sheet) {
    if (!o.files || originalKeys.has(lower(o.key))) {
      continue;
    }
    const candidates = cues.filter(c => c.key && !c.key.includes("/") && indexOfKey(c.key) < 0 && c.remembered.get("files") === o.files);
    const twins = sheet.filter(o2 => o2.files === o.files && !originalKeys.has(lower(o2.key)));
    if (candidates.length === 1 && twins.length === 1) {
      const id = `${candidates[0].key}>${o.key}`;
      renames.push({ id, from: candidates[0].key, to: o.key, accepted: !notRenamed.includes(id) });
    }
  }
  const oldKeys = cues.map(c => renames.filter(r => r.accepted).reduce((k, r) => qlabRenamedKey(k, r.from, r.to), c.key));

  // Which existing cue each cue of the sheet reuses (-1: none). A cue is reused only if it still has the same type (e.g.
  // a video that becomes a camera is replaced). The others with a key are removed, or copies made in QLab.
  const reused = sheet.map(() => -1);
  const removed = [];
  const duplicates = [];
  oldKeys.forEach((k, i) => {
    if (!k) {
      return;
    }
    const d = indexOfKey(k);
    if (d < 0 || cues[i].type !== sheet[d].type) {
      removed.push(i);
    } else if (reused[d] >= 0) {
      duplicates.push(i);
    } else {
      reused[d] = i;
    }
  });
  const refOf = d => reused[d] >= 0 ? cues[reused[d]].id : `new:${sheet[d].key}`;
  const holderOf = parentKey => parentKey === "" ? "list" : refOf(indexOfKey(parentKey));

  // A cue whose $scale was removed from the sheet goes back to Fill Stage, as a change of the sheet (a video already
  // has "fit" then, see sheetValues). A rotated cue can't be in Fill Stage (rotating needs Geometry mode Custom), so it
  // goes back to scale 1.
  sheet = sheet.map((o, d) => {
    const hasValue = name => o.values.some(([n]) => n === name);
    if (reused[d] < 0 || hasValue("scale") || !cues[reused[d]].remembered.has("scale")) {
      return o;
    }
    return { ...o, values: [...o.values, ["scale", hasValue("rotation") ? "1000" : "fit"]] };
  });

  // What to do with each value: set it, or keep the QLab value. A value both changed is a question.
  const conflicts = [];
  const verdicts = sheet.map((o, d) => o.values.map(([name, value]) => {
    const c = cues[reused[d]];
    if (!c) {
      return { verdict: "set", qlab: null, last: null };
    }
    const qlabValue = c.values.get(name) ?? "";
    const last = c.remembered.get(name) ?? null;
    // A video whose file is gone (e.g. after the media folder was replaced by a new export) has no file in QLab. That
    // isn't a change made in QLab, so the sheet's file is set (again), without a question.
    if (name === "file" && qlabValue === "") {
      return { verdict: "set", qlab: qlabValue, last, missing: true };
    }
    let verdict = qlabDecide(qlabValue, value, last);
    if (verdict === "conflict") {
      const id = `${o.key}#${name}`;
      conflicts.push({ id, number: o.number, name, qlab: qlabValue, sheet: value, takeSheet: takeSheet.includes(id) });
      verdict = takeSheet.includes(id) ? "set" : "keep";
    }
    return { verdict, qlab: qlabValue, last };
  }));

  // The moves. In each group (and the cue list), the existing cues of the sheet that form the longest run in sheet
  // order stay; the others move, and so do the ones that come from another group.
  const moved = new Set();
  const byParent = new Map(); // parent key -> the uniqueIDs of the existing cues that go in it, in sheet order
  sheet.forEach((o, d) => {
    if (reused[d] >= 0) {
      byParent.set(o.parent, [...(byParent.get(o.parent) ?? []), cues[reused[d]].id]);
    }
  });
  for (const [parentKey, wanted] of byParent) {
    const g = parentKey === "" ? -1 : reused[indexOfKey(parentKey)];
    const holder = parentKey === "" ? qlab.listID : g >= 0 ? cues[g].id : "";
    const positions = cues.filter(c => c.parent === holder && wanted.includes(c.id)).map(c => wanted.indexOf(c.id));
    const staying = qlabLongestRisingRun(positions);
    wanted.forEach((id, w) => staying.includes(w) || moved.add(id));
  }

  // The steps. Cue numbers that change are cleared first, so that none is still taken by another cue when it is set.
  const steps = [];
  const numberChanges = d => reused[d] < 0 || cues[reused[d]].number !== sheet[d].number;
  for (const i of removed) {
    if (cues[i].number !== "") {
      steps.push(["clearNumber", cues[i].id]);
    }
  }
  sheet.forEach((o, d) => {
    if (reused[d] >= 0 && numberChanges(d) && cues[reused[d]].number !== "") {
      steps.push(["clearNumber", cues[reused[d]].id]);
    }
  });

  const files = qlab.files == null ? null : new Set(qlab.files.map(f => String(f).normalize("NFC")));
  const missingFile = name => files != null && !files.has(String(name).normalize("NFC"));
  const sections = new Map(); // lower-case row id -> { row, lines }
  const lineIn = (key, sign, text, about = {}) => {
    const row = key.split("/")[0];
    if (!sections.has(lower(row))) {
      sections.set(lower(row), { row, lines: [] });
    }
    sections.get(lower(row)).lines.push({ sign, text, key, ...about });
  };
  const counts = { created: 0, updated: 0, moved: moved.size, renamed: renames.filter(r => r.accepted).length, removed: 0, kept: 0 };

  sheet.forEach((o, d) => {
    const c = cues[reused[d]];
    const ref = refOf(d);
    if (!c) {
      steps.push(["create", ref, o.type, holderOf(o.parent)]);
      lineIn(o.key, "+", `${o.number} ${o.values[0][1]} (new ${o.kind})`, { cue: { key: o.key, type: o.type, number: o.number, name: o.values[0][1] } });
      counts.created++;
    } else {
      if (c.name.startsWith("REMOVED ")) {
        steps.push(["restore", ref, c.name.slice(8)]);
        lineIn(o.key, "^", `${o.number} comes back (it was marked REMOVED)`);
      }
      if (numberChanges(d)) {
        lineIn(o.key, "#", `${c.number || "(no number)"} → ${o.number}`, { renumber: [c.number, o.number] });
      }
      if (moved.has(c.id)) {
        lineIn(o.key, ">", `${o.number} moves`);
      }
    }
    if (numberChanges(d)) {
      steps.push(["number", ref, o.number]);
    }
    if (o.target) {
      const target = refOf(indexOfKey(o.target));
      if (!c || c.target !== target) {
        steps.push(["target", ref, target]);
      }
    }

    // The Notes remember the sheet's values (also where the QLab value is kept, so it stays until the sheet changes
    // again), except where they can't be set, so that those are tried again next time.
    const remember = [];
    let anySet = false;
    let anyKept = false;
    o.values.forEach(([name, value], vi) => {
      const { verdict, qlab: qlabValue, last, missing } = verdicts[d][vi];
      if (verdict === "set") {
        steps.push(["set", ref, name, value, o.number]);
        if (c && missing) {
          // The old file is named after the one the sheet set last time (see sheetValues).
          lineIn(o.key, "~", last == null || last === value
            ? `${o.number} ${name}: ${qlabShownValue(name, value)} is missing in QLab, set again`
            : `${o.number} ${name}: ${qlabShownValue(name, last)} (missing in QLab) → ${qlabShownValue(name, value)}`, { change: [name, last ?? "", value] });
          anySet = true;
        } else if (c) {
          lineIn(o.key, "~", `${o.number} ${name}: ${qlabShownValue(name, qlabValue)} → ${qlabShownValue(name, value)}`, { change: [name, qlabValue, value] });
          anySet = true;
        }
        if (name === "file" && missingFile(value)) {
          lineIn(o.key, "!", `${o.number} missing file ${qlab.mediaPath}/${value}`);
        }
      } else if (verdict === "keep") {
        anyKept = true;
        if (conflicts.some(q => q.id === `${o.key}#${name}`)) {
          lineIn(o.key, "=", `${o.number} ${name}: keeps ${qlabShownValue(name, qlabValue)} from QLab (the sheet has ${qlabShownValue(name, value)})`);
        }
      }
      remember.push([name, value, verdict === "set" ? last : value]);
    });
    if (o.files) {
      remember.push(["files", o.files, o.files]);
    }
    steps.push(["notes", ref, o.key, remember, c ? c.extra : ""]);
    counts.updated += anySet ? 1 : 0;
    counts.kept += anyKept ? 1 : 0;
  });

  // Put the cues of each group, and of the cue list, in sheet order.
  const holders = [];
  for (const o of sheet) {
    if (!holders.includes(o.parent)) {
      holders.push(o.parent);
    }
  }
  for (const parentKey of holders) {
    steps.push(["place", holderOf(parentKey), sheet.map((o, d) => o.parent === parentKey ? refOf(d) : null).filter(r => r != null)]);
  }

  // The cues the sheet doesn't have anymore aren't deleted, but switched off and moved out of the way, to be deleted
  // by hand: disarmed, without a number (cleared above), red, named "REMOVED ...", and at the end of the cue list (a
  // removed group with what is inside it).
  const removedIDs = removed.map(i => cues[i].id);
  for (const i of removed) {
    const c = cues[i];
    const already = c.name.startsWith("REMOVED ");
    steps.push(["remove", c.id, already ? "" : `REMOVED ${c.name}`, removedIDs.includes(c.parent) ? "no" : "yes"]);
    if (!already) {
      lineIn(oldKeys[i], "-", `${c.number || "(no number)"} ${c.name}: marked REMOVED`, { cue: { key: oldKeys[i], type: c.type, number: c.number, name: c.name } });
      counts.removed++;
    }
  }
  for (const i of duplicates) {
    lineIn(oldKeys[i], "!", `${cues[i].number || "(no number)"} has the same key as another cue (copied in QLab?), so it is treated as added by hand`);
  }

  // The headers of the sections, and their lines in short. A new file also changes the names of the cues that show it.
  const fileChanges = [...sections.values()].flatMap(s => s.lines).filter(l => l.change?.[0] === "file" && l.change[1]).map(l => l.change.slice(1));
  const groups = new Set(sheet.filter(o => o.parent === "").map(o => lower(o.key)));
  for (const s of sections.values()) {
    const d = indexOfKey(s.row);
    const rename = renames.find(r => r.accepted && lower(r.to) === lower(s.row));
    s.status = rename ? "renamed" : d < 0 ? "removed" : reused[d] < 0 ? "new" : "changed";
    s.header = rename ? `${rename.from} → ${s.row}` : s.row;
    s.title = d >= 0 ? sheet[d].values[0][1] : (cues.find(c => lower(c.key) === lower(s.row))?.name ?? "").replace(/^REMOVED /, "");
    s.summary = qlabSummaryLines(s, fileChanges);
  }
  const changes = [...sections.values()].reduce((n, s) => n + s.lines.filter(l => l.sign !== "=" && l.sign !== "!").length, 0);
  const unchanged = [...groups].filter(row => !sections.has(row)).length;

  // The sections in sheet order. A row removed from the sheet goes where it was in the cue list: after the row of the
  // closest cue before it that is still in the sheet.
  const rowOfKey = k => lower(k.split("/")[0]);
  const positionOf = s => {
    const d = indexOfKey(s.row);
    if (d >= 0) {
      return d;
    }
    const first = oldKeys.findIndex(k => k && rowOfKey(k) === lower(s.row));
    for (let i = first - 1; i >= 0; i--) {
      if (oldKeys[i] && indexOfKey(rowOfKey(oldKeys[i])) >= 0) {
        return indexOfKey(rowOfKey(oldKeys[i])) + 0.5;
      }
    }
    return -0.5;
  };
  const ordered = [...sections.values()].map(s => [positionOf(s), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  return { renames, conflicts, sections: ordered, unchanged, changes, counts, steps };
}

/**
 * The lines of a section of the preview (see qlabPlan) in short: a new row or a row removed from the sheet is one line,
 * and so is a row whose number changed together with the numbers of the cues in it (e.g. after a rename). Cue names
 * that only change because they name a new file (fileChanges: [old file, new file] pairs) are counted in one line. A
 * cue marked as removed and a new one of the same type with the same number or name (e.g. a fade-out of other media)
 * are one line too. Problems are always shown.
 */
function qlabSummaryLines(section, fileChanges) {
  const lines = section.lines;
  const problems = lines.filter(l => l.sign === "!");
  const count = sign => lines.filter(l => l.sign === sign).length;
  if (section.status === "new" && count("+") + problems.length === lines.length) {
    return [{ sign: "+", text: `new row, ${count("+")} cues` }, ...problems];
  }
  if (section.status === "removed" && count("-") + problems.length === lines.length) {
    return [{ sign: "-", text: `${count("-")} cues marked REMOVED` }, ...problems];
  }

  const row = lines.find(l => l.renumber && !l.key.includes("/"));
  const [from, to] = row ? row.renumber : [];
  const followsRow = l => row && l !== row && l.renumber && l.renumber[0].startsWith(from) && l.renumber[1] === to + l.renumber[0].slice(from.length);
  const followsFile = l => l.change?.[0] === "name" && fileChanges.some(([a, b]) => l.change[1].includes(a) && l.change[1].split(a).join(b) === l.change[2]);
  const renumbered = lines.filter(followsRow).length;
  const renamed = lines.filter(followsFile).length;

  // The new cues that replace a removed one.
  const replacing = new Map(); // "+" line -> its "-" line
  for (const added of lines.filter(l => l.sign === "+" && l.cue)) {
    const gone = lines.find(l => l.sign === "-" && l.cue && l.cue.type === added.cue.type && ![...replacing.values()].includes(l)
      && (l.cue.number === added.cue.number || l.cue.name === added.cue.name));
    if (gone) {
      replacing.set(added, gone);
    }
  }
  const targetOf = key => key.includes(":") ? key.slice(key.indexOf(":") + 1).replace("/", " ") : "";
  const replaced = (added, gone) => {
    const { cue: a } = added, { cue: g } = gone;
    const change = g.name !== a.name ? `${g.name} → ${a.name}` : `${a.name}: target ${targetOf(g.key)} → ${targetOf(a.key)}`;
    return { sign: "±", text: `${a.number} ${change} (replaced)` };
  };

  const replacedCues = [...replacing.values()];
  const summary = lines.filter(l => !followsRow(l) && !followsFile(l) && !replacedCues.includes(l)).map(l =>
    replacing.has(l) ? replaced(l, replacing.get(l))
      : l !== row ? l
        : { sign: "#", text: `${from || "(no number)"} → ${to}` + (renumbered ? `, and the ${renumbered} cues in it` : "") });
  if (renamed) {
    summary.push({ sign: "~", text: renamed === 1 ? "1 cue name follows the new file name" : `${renamed} cue names follow the new file names` });
  }
  return summary;
}

/**
 * What to do with one value of an existing cue, from its value in QLab, in the sheet, and in the sheet last time (null
 * if unknown): "same" (nothing to do), "set" (only the sheet changed it), "keep" (only QLab changed it) or "conflict"
 * (both changed it).
 */
function qlabDecide(qlabValue, sheetValue, lastValue) {
  if (qlabValue === sheetValue) {
    return "same";
  }
  if (lastValue == null || qlabValue === lastValue) {
    return "set";
  }
  return sheetValue === lastValue ? "keep" : "conflict";
}

/** A key with the row id `from` renamed to `to`, also where it names the media of that row (see generateQlab). */
function qlabRenamedKey(k, from, to) {
  if (k === from) {
    return to;
  }
  if (k.startsWith(from + "/")) {
    k = to + k.slice(from.length);
  }
  return k.split(`:${from}/`).join(`:${to}/`);
}

/** The items of a rising run (not necessarily adjacent) in a list of numbers that is as long as possible. */
function qlabLongestRisingRun(seq) {
  const best = []; // for each item: the length of the longest run that ends with it
  const prior = []; // for each item: the index of the item before it in that run, or -1
  let last = -1;
  seq.forEach((x, i) => {
    best.push(1);
    prior.push(-1);
    for (let j = 0; j < i; j++) {
      if (seq[j] < x && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prior[i] = j;
      }
    }
    if (last < 0 || best[i] > best[last]) {
      last = i;
    }
  });
  const run = [];
  for (let i = last; i >= 0; i = prior[i]) {
    run.unshift(seq[i]);
  }
  return run;
}

/** A value as the preview shows it: times in seconds. */
function qlabShownValue(name, value) {
  if (value == null || value === "") {
    return "nothing";
  }
  if (name === "preWait" || name === "duration") {
    return `${Number(value) / 1000} s`;
  }
  if (name === "opacity") {
    return String(Number(value) / 1000);
  }
  if (name === "rotation") {
    return value === "3d" ? "a 3D rotation" : `${value}°`;
  }
  if (name === "scale") {
    // As the script reads it: the style in Fill Stage mode (fit, fill or stretch), "<x>/<y>" if the two scales differ.
    if (/^[a-z]+$/.test(value)) {
      return `Fill Stage (${value})`;
    }
    return value.split("/").map(x => Number(x) / 1000).join(" × ");
  }
  return `"${value}"`;
}

function qlabEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The preview of a plan (see qlabPlan) as HTML: the counts, the questions, and a section for each row with changes.
 * `locked`: the answers can't be changed anymore (applied or cancelled).
 */
function qlabPreviewHtml(plan, locked) {
  const esc = qlabEscape;
  const out = [];
  const c = plan.counts;
  const counts = [[c.created, "cue created", "cues created"], [c.updated, "updated", "updated"], [c.moved, "moved", "moved"],
    [c.renamed, "row renamed", "rows renamed"], [c.removed, "marked as removed", "marked as removed"],
    [c.kept, "keeps values changed in QLab", "keep values changed in QLab"]];
  out.push(`<div class="counts">${counts.map(([n, one, many]) => `<span class="count${n ? "" : " zero"}"><b>${n}</b> ${n === 1 ? one : many}</span>`).join("")}</div>`);

  const question = (kind, id, text, options) => `<div class="question"><p>${text}</p>` + options.map(([value, label, checked]) =>
    `<label><input type="radio" name="${esc(kind + ":" + id)}" data-question="${kind}" data-id="${esc(id)}" value="${value}"${checked ? " checked" : ""}${locked ? " disabled" : ""}> ${label}</label>`).join("") + "</div>";
  if (plan.renames.length || plan.conflicts.length) {
    out.push(`<section><h2>Questions</h2>`);
    for (const r of plan.renames) {
      out.push(question("rename", r.id, `Was row <b>${esc(r.from)}</b> renamed to <b>${esc(r.to)}</b>? They show the same files.`, [
        ["yes", "Yes, it keeps its cues and the changes made in QLab", r.accepted],
        ["no", "No, it is a removed row plus a new one", !r.accepted]]));
    }
    for (const q of plan.conflicts) {
      out.push(question("conflict", q.id, `Cue <b>${esc(q.number)}</b> ${esc(q.name)} was changed in QLab and in the sheet.`, [
        ["qlab", `Keep ${esc(qlabShownValue(q.name, q.qlab))} from QLab`, !q.takeSheet],
        ["sheet", `Take ${esc(qlabShownValue(q.name, q.sheet))} from the sheet`, q.takeSheet]]));
    }
    out.push(`</section>`);
  }

  out.push(`<section><h2>Changes</h2>`);
  if (plan.sections.length === 0) {
    out.push(`<p class="none">The cue list already matches the sheet.</p>`);
  } else {
    const legend = [["+", "new"], ["~", "changed"], ["±", "replaced"], ["#", "renumbered"], [">", "moves"], ["-", "marked as removed"], ["^", "back from removed"], ["=", "kept from QLab"], ["!", "problem"]];
    out.push(`<p class="legend">${legend.map(([sign, text]) => `<span data-sign="${esc(sign)}"><span class="sign">${esc(sign)}</span>${text}</span>`).join("")}</p>`);
    out.push(`<p class="rows-legend"><span style="background: var(--row-new)"></span>new row<span style="background: var(--row-changed)"></span>changed row<span style="background: var(--row-removed)"></span>removed row</p>`);
  }
  const statusText = { new: "new row", removed: "removed from the sheet", renamed: "renamed", changed: "" };
  for (const s of plan.sections) {
    out.push(`<div class="row ${s.status}"><h3><span class="id">${esc(s.header)}</span> ${esc(s.title)}${statusText[s.status] ? ` <span class="tag">${statusText[s.status]}</span>` : ""}</h3>`);
    const line = l => `<div class="line" data-sign="${esc(l.sign)}"><span class="sign">${esc(l.sign)}</span>${esc(l.text)}</div>`;
    out.push(...s.summary.map(line));
    if (s.summary.length !== s.lines.length || s.summary.some((l, i) => l !== s.lines[i])) {
      out.push(`<details><summary>${s.lines.length === 1 ? "The change" : `All ${s.lines.length} changes`}</summary>`, ...s.lines.map(line), `</details>`);
    }
    out.push(`</div>`);
  }
  if (plan.unchanged) {
    out.push(`<p class="unchanged">${plan.unchanged} ${plan.unchanged === 1 ? "row" : "rows"} without changes.</p>`);
  }
  out.push(`</section>`);
  return out.join("\n");
}

/**
 * The preview page of the update script (see qlabPage). The script fills in the title and the cue list as it is, saves
 * the page next to the workspace and opens it in Safari. The page plans the update (qlabPlan) and shows it, plans
 * again whenever a question is answered, and on Apply hands the steps to the script, which reads window.zest. The
 * script then reports how it went (zestDone) and saves the page again, so that it also logs the update.
 */
const QLAB_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%PAGE_TITLE%%</title>
<style>
:root {
  color-scheme: dark; /* always dark, like QLab */
  --bg: #1c1c1e; --fg: #f2f2f7; --muted: #a1a1a6; --line: #3a3a3c; --card: #2c2c2e;
  --add: #3fb950; --remove: #ff6b6b; --change: #58a6ff; --keep: #d29922; --problem: #f0883e; --accent: #0a84ff;
  --row-new: #3fb950; --row-new-bg: #3fb9501f; --row-changed: #e3b341; --row-changed-bg: #e3b3411a;
  --row-removed: #f85149; --row-removed-bg: #f851491f;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 28px 16px 110px; }
h1 { font-size: 22px; margin: 0 0 2px; }
.sub { color: var(--muted); margin: 0 0 18px; }
.counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 26px; }
.count { background: var(--card); border-radius: 8px; padding: 5px 10px; }
.count b { font-variant-numeric: tabular-nums; }
.count.zero { color: var(--muted); }
section { margin: 0 0 30px; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
.question { background: var(--card); border-left: 3px solid var(--keep); border-radius: 6px; padding: 10px 14px; margin: 0 0 10px; }
.question p { margin: 0 0 6px; }
.question label { display: block; padding: 2px 0; }
.legend { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.legend > span { margin-right: 14px; white-space: nowrap; }
.legend .sign { width: 1.3em; }
.row { border-left: 4px solid var(--line); border-radius: 6px; padding: 10px 14px; margin: 0 0 10px; background: var(--card); }
.row.new { border-left-color: var(--row-new); background: var(--row-new-bg); }
.row.changed, .row.renamed { border-left-color: var(--row-changed); background: var(--row-changed-bg); }
.row.removed { border-left-color: var(--row-removed); background: var(--row-removed-bg); }
.rows-legend { color: var(--muted); font-size: 13px; margin: -4px 0 14px; }
.rows-legend span { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 5px 0 12px; }
.rows-legend span:first-child { margin-left: 0; }
.row h3 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.row .id { font-family: ui-monospace, Menlo, monospace; }
.tag { font-size: 12px; font-weight: 500; border-radius: 4px; padding: 1px 6px; margin-left: 4px; background: var(--card); color: var(--muted); }
.row.new .tag { color: var(--add); }
.row.removed .tag { color: var(--remove); }
.row.renamed .tag { color: var(--change); }
.line { font: 13px/1.5 ui-monospace, Menlo, monospace; padding-left: 1.8em; text-indent: -1.8em; }
.sign { display: inline-block; width: 1.8em; text-indent: 0; font-weight: 700; }
[data-sign="+"] .sign, [data-sign="^"] .sign { color: var(--add); }
[data-sign="-"] .sign { color: var(--remove); }
[data-sign="~"] .sign, [data-sign="±"] .sign, [data-sign="#"] .sign, [data-sign=">"] .sign { color: var(--change); }
[data-sign="="] .sign { color: var(--keep); }
[data-sign="!"] { color: var(--problem); }
details { margin: 4px 0 0 1.8em; }
details summary { color: var(--muted); font-size: 13px; cursor: pointer; }
.none, .unchanged { color: var(--muted); }
.result { border-radius: 6px; padding: 10px 14px; margin: 0 0 26px; background: var(--card); border-left: 3px solid var(--add); }
.result.problems { border-left-color: var(--problem); }
.result p { margin: 0 0 4px; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: 12px 16px; }
.bar div { max-width: 860px; margin: 0 auto; display: flex; gap: 12px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
.bar .message { margin-right: auto; color: var(--muted); }
button { font: inherit; padding: 7px 18px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>%%SHOW%%: QLab update</h1>
<p class="sub">%%PAGE_TITLE%%</p>
<div id="result"></div>
<div id="preview"></div>
</main>
<div class="bar"><div id="bar"></div></div>
<script id="saved" type="application/json"></script>
<script>
var SHEET = %%SHEET%%;
// The cue list as it was when the script ran: [listID, mediaPath, whether the media folder could be read, the files in
// it, the cues (see scanCues in the script)].
var STATE = %%QLAB_STATE%%;

%%CODE%%

var QLAB = {
  listID: STATE[0],
  mediaPath: STATE[1],
  files: STATE[2] ? STATE[3] : null,
  cues: STATE[4].map(function (c) {
    return { id: c[0], type: c[1], parent: c[2], number: c[3], name: c[4], notes: c[5], target: c[6], values: c[7] };
  }),
};

// After the update, the script saves this page with the answers and the result in #saved.
var saved = null;
try {
  saved = JSON.parse(document.getElementById("saved").textContent || "null");
} catch (e) {}
var answers = saved ? saved.answers : { notRenamed: [], takeSheet: [] };
var plan = null;
// What the script reads: waiting, apply (with the steps), cancel, or done.
window.zest = { state: saved ? "done" : "waiting" };

function render() {
  var state = window.zest.state;
  plan = qlabPlan(SHEET, QLAB, answers);
  document.getElementById("preview").innerHTML = qlabPreviewHtml(plan, state !== "waiting");
  var nothing = plan.changes === 0 && plan.renames.length === 0 && plan.conflicts.length === 0;
  var bar = "";
  if (state === "waiting" && nothing) {
    bar = '<span class="message">Nothing to update.</span><button onclick="cancel()">Close</button>';
  } else if (state === "waiting") {
    bar = '<span class="message">Nothing changes in QLab until you click Apply.</span>' +
      '<button onclick="cancel()">Cancel</button><button class="primary" onclick="apply()">Apply ' + plan.changes + (plan.changes === 1 ? " change" : " changes") + "</button>";
  } else if (state === "apply") {
    bar = '<span class="message">Applying in QLab…</span>';
  } else if (state === "cancel") {
    bar = '<span class="message">Cancelled, nothing was changed. You can close this page.</span>';
  } else {
    bar = '<span class="message">Applied ' + qlabEscape(saved.at) + ".</span>";
  }
  document.getElementById("bar").innerHTML = bar;

  var result = "";
  if (saved) {
    var problems = saved.problems;
    result = '<div class="result' + (problems.length ? " problems" : "") + '"><p><b>Applied ' + qlabEscape(saved.at) + ".</b> " +
      (problems.length ? problems.length + (problems.length === 1 ? " problem:" : " problems:") : "No problems.") + "</p>" +
      problems.map(function (p) { return '<div class="line" data-sign="!"><span class="sign">!</span>' + qlabEscape(p) + "</div>"; }).join("") + "</div>";
  }
  document.getElementById("result").innerHTML = result;
}

document.addEventListener("change", function (e) {
  var input = e.target;
  if (!input.dataset || !input.dataset.question) return;
  var id = input.dataset.id;
  if (input.dataset.question === "rename") {
    answers.notRenamed = answers.notRenamed.filter(function (x) { return x !== id; });
    if (input.value === "no") answers.notRenamed.push(id);
  } else {
    answers.takeSheet = answers.takeSheet.filter(function (x) { return x !== id; });
    if (input.value === "sheet") answers.takeSheet.push(id);
  }
  render();
});

function apply() {
  window.zest = { state: "apply", steps: plan.steps };
  render();
}

function cancel() {
  window.zest = { state: "cancel" };
  render();
}

// Called by the script once it has carried out the steps.
function zestDone(problems) {
  saved = { answers: answers, problems: problems, at: new Date().toLocaleString() };
  document.getElementById("saved").textContent = JSON.stringify(saved).replace(/</g, "\\u003c");
  window.zest = { state: "done" };
  render();
}

render();
</script>
</body>
</html>
`;

/**
 * A Perl script (Perl comes with macOS) that sends OSC messages to QLab on the same Mac, for what AppleScript can't do:
 * rotating video cues. It connects over TCP (SLIP framed), so the replies come back on the same connection, and logs in
 * with /connect first if it is given a passcode (Workspace Settings > Network > OSC Access).
 *   perl -e <script> <passcode or ""> <address> [f:<number> | s:<text>]... [; <address> ...]...
 * It prints a line for each reply to /connect ("connect <status> <data>") and to /cue_id/<id>/quaternion ("<id> <status>
 * <rotation>", tab separated). The rotation is in whole degrees around the Z axis, from -179 to 180, or "3d" if the cue
 * is rotated around another axis too. QLab doesn't reply to the messages that change something.
 * It has no comments and each statement ends with ";", because the script gets it on one line (see asString).
 */
const QLAB_OSC_PERL = String.raw`use strict; use IO::Socket::INET; use JSON::PP;
my ($passcode, @words) = @ARGV;
sub pad { my $s = shift() . "\0"; $s .= "\0" while length($s) % 4; return $s; }
sub slip { my $s = shift; $s =~ s/\xDB/\xDB\xDD/g; $s =~ s/\xC0/\xDB\xDC/g; return "\xC0" . $s . "\xC0"; }
sub message { my ($address, @args) = @_; my ($types, $data) = (',', ''); for (@args) { my ($t, $v) = split /:/, $_, 2; $types .= $t; $data .= $t eq 'f' ? pack('f>', $v) : pad($v); } return slip(pad($address) . pad($types) . $data); }
my @messages = ([]);
for my $w (@words) { if ($w eq ';') { push @messages, []; } else { push @{$messages[-1]}, $w; } }
@messages = grep { @$_ } @messages;
my $expected = ($passcode ne '' ? 1 : 0) + scalar(grep { @$_ == 1 && $_->[0] =~ m{/quaternion$} } @messages);
my $sock = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => 53000, Proto => 'tcp', Timeout => 2) or die "can't connect to QLab's OSC port (TCP 53000): $!\n";
binmode $sock;
my $out = $passcode ne '' ? message('/connect', "s:$passcode") : '';
$out .= message(@$_) for @messages;
print $sock $out; $sock->flush;
my ($buffer, $chunk) = ('', '');
my $in = ''; vec($in, fileno($sock), 1) = 1;
while ($expected > 0) { my $frames = () = $buffer =~ /\xC0[^\xC0]+\xC0/g; last if $frames >= $expected; last unless select(my $ready = $in, undef, undef, 2.0); last unless sysread($sock, $chunk, 65535); $buffer .= $chunk; }
for my $frame (grep { length } split /\xC0/, $buffer) {
  $frame =~ s/\xDB\xDC/\xC0/g; $frame =~ s/\xDB\xDD/\xDB/g;
  my @parts = grep { length } split /\0+/, $frame;
  my $reply = eval { decode_json($parts[-1]) } or next;
  my ($address, $status) = ($reply->{address} // '', $reply->{status} // '');
  if ($address =~ m{/connect$}) { print join("\t", 'connect', $status, $reply->{data} // ''), "\n"; next; }
  next unless $address =~ m{/cue_id/([^/]+)/quaternion$};
  my ($id, $degrees, $q) = ($1, '', $reply->{data});
  if ($status eq 'ok' && ref $q eq 'ARRAY' && @$q == 4) {
    my ($x, $y, $z, $w) = @$q;
    if (abs($x) < 0.001 && abs($y) < 0.001) { $degrees = 2 * atan2($z, $w) * 45 / atan2(1, 1); $degrees -= 360 while $degrees > 180.5; $degrees += 360 while $degrees <= -179.5; $degrees = sprintf('%.0f', $degrees) + 0; } else { $degrees = '3d'; }
  }
  print join("\t", $id, $status, $degrees), "\n";
}
`;

const QLAB_SCRIPT_TEMPLATE = `-- Generated by the ZEST cue list sheet ("ZEST > Generate QLab script"). Do not edit by hand.
-- Show: %%SHOW%%
-- Run this on the QLab Mac with the show workspace open (open in Script Editor, press Run).
-- %%PURPOSE%%

use AppleScript version "2.4"
use framework "Foundation" -- for JSON
use scripting additions

property cueListName : %%CUE_LIST%%
property mediaFolder : %%MEDIA_FOLDER%% -- relative to the folder containing the workspace, or an absolute path
property rebuild : %%REBUILD%% -- true: delete the cue list and build it again; false: update it in place
property mediaPath : "" -- the full path of the media folder, see below
property theList : missing value
property theListID : "" -- the uniqueID of the cue list

property scanned : {} -- the cues in the cue list (see scanCues)
property createdRefs : {} -- the cues created by this run, as "new:<key>" (see qlabPlan in qlab.js)
property createdIDs : {} -- and their uniqueIDs
property failedValues : {} -- the values that couldn't be set, as "<cue>#<value name>"
property problems : {}

-- OSC, for rotating cues (see QLAB_OSC_PERL in qlab.js).
property oscPerl : %%OSC_PERL%%
property oscPasscode : "" -- asked for only if QLab refuses without one
property oscAsked : false

-- JSON, with macOS's built-in Foundation.
on toJSON(x)
  set {jsonData, jsonError} to current application's NSJSONSerialization's dataWithJSONObject:x options:0 |error|:(reference)
  if jsonData is missing value then error (jsonError's localizedDescription() as text)
  return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end toJSON

-- Lists come back as lists, objects as records, null as missing value.
on fromJSON(t)
  set jsonData to (current application's NSString's stringWithString:t)'s dataUsingEncoding:(current application's NSUTF8StringEncoding)
  set {x, jsonError} to current application's NSJSONSerialization's JSONObjectWithData:jsonData options:0 |error|:(reference)
  if x is missing value then error (jsonError's localizedDescription() as text)
  return item 1 of ((current application's NSArray's arrayWithObject:x) as list)
end fromJSON

-- (open for access with POSIX file doesn't work in a script that uses Foundation.)
on writeText(p, t)
  set {ok, writeError} to (current application's NSString's stringWithString:t)'s writeToFile:p atomically:true encoding:(current application's NSUTF8StringEncoding) |error|:(reference)
  if not (ok as boolean) then error (writeError's localizedDescription() as text)
end writeText

on replaceText(t, search, replacement)
  set AppleScript's text item delimiters to search
  set parts to text items of t
  set AppleScript's text item delimiters to replacement
  set t to parts as text
  set AppleScript's text item delimiters to ""
  return t
end replaceText

on joinText(parts, separator)
  set AppleScript's text item delimiters to separator
  set joined to parts as text
  set AppleScript's text item delimiters to ""
  return joined
end joinText

on indexOf(lst, x)
  considering case
    repeat with i from 1 to count of lst
      if item i of lst is x then return i
    end repeat
  end considering
  return 0
end indexOf

-- The uniqueID of a cue named by a step (see qlabPlan in qlab.js).
on idOf(cueRef)
  if cueRef is "list" then return theListID
  if cueRef starts with "new:" then
    set i to my indexOf(createdRefs, cueRef)
    if i is 0 then error "no cue " & cueRef
    return item i of createdIDs
  end if
  return cueRef
end idOf

-- Seconds or an opacity as whole thousandths, as in the values from the sheet (see sheetValues in qlab.js).
on thousandths(x)
  return ((round (x * 1000) rounding as taught in school) as integer) as text
end thousandths

-- The name of a file, without its folder.
on fileName(p)
  set AppleScript's text item delimiters to "/"
  set n to last text item of p
  set AppleScript's text item delimiters to ""
  return n
end fileName

-- The values the sheet controls for each cue type (see sheetValues in qlab.js).
on valueNames(cueType)
  if cueType is "Group" then return {"name", "continue", "preWait"}
  if cueType is "Video" then return {"name", "continue", "file", "stage", "opacity", "loop", "layer", "scale"}
  if cueType is "Camera" then return {"name", "continue", "stage", "opacity", "layer", "scale"}
  if cueType is "Fade" then return {"name", "continue", "duration", "opacity", "stopWhenDone"}
  return {"name", "continue"}
end valueNames

-- Reads one value the sheet controls, as text like the sheet's ("" if there is none).
on getValue(c, n)
  set v to my readValue(c, n)
  if v is missing value then return ""
  return v as text
end getValue

on readValue(c, n)
  tell application id "com.figure53.QLab.5"
    try
      if n is "name" then
        -- Without the mark of a removed cue (see qlabPlan), which goes away when its row comes back.
        set cueName to q name of c
        if cueName starts with "REMOVED " then return text 9 thru -1 of cueName
        return cueName
      end if
      if n is "continue" then
        set m to continue mode of c
        if m is auto_follow then return "follow"
        if m is auto_continue then return "continue"
        return "none"
      end if
      if n is "preWait" then return my thousandths(pre wait of c)
      if n is "file" then return my fileName(POSIX path of ((file target of c) as alias))
      if n is "stage" then return stage name of c
      if n is "opacity" then return my thousandths(opacity of c)
      if n is "loop" then return (infinite loop of c) as text
      if n is "layer" then return (layer of c) as text
      if n is "scale" then
        if fill stage of c then
          -- fit, fill or stretch (see QLAB_FILL_STYLES in qlab.js)
          try
            return (fill style of c) as text
          end try
          -- No style (e.g. a camera cue, if it has none): reads as the sheet's default.
          return "fit"
        end if
        set scaleX to my thousandths(scale x of c)
        set scaleY to my thousandths(scale y of c)
        if scaleX is scaleY then return scaleX
        return scaleX & "/" & scaleY
      end if
      if n is "duration" then return my thousandths(duration of c)
      if n is "stopWhenDone" then return (stop target when done of c) as text
    end try
  end tell
  return ""
end readValue

-- Sends OSC messages to QLab (see QLAB_OSC_PERL in qlab.js): words are the addresses and arguments, with ";" between
-- the messages. Returns the lines of the replies.
on oscRun(oscWords)
  set cmd to "perl -e " & quoted form of oscPerl & " " & quoted form of oscPasscode
  repeat with w in oscWords
    set cmd to cmd & " " & quoted form of (contents of w)
  end repeat
  return paragraphs of (do shell script cmd)
end oscRun

-- The rotation of a cue in the replies of oscRun ("" if there is none, e.g. access denied).
on rotationIn(replyLines, cueID)
  set AppleScript's text item delimiters to tab
  repeat with x in replyLines
    set fields to text items of (contents of x)
    if (count of fields) is 3 and item 1 of fields is cueID and item 2 of fields is "ok" then
      set AppleScript's text item delimiters to ""
      return item 3 of fields
    end if
  end repeat
  set AppleScript's text item delimiters to ""
  return ""
end rotationIn

-- Asks for the OSC passcode, once per run, when QLab doesn't let the script change cues without one.
on askPasscode()
  set oscAsked to true
  activate
  set dialogResult to display dialog "QLab doesn't let this script rotate cues over OSC without a passcode." & return & return & "Enter the passcode with Edit permission from Workspace Settings > Network > OSC Access (it isn't saved), or click Skip." default answer "" buttons {"Skip", "OK"} default button 2 with hidden answer
  if button returned of dialogResult is "OK" then set oscPasscode to text returned of dialogResult
end askPasscode

-- Adds the rotation of each video and camera cue that the sheet rotated before (see sheetValues in qlab.js) to its
-- values in scanned, read with OSC.
on readRotations()
  set oscWords to {}
  repeat with i from 1 to count of scanned
    set entry to item i of scanned
    if (item 6 of entry) contains "rotation=" and (item 2 of entry) is in {"Video", "Camera"} then
      set end of oscWords to "/cue_id/" & (item 1 of entry) & "/quaternion"
      set end of oscWords to ";"
    end if
  end repeat
  if oscWords is {} then return
  repeat 2 times
    set replyLines to my oscRun(oscWords)
    set allRead to true
    repeat with i from 1 to count of scanned
      if (item 6 of item i of scanned) contains "rotation=" and (item 2 of item i of scanned) is in {"Video", "Camera"} then
        if my rotationIn(replyLines, item 1 of item i of scanned) is "" then set allRead to false
      end if
    end repeat
    if allRead or oscAsked then exit repeat
    my askPasscode()
  end repeat
  repeat with i from 1 to count of scanned
    set r to my rotationIn(replyLines, item 1 of item i of scanned)
    if r is not "" then set end of item 8 of item i of scanned to {"rotation", r}
  end repeat
end readRotations

-- Rotates a video or camera cue around the Z axis: Geometry mode "Custom" (fill stage off) with AppleScript, the
-- rotation with OSC (AppleScript can't), and reads it back to check. Returns a problem, or "" if it worked.
on setRotation(c, v)
  tell application id "com.figure53.QLab.5"
    set cueID to uniqueID of c
    try
      set fill stage of c to false
    end try
  end tell
  set oscWords to {"/cue_id/" & cueID & "/resetRotation", ";", "/cue_id/" & cueID & "/rotate/z", "f:" & v, ";", "/cue_id/" & cueID & "/quaternion"}
  repeat 2 times
    try
      set r to my rotationIn(my oscRun(oscWords), cueID)
    on error e
      return "can't rotate it with OSC (" & e & ")"
    end try
    if r is v then return ""
    if oscAsked then exit repeat
    my askPasscode()
  end repeat
  return "QLab didn't rotate it to " & v & " degrees (is OSC allowed, with Edit permission? see Workspace Settings > Network > OSC Access)"
end setRotation

-- Puts a video cue in Fill Stage with a style: fit, fill or stretch. The style is set with a script compiled when it
-- runs, so that a style QLab doesn't know (e.g. on a camera cue) is a problem with that cue, not an error that stops the
-- whole script. Returns a problem, or "" if it worked.
on setFillStyle(c, v)
  try
    tell application id "com.figure53.QLab.5"
      set fill stage of c to true
      set cueID to uniqueID of c
    end tell
    tell current application to run script "tell application id \\"com.figure53.QLab.5\\" to tell front workspace to set fill style of cue id \\"" & cueID & "\\" to " & v
  on error e
    return "can't set Fill Stage " & v & " (" & e & ")"
  end try
  if my readValue(c, "scale") is not v then return "QLab didn't set Fill Stage " & v
  return ""
end setFillStyle

-- Sets one value the sheet controls. Returns a problem, or "" if it worked.
on setValue(c, n, v)
  if n is "rotation" then return my setRotation(c, v)
  if n is "file" then
    set f to mediaPath & "/" & v
    try
      do shell script "test -e " & quoted form of f
    on error
      return "missing file " & f
    end try
    set fileRef to (current application's NSURL's fileURLWithPath:f) as «class furl»
    tell application id "com.figure53.QLab.5" to set file target of c to fileRef
    return ""
  end if
  tell application id "com.figure53.QLab.5"
    if n is "name" then
      set q name of c to v
    else if n is "continue" then
      -- Starts the next cue when this one ends ("follow"), or right after it starts ("continue", after the next one's pre-wait).
      if v is "follow" then
        set continue mode of c to auto_follow
      else if v is "continue" then
        set continue mode of c to auto_continue
      else
        set continue mode of c to do_not_continue
      end if
    else if n is "preWait" then
      set pre wait of c to (v as integer) / 1000
    else if n is "stage" then
      try
        set stage name of c to v
      on error
        return "no stage named " & v
      end try
    else if n is "opacity" then
      set opacity of c to (v as integer) / 1000
    else if n is "loop" then
      set infinite loop of c to (v is "true")
    else if n is "layer" then
      set layer of c to (v as integer)
    else if n is "scale" then
      -- Fill Stage with a style, or Geometry mode "Custom" and both scales.
      if v is in {"fit", "fill", "stretch"} then return my setFillStyle(c, v)
      try
        set fill stage of c to false
        set scale x of c to (v as integer) / 1000
        set scale y of c to (v as integer) / 1000
      on error e
        return "can't scale it (" & e & ")"
      end try
    else if n is "duration" then
      set duration of c to (v as integer) / 1000
    else if n is "stopWhenDone" then
      set stop target when done of c to (v is "true")
    end if
  end tell
  return ""
end setValue

-- Records every cue in the cue list or group, and in its groups, as {uniqueID, type, uniqueID of the group or cue
-- list, number, name, Notes, uniqueID of the target, values}. The values are read only for the cues with a key (see
-- generateQlab in qlab.js), as {name, value} pairs.
on scanCues(holder)
  tell application id "com.figure53.QLab.5"
    repeat with c in (cues of holder)
      set cc to contents of c
      set cueNotes to ""
      try
        set cueNotes to notes of cc
      end try
      if cueNotes is missing value then set cueNotes to ""
      set cueType to q type of cc
      set cueValues to {}
      set targetID to ""
      if cueNotes starts with "zest:" then
        repeat with valueName in my valueNames(cueType)
          set end of cueValues to {contents of valueName, my getValue(cc, contents of valueName)}
        end repeat
        try
          set targetID to uniqueID of (cue target of cc)
        end try
      end if
      set end of scanned to {uniqueID of cc, cueType, uniqueID of holder, q number of cc, q name of cc, cueNotes, targetID, cueValues}
      if cueType is "Group" then my scanCues(cc)
    end repeat
  end tell
end scanCues

on moveToEnd(cueID, holder)
  tell application id "com.figure53.QLab.5"
    tell front workspace
      set c to cue id cueID
      move cue id cueID of parent of c to end of holder
    end tell
  end tell
end moveToEnd

-- Puts the cues \`wanted\` (uniqueIDs, in sheet order) into the cue list or group in this order. Other cues in it
-- (e.g. added by hand) stay right after the cue they follow now, and the ones before the first cue of the sheet stay
-- first.
on placeCues(holder, wanted)
  set currentIDs to {}
  tell application id "com.figure53.QLab.5"
    repeat with c in (cues of holder)
      set end of currentIDs to uniqueID of c
    end repeat
  end tell

  set present to {}
  repeat with x in currentIDs
    if wanted contains {contents of x} then set end of present to contents of x
  end repeat
  if present = wanted then return

  -- Which other cue follows which cue of the sheet.
  set leaders to {}
  set others to {}
  set lastWanted to ""
  repeat with x in currentIDs
    set y to contents of x
    if wanted contains {y} then
      set lastWanted to y
    else if lastWanted is not "" then
      set end of leaders to lastWanted
      set end of others to y
    end if
  end repeat

  repeat with x in wanted
    set y to contents of x
    my moveToEnd(y, holder)
    repeat with i from 1 to count of others
      if item i of leaders is y then my moveToEnd(item i of others, holder)
    end repeat
  end repeat
end placeCues

-- Carries out the steps planned by qlabPlan (see there). Stops at the first one that fails unexpectedly.
on runSteps(steps)
  set stepIndex to 0
  try
    tell application id "com.figure53.QLab.5"
      tell front workspace
        repeat with s in steps
          set stepIndex to stepIndex + 1
          set stepItems to contents of s
          set stepKind to item 1 of stepItems
          if stepKind is "clearNumber" then
            set q number of cue id (item 2 of stepItems) to ""
          else if stepKind is "create" then
            make type (item 3 of stepItems)
            set c to last item of (selected as list)
            set end of createdRefs to item 2 of stepItems
            set end of createdIDs to uniqueID of c
            if (item 3 of stepItems) is "Fade" then set do opacity of c to true
            if (item 4 of stepItems) is "list" then
              move cue id (uniqueID of c) of parent of c to end of theList
            else
              move cue id (uniqueID of c) of parent of c to end of cue id (my idOf(item 4 of stepItems))
            end if
          else if stepKind is "restore" then
            set c to cue id (my idOf(item 2 of stepItems))
            set q name of c to item 3 of stepItems
            set armed of c to true
            set q color of c to "none"
          else if stepKind is "number" then
            set c to cue id (my idOf(item 2 of stepItems))
            set q number of c to item 3 of stepItems
            if q number of c is not (item 3 of stepItems) then
              set end of problems to "cue number " & (item 3 of stepItems) & " is already used elsewhere in the workspace"
            end if
          else if stepKind is "target" then
            set cue target of cue id (my idOf(item 2 of stepItems)) to cue id (my idOf(item 3 of stepItems))
          else if stepKind is "set" then
            set problem to my setValue(cue id (my idOf(item 2 of stepItems)), item 3 of stepItems, item 4 of stepItems)
            if problem is not "" then
              set end of problems to "cue " & (item 5 of stepItems) & ": " & problem
              set end of failedValues to (item 2 of stepItems) & "#" & (item 3 of stepItems)
            end if
          else if stepKind is "notes" then
            set remembered to {}
            repeat with p in (item 4 of stepItems)
              set keptText to item 2 of p
              if failedValues contains {(item 2 of stepItems) & "#" & (item 1 of p)} then set keptText to item 3 of p
              if keptText is not missing value then set end of remembered to (item 1 of p) & "=" & keptText
            end repeat
            set notes of cue id (my idOf(item 2 of stepItems)) to "zest:" & (item 3 of stepItems) & linefeed & my joinText(remembered, "|") & (item 5 of stepItems)
          else if stepKind is "place" then
            set wanted to {}
            repeat with r in (item 3 of stepItems)
              set end of wanted to my idOf(contents of r)
            end repeat
            if (item 2 of stepItems) is "list" then
              my placeCues(theList, wanted)
            else
              my placeCues(cue id (my idOf(item 2 of stepItems)), wanted)
            end if
          else if stepKind is "remove" then
            set c to cue id (item 2 of stepItems)
            if (item 3 of stepItems) is not "" then set q name of c to item 3 of stepItems
            set armed of c to false
            set q color of c to "red"
            if (item 4 of stepItems) is "yes" then my moveToEnd(item 2 of stepItems, theList)
          end if
        end repeat
      end tell
    end tell
  on error e
    set end of problems to "stopped at step " & stepIndex & " of " & (count of steps) & " (" & e & "), the rest wasn't done"
  end try
end runSteps

-- The Safari tab with the preview page, or missing value.
on findPage(pageTitle)
  tell application "Safari"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if name of t is pageTitle then return contents of t
        end repeat
      end try
    end repeat
  end tell
  return missing value
end findPage

-- Waits for Apply or Cancel on the preview page. Returns the answer of the page (see QLAB_PAGE in qlab.js) with the
-- steps, or missing value if cancelled or closed.
on waitForPage(pageTitle)
  set seen to false
  set startTime to current date
  repeat
    delay 0.5
    set pageTab to my findPage(pageTitle)
    if pageTab is missing value then
      if seen then return missing value
      if (current date) - startTime > 30 then
        activate
        display dialog "The preview page didn't open in Safari." buttons {"OK"} default button 1 with icon caution
        return missing value
      end if
    else
      set seen to true
      set answerJSON to ""
      try
        tell application "Safari" to set answerJSON to do JavaScript "JSON.stringify(window.zest || null)" in pageTab
      on error e
        activate
        display dialog "Safari doesn't let this script read the preview page (" & e & ")." & return & return & "In Safari, open Settings > Advanced and turn on \\"Show features for web developers\\". Then turn on Develop > \\"Allow JavaScript from Apple Events\\", and click Try again." buttons {"Cancel", "Try again"} default button "Try again" cancel button "Cancel" with icon caution
      end try
      if answerJSON is missing value then set answerJSON to ""
      if answerJSON starts with "{\\"state\\":\\"apply\\"" then return my fromJSON(answerJSON)
      if answerJSON starts with "{\\"state\\":\\"cancel\\"" then return missing value
    end if
  end repeat
end waitForPage

set stepsJSON to ""
set pageJSON to ""
%%STEPS%%
%%PAGE%%

set scanned to {}
set createdRefs to {}
set createdIDs to {}
set failedValues to {}
set problems to {}
set oscPasscode to ""
set oscAsked to false

tell application id "com.figure53.QLab.5"
  activate
  tell front workspace
    -- Resolve the media folder.
    set wsPath to missing value
    try
      set wsPath to path
    end try
    if mediaFolder starts with "/" then
      set mediaPath to mediaFolder
    else if wsPath is missing value then
      -- QLab reports no path for unsaved workspaces: ask for the media folder instead.
      tell current application to set chosen to choose folder with prompt "QLab can't tell where this workspace is saved. Select the media folder (\\"" & mediaFolder & "\\"):"
      set mediaPath to POSIX path of chosen
      if mediaPath ends with "/" then set mediaPath to text 1 thru -2 of mediaPath
    else
      tell current application to set wsFolder to do shell script "dirname " & quoted form of wsPath
      set mediaPath to wsFolder & "/" & mediaFolder
    end if

    -- The cue list: built again from scratch, or the existing one updated.
    if rebuild then
      repeat with cl in (cue lists whose q name is cueListName)
        delete cue id (uniqueID of cl)
      end repeat
    end if
    set found to (cue lists whose q name is cueListName)
    if found is {} then
      make type "Cue List"
      set theList to last cue list
      set q name of theList to cueListName
    else
      set theList to item 1 of found
    end if
    set current cue list to theList
    set theListID to uniqueID of theList
  end tell
end tell

if rebuild then
  my runSteps(my fromJSON(stepsJSON))
  set summary to "QLab cue list \\"" & cueListName & "\\" generated (" & (count of createdIDs) & " cues)."
  activate
  if problems is {} then
    display dialog summary buttons {"OK"} default button 1
  else
    display dialog summary & return & return & (count of problems) & " problem(s):" & return & return & my joinText(problems, return) buttons {"OK"} default button 1 with icon caution
  end if
  return
end if

-- Update: read the cue list and the media folder, show the plan in Safari, and carry it out once Apply is clicked
-- there. The page is saved next to the workspace (or on the Desktop), and saved again with the result, as a log.
my scanCues(theList)
try
  my readRotations()
on error e
  activate
  display dialog "The script can't read the rotations of the cues with OSC (" & e & ")." & return & return & "If you continue, the sheet's rotations are set only where the sheet changed them." buttons {"Cancel", "Continue"} default button 2 cancel button 1 with icon caution
end try
set mediaFiles to {}
set filesKnown to false
try
  set mediaFiles to paragraphs of (do shell script "ls -1 " & quoted form of mediaPath)
  set filesKnown to true
end try
set stamp to do shell script "date '+%Y-%m-%d %H.%M.%S'"
set pageTitle to cueListName & " update " & stamp
if wsPath is missing value then
  set pageFolder to POSIX path of (path to desktop)
  set pageFolder to text 1 thru -2 of pageFolder
else
  set pageFolder to do shell script "dirname " & quoted form of wsPath
end if
set pageFile to pageFolder & "/" & pageTitle & ".html"
set html to item 1 of my fromJSON(pageJSON)
set html to my replaceText(html, "%%PAGE_TITLE%%", my replaceText(my replaceText(my replaceText(pageTitle, "&", "&amp;"), "<", "&lt;"), ">", "&gt;"))
set html to my replaceText(html, "%%QLAB_STATE%%", my toJSON({theListID, mediaPath, filesKnown, mediaFiles, scanned}))
my writeText(pageFile, html)
do shell script "open -a Safari " & quoted form of pageFile

set answer to my waitForPage(pageTitle)
if answer is missing value then return
my runSteps(|steps| of answer)

-- Show the result on the page, and save it.
try
  set pageTab to my findPage(pageTitle)
  tell application "Safari"
    do JavaScript "zestDone(" & my toJSON(problems) & ")" in pageTab
    set savedHTML to do JavaScript "'<!doctype html>\\\\n' + document.documentElement.outerHTML" in pageTab
  end tell
  my writeText(pageFile, savedHTML)
on error
  set summary to "QLab cue list \\"" & cueListName & "\\" updated."
  if problems is not {} then set summary to summary & return & return & (count of problems) & " problem(s):" & return & return & my joinText(problems, return)
  activate
  display dialog summary buttons {"OK"} default button 1
end try
`;
