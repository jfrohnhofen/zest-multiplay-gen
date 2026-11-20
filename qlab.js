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
    ops.push({ op: "group", key: row.cue, parent: "", number, name: row.tracks.video?.description || row.description || "", delay: 0, continueMode: "" });
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
 */
function qlabScript(ops, rebuild) {
  const fill = {
    "%%SHOW%%": asString(SHOW_NAME),
    "%%PURPOSE%%": rebuild
      ? `It deletes the cue list ${asString(QLAB_CUE_LIST_NAME)} and rebuilds it from the sheet, so it is safe to re-run.`
      : `It updates the cue list ${asString(QLAB_CUE_LIST_NAME)} to match the sheet. It sets the values the sheet changed since the last run, and keeps the ones changed in QLab and everything the sheet doesn't control (e.g. geometry, effects, cues added by hand).`,
    "%%CUE_LIST%%": asString(QLAB_CUE_LIST_NAME),
    "%%MEDIA_FOLDER%%": asString(QLAB_MEDIA_FOLDER),
    "%%REBUILD%%": String(rebuild),
    "%%OPS%%": chunk(ops.map(toAppleScriptRecord), 50)
      .map(part => "set ops to ops & {" + part.join(", ¬\n    ") + "}").join("\n"),
  };
  let content = QLAB_SCRIPT_TEMPLATE;
  for (const [key, value] of Object.entries(fill)) {
    content = content.split(key).join(value);
  }
  return content;
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
 *
 * Control actions target media that is already running, without needing a file:
 * - `!fade-out [#label] [<sec>]`: fade out and stop the labeled media, or everything on this screen (default 1s).
 * - `!stop [#label]`: stop immediately (blackout).
 * - `!pause [#label]`: pause the labeled video, or everything playing on this screen (the frame stays visible).
 * - `!resume [#label]`: resume the labeled video, or everything paused on this screen.
 */
function parseVideoParams(input, where) {
  const result = { label: null, fade: null, loop: false, keep: false, layer: null, actions: [], hasMediaParams: false };
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
  return result;
}

/** Splits an array into chunks (AppleScript chokes on very long list literals). */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

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
  }
  if (op.op === "fade") {
    values.push(["duration", thousandths(op.duration)], ["opacity", thousandths(op.opacity)], ["stopWhenDone", String(!!op.stop)]);
  }
  return values;
}

// The QLab cue type of each op.
const QLAB_CUE_TYPES = { group: "Group", video: "Video", camera: "Camera", fade: "Fade", stop: "Stop", pause: "Pause", resume: "Start" };

/** Converts an op into an AppleScript record. */
function toAppleScriptRecord(op) {
  // Keys are prefixed with "z" so they can't clash with terms from QLab's AppleScript dictionary.
  const v = {
    zKind: asString(op.op),
    zType: asString(QLAB_CUE_TYPES[op.op]),
    zKey: asString(op.key),
    zParent: asString(op.parent ?? ""),
    zNum: asString(op.number),
    zTarget: asString(op.target ?? ""),
    zValues: "{" + sheetValues(op).map(([name, value]) => `{${asString(name)}, ${asString(value)}}`).join(", ") + "}",
  };
  return "{" + Object.entries(v).map(([k, x]) => `${k}:${x}`).join(", ") + "}";
}

const QLAB_SCRIPT_TEMPLATE = `-- Generated by the ZEST cue list sheet ("ZEST > Generate QLab script"). Do not edit by hand.
-- Show: %%SHOW%%
-- Run this on the QLab Mac with the show workspace open (open in Script Editor, press Run).
-- %%PURPOSE%%

property cueListName : %%CUE_LIST%%
property mediaFolder : %%MEDIA_FOLDER%% -- relative to the folder containing the workspace, or an absolute path
property rebuild : %%REBUILD%% -- true: delete the cue list and build it again; false: update it in place
property mediaPath : "" -- the full path of the media folder, see below

-- The keys (see generateQlab) and uniqueIDs of the cues of the sheet, once they exist, and the ones created by this run.
property cueKeys : {}
property cueIDs : {}
property newIDs : {}

-- The cues that were in the cue list before this run (see scanCues). The key is "" for cues added by hand.
property oldIDs : {}
property oldKeys : {}
property oldTypes : {}
property oldNotes : {}

-- The index of x in the list, or 0.
on indexOf(lst, x)
  considering case
    repeat with i from 1 to count of lst
      if item i of lst is x then return i
    end repeat
  end considering
  return 0
end indexOf

-- The uniqueID of the cue with the given key.
on idOfKey(k)
  set i to my indexOf(cueKeys, k)
  if i is 0 then error "no cue with the key " & k
  return item i of cueIDs
end idOfKey

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

on joinText(parts, separator)
  set AppleScript's text item delimiters to separator
  set joined to parts as text
  set AppleScript's text item delimiters to ""
  return joined
end joinText

-- The lines of the Notes after the key and the remembered values (anything added in QLab), or "".
on extraNotes(n)
  set noteLines to paragraphs of n
  if (count of noteLines) < 3 then return ""
  return linefeed & my joinText(items 3 thru -1 of noteLines, linefeed)
end extraNotes

-- Reads one value the sheet controls (see sheetValues in qlab.js), as text like the sheet's ("" if there is none).
on getValue(c, n)
  set v to my readValue(c, n)
  if v is missing value then return ""
  return v as text
end getValue

on readValue(c, n)
  tell application id "com.figure53.QLab.5"
    try
      if n is "name" then return q name of c
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
      if n is "duration" then return my thousandths(duration of c)
      if n is "stopWhenDone" then return (stop target when done of c) as text
    end try
  end tell
  return ""
end readValue

-- The value the sheet had last time, from the second line of the Notes (see sheetValues in qlab.js), or missing value.
on rememberedValue(n, valueName)
  set noteLines to paragraphs of n
  if (count of noteLines) < 2 then return missing value
  set AppleScript's text item delimiters to "|"
  set pairs to text items of (item 2 of noteLines)
  set AppleScript's text item delimiters to ""
  considering case
    repeat with pair in pairs
      set pairText to contents of pair
      if pairText is (valueName & "=") then return ""
      if pairText starts with (valueName & "=") then return text ((length of valueName) + 2) thru -1 of pairText
    end repeat
  end considering
  return missing value
end rememberedValue

-- What to do with one value of an existing cue, from its value in QLab, in the sheet, and in the sheet last time
-- (missing value if unknown): "same" (nothing to do), "set" (only the sheet changed it), "keep" (only QLab changed it)
-- or "conflict" (both changed it).
on decide(qlabValue, sheetValue, lastValue)
  considering case
    if qlabValue is sheetValue then return "same"
    if lastValue is missing value or qlabValue is lastValue then return "set"
    if sheetValue is lastValue then return "keep"
  end considering
  return "conflict"
end decide

-- A value as it is shown in dialogs: times in seconds.
on shownValue(valueName, v)
  if v is "" then return "nothing"
  if valueName is in {"preWait", "duration"} then return (((v as integer) / 1000) as text) & " s"
  if valueName is "opacity" then return ((v as integer) / 1000) as text
  return "\\"" & v & "\\""
end shownValue

-- Sets one value the sheet controls (see sheetValues in qlab.js). Returns a problem, or "" if it worked.
on setValue(c, n, v)
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
    else if n is "file" then
      set f to mediaPath & "/" & v
      try
        tell current application to do shell script "test -e " & quoted form of f
      on error
        return "missing file " & f
      end try
      set file target of c to POSIX file f
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
    else if n is "duration" then
      set duration of c to (v as integer) / 1000
    else if n is "stopWhenDone" then
      set stop target when done of c to (v is "true")
    end if
  end tell
  return ""
end setValue

-- Records every cue in the cue list or group, and in its groups, with its key (see generateQlab).
on scanCues(holder)
  tell application id "com.figure53.QLab.5"
    repeat with c in (cues of holder)
      set cc to contents of c
      set n to ""
      try
        set n to notes of cc
      end try
      if n is missing value then set n to ""
      set k to ""
      if n starts with "zest:" and (length of paragraph 1 of n) > 5 then set k to text 6 thru -1 of (paragraph 1 of n)
      set end of oldIDs to uniqueID of cc
      set end of oldKeys to k
      set end of oldTypes to q type of cc
      set end of oldNotes to n
      if q type of cc is "Group" then my scanCues(cc)
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

-- The length of the longest rising run (not necessarily adjacent) in a list of numbers.
on longestRising(seq)
  set best to {}
  set longest to 0
  repeat with i from 1 to count of seq
    set b to 1
    repeat with j from 1 to i - 1
      if (item j of seq) < (item i of seq) and (item j of best) + 1 > b then set b to (item j of best) + 1
    end repeat
    set end of best to b
    if b > longest then set longest to b
  end repeat
  return longest
end longestRising

-- Puts the cues \`wanted\` (uniqueIDs, in sheet order) into the cue list or group in this order. Returns how many of the cues
-- that already existed had to move. Other cues in it (e.g. added by hand) stay right after the cue they
-- follow now, and the ones before the first cue of the sheet stay first.
on placeCues(holder, wanted)
  set currentIDs to {}
  tell application id "com.figure53.QLab.5"
    repeat with c in (cues of holder)
      set end of currentIDs to uniqueID of c
    end repeat
  end tell

  -- The cues that already existed and stay where they are form the longest run that is in sheet order already.
  set present to {}
  set positions to {}
  repeat with x in currentIDs
    set w to my indexOf(wanted, contents of x)
    if w > 0 then
      set end of present to contents of x
      if newIDs does not contain {contents of x} then set end of positions to w
    end if
  end repeat
  set moved to (count of positions) - (my longestRising(positions))
  repeat with x in wanted
    if newIDs does not contain {contents of x} and currentIDs does not contain {contents of x} then set moved to moved + 1
  end repeat
  if present = wanted then return moved

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
  return moved
end placeCues

set ops to {}
%%OPS%%

set cueKeys to {}
set cueIDs to {}
set newIDs to {}
set oldIDs to {}
set oldKeys to {}
set oldTypes to {}
set oldNotes to {}
set problems to {}

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
    my scanCues(theList)

    -- Match the cues of the sheet to the existing ones by key. A cue is reused only if it still has the same type
    -- (e.g. a video that becomes a camera is replaced). Existing cues with a key the sheet doesn't have are removed.
    set wantedKeys to {}
    set reused to {} -- for each cue of the sheet: the index of its existing cue (in oldIDs), or 0
    repeat with o in ops
      set end of wantedKeys to zKey of o
      set end of reused to 0
    end repeat
    set removed to {} -- indexes (in oldIDs) of the cues to remove
    repeat with i from 1 to count of oldIDs
      set k to item i of oldKeys
      if k is not "" then
        set d to my indexOf(wantedKeys, k)
        if d is 0 then
          set end of removed to i
        else if (item d of reused) is not 0 then
          set end of problems to "cue " & (q number of cue id (item i of oldIDs)) & " has the same key as another cue (copied in QLab?), so it is treated as added by hand"
          set item i of oldKeys to ""
        else if (item i of oldTypes) is not (zType of item d of ops) then
          set end of removed to i
        else
          set item d of reused to i
        end if
      end if
    end repeat

    -- Ask about the values that both the sheet and QLab changed since the last run, before changing anything.
    set conflictTexts to {}
    set conflictKeys to {} -- "<index in ops>/<value name>"
    repeat with d from 1 to count of ops
      set i to item d of reused
      if i is not 0 then
        set o to item d of ops
        set c to cue id (item i of oldIDs)
        repeat with p in (zValues of o)
          set n to item 1 of p
          set v to item 2 of p
          set qlabValue to my getValue(c, n)
          if my decide(qlabValue, v, my rememberedValue(item i of oldNotes, n)) is "conflict" then
            set end of conflictTexts to (((count of conflictTexts) + 1) as text) & ". cue " & (zNum of o) & " " & n & ": " & my shownValue(n, qlabValue) & " in QLab, " & my shownValue(n, v) & " in the sheet"
            set end of conflictKeys to (d as text) & "/" & n
          end if
        end repeat
      end if
    end repeat
    set takeSheet to {} -- the conflictKeys of the values to take from the sheet
    if conflictTexts is not {} then
      tell current application to set picked to choose from list conflictTexts with title "Changed in both the sheet and QLab" with prompt "These values were changed in the sheet and in QLab. Select the ones to take from the sheet; the others keep their QLab value." OK button name "Update" cancel button name "Cancel" with multiple selections allowed and empty selection allowed
      if picked is false then error number -128 -- cancelled, nothing was changed
      repeat with t in picked
        set end of takeSheet to item (my indexOf(conflictTexts, contents of t)) of conflictKeys
      end repeat
    end if

    -- Clear the cue numbers that change first, so that no number is still taken by another cue when it is set.
    repeat with r from 1 to count of removed
      set q number of cue id (item (item r of removed) of oldIDs) to ""
    end repeat
    repeat with d from 1 to count of ops
      set i to item d of reused
      if i is not 0 then
        set c to cue id (item i of oldIDs)
        if q number of c is not (zNum of item d of ops) then set q number of c to ""
      end if
    end repeat

    set updated to 0
    set kept to 0 -- cues with values changed in QLab that were kept
    repeat with d from 1 to count of ops
      set o to item d of ops
      set i to item d of reused
      if i is 0 then
        make type (zType of o)
        set c to last item of (selected as list)
        set end of newIDs to uniqueID of c
        if (zKind of o) is "fade" then set do opacity of c to true
        set extra to ""
      else
        set c to cue id (item i of oldIDs)
        set extra to my extraNotes(item i of oldNotes)
      end if

      if q number of c is not (zNum of o) then
        set q number of c to (zNum of o)
        if q number of c is not (zNum of o) then
          set end of problems to "cue number " & (zNum of o) & " is already used elsewhere in the workspace"
        end if
      end if

      if (zTarget of o) is not "" then
        set targetID to my idOfKey(zTarget of o)
        set currentTarget to ""
        try
          set currentTarget to uniqueID of (cue target of c)
        end try
        if currentTarget is not targetID then set cue target of c to cue id targetID
      end if

      -- The values the sheet controls. A value that only the sheet changed since last time is set, one that only QLab
      -- changed is kept (see decide), and one that both changed as picked above. The Notes remember the sheet's
      -- values (also where the QLab value is kept, so it stays until the sheet changes again), except where they
      -- couldn't be set, so that those are tried again next time.
      set remembered to {}
      set changed to false
      set keptAny to false
      repeat with p in (zValues of o)
        set n to item 1 of p
        set v to item 2 of p
        set remember to v
        set lastValue to missing value
        if i is 0 then
          set verdict to "set"
        else
          set qlabValue to my getValue(c, n)
          set lastValue to my rememberedValue(item i of oldNotes, n)
          set verdict to my decide(qlabValue, v, lastValue)
          if verdict is "conflict" then
            if takeSheet contains {(d as text) & "/" & n} then
              set verdict to "set"
            else
              set verdict to "keep"
            end if
          end if
        end if
        if verdict is "set" then
          set problem to my setValue(c, n, v)
          if problem is not "" then
            set end of problems to "cue " & (zNum of o) & ": " & problem
            set remember to lastValue
          end if
          set changed to true
        else if verdict is "keep" then
          set keptAny to true
          if n is "file" and qlabValue is "" then set end of problems to "cue " & (zNum of o) & ": missing file " & mediaPath & "/" & v
        end if
        if remember is not missing value then set end of remembered to n & "=" & remember
      end repeat
      if i is not 0 and changed then set updated to updated + 1
      if keptAny then set kept to kept + 1
      set notes of c to "zest:" & (zKey of o) & linefeed & my joinText(remembered, "|") & extra
      set end of cueKeys to (zKey of o)
      set end of cueIDs to (uniqueID of c)

      -- A new cue goes to the end of its group, or of the cue list. placeCues sorts them below.
      if i is 0 then
        if (zParent of o) is "" then
          move cue id (uniqueID of c) of parent of c to end of theList
        else
          move cue id (uniqueID of c) of parent of c to end of cue id (my idOfKey(zParent of o))
        end if
      end if
    end repeat

    -- Put the cues of each group, and of the cue list, in sheet order.
    set containerKeys to {}
    set containerCues to {}
    repeat with d from 1 to count of ops
      set parentKey to zParent of item d of ops
      set j to my indexOf(containerKeys, parentKey)
      if j is 0 then
        set end of containerKeys to parentKey
        set end of containerCues to {}
        set j to count of containerKeys
      end if
      set end of item j of containerCues to (item d of cueIDs)
    end repeat
    set moved to 0
    repeat with j from 1 to count of containerKeys
      if item j of containerKeys is "" then
        set holder to theList
      else
        set holder to cue id (my idOfKey(item j of containerKeys))
      end if
      set moved to moved + (my placeCues(holder, item j of containerCues))
    end repeat

    -- Delete the cues the sheet doesn't have anymore (with what is inside them, if they are groups).
    repeat with r from 1 to count of removed
      set removedID to item (item r of removed) of oldIDs
      try
        set c to cue id removedID
        delete cue id removedID of parent of c
      end try
    end repeat

    if rebuild then
      set summary to "QLab cue list \\"" & cueListName & "\\" generated (" & (count of ops) & " cues)."
    else
      set summary to "QLab cue list \\"" & cueListName & "\\" updated: " & (count of newIDs) & " cues created, " & updated & " updated, " & moved & " moved, " & (count of removed) & " deleted. " & kept & " cues keep values changed in QLab."
      if conflictTexts is not {} then
        set summary to summary & " Of " & (count of conflictTexts) & " values changed in both, " & (count of takeSheet) & " were taken from the sheet."
      end if
    end if
    if problems is {} then
      display dialog summary buttons {"OK"} default button 1
    else
      set AppleScript's text item delimiters to return
      display dialog summary & return & return & (count of problems) & " problem(s):" & return & return & (problems as text) buttons {"OK"} default button 1 with icon caution
    end if
  end tell
end tell
`;
