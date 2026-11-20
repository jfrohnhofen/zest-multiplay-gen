/**
 * Generates an AppleScript (`<SHOW_NAME>.applescript`) that builds the QLab video cue list.
 *
 * Writing a QLab workspace file directly is not feasible (it is an undocumented, nested binary plist with macOS
 * file bookmarks inside). Instead, the generated script is run on the QLab Mac with the show workspace open. It
 * deletes the previously generated cue list (named QLAB_CUE_LIST_NAME) and recreates it from scratch, so it can be
 * re-run whenever the sheet changes.
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

  const fill = {
    "%%SHOW%%": asString(SHOW_NAME),
    "%%CUE_LIST%%": asString(QLAB_CUE_LIST_NAME),
    "%%MEDIA_FOLDER%%": asString(QLAB_MEDIA_FOLDER),
    "%%OPS%%": chunk(ops.map(toAppleScriptRecord), 50)
      .map(part => "set ops to ops & {" + part.join(", ¬\n    ") + "}").join("\n"),
  };
  let content = QLAB_SCRIPT_TEMPLATE;
  for (const [key, value] of Object.entries(fill)) {
    content = content.split(key).join(value);
  }
  ctx.at();
  ctx.report("output not updated");
  if (ctx.hasErrors()) {
    // Do not overwrite the existing script with an incomplete / broken one.
    return ops;
  }
  getOrCreateFile(`${SHOW_NAME}.applescript`).setContent(content);
  return ops;
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

/** Converts an op into an AppleScript record with a fixed set of fields (missing values get defaults). */
function toAppleScriptRecord(op) {
  // Keys are prefixed with "z" so they can't clash with terms from QLab's AppleScript dictionary.
  const v = {
    zKind: asString(op.op),
    zKey: asString(op.key),
    zNum: asString(op.number),
    zName: asString(op.name || ""),
    zFile: asString(op.file || ""),
    zStage: asString(op.stage || ""),
    zParent: asString(op.parent ?? ""),
    zTarget: asString(op.target ?? ""),
    zDur: op.duration ?? 0,
    zOpacity: op.opacity ?? 1,
    zStop: op.stop ? "true" : "false",
    zLoop: op.loop ? "true" : "false",
    zLayer: op.layer ?? 0,
    zPreWait: op.delay ?? 0,
    zContinue: asString(op.continueMode || ""),
  };
  return "{" + Object.entries(v).map(([k, x]) => `${k}:${x}`).join(", ") + "}";
}

const QLAB_SCRIPT_TEMPLATE = `-- Generated by the ZEST cue list sheet ("ZEST > Generate QLab script"). Do not edit by hand.
-- Show: %%SHOW%%
-- Run this on the QLab Mac with the show workspace open (open in Script Editor, press Run).
-- It deletes the cue list %%CUE_LIST%% and rebuilds it from the sheet, so it is safe to re-run.

property cueListName : %%CUE_LIST%%
property mediaFolder : %%MEDIA_FOLDER%% -- relative to the folder containing the workspace, or an absolute path

-- The keys (see generateQlab) and uniqueIDs of the cues created so far.
property cueKeys : {}
property cueIDs : {}

-- The uniqueID of the cue with the given key.
on idOfKey(k)
  considering case
    repeat with i from 1 to count of cueKeys
      if item i of cueKeys is k then return item i of cueIDs
    end repeat
  end considering
  error "no cue with the key " & k
end idOfKey

set ops to {}
%%OPS%%

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

    -- Replace the previously generated cue list.
    repeat with cl in (cue lists whose q name is cueListName)
      delete cue id (uniqueID of cl)
    end repeat
    make type "Cue List"
    set theList to last cue list
    set q name of theList to cueListName
    set current cue list to theList

    set cueKeys to {}
    set cueIDs to {}
    set problems to {}

    repeat with o in ops
      set k to zKind of o
      if k is "group" then
        make type "Group"
      else if k is "video" then
        make type "Video"
      else if k is "camera" then
        make type "Camera"
      else if k is "fade" then
        make type "Fade"
      else if k is "stop" then
        make type "Stop"
      else if k is "pause" then
        make type "Pause"
      else if k is "resume" then
        make type "Start"
      end if
      set c to last item of (selected as list)
      set q number of c to (zNum of o)
      set q name of c to (zName of o)
      set notes of c to "zest:" & (zKey of o)
      set end of cueKeys to (zKey of o)
      set end of cueIDs to (uniqueID of c)
      if q number of c is not (zNum of o) then
        set end of problems to "cue number " & (zNum of o) & " is already used elsewhere in the workspace"
      end if

      -- Starts the next cue when this one ends ("follow"), or right after it starts ("continue", after the next one's pre-wait).
      if (zContinue of o) is "follow" then set continue mode of c to auto_follow
      if (zContinue of o) is "continue" then set continue mode of c to auto_continue

      if k is "group" then
        set pre wait of c to (zPreWait of o)
      else
        if k is "video" or k is "camera" then
          if k is "video" then
            set f to mediaPath & "/" & (zFile of o)
            try
              tell current application to do shell script "test -e " & quoted form of f
              set file target of c to POSIX file f
            on error
              set end of problems to "cue " & (zNum of o) & ": missing file " & f
            end try
          end if
          try
            set stage name of c to (zStage of o)
          on error
            set end of problems to "cue " & (zNum of o) & ": no stage named " & (zStage of o)
          end try
          set opacity of c to (zOpacity of o)
          if zLoop of o then set infinite loop of c to true
          if (zLayer of o) is not 0 then set layer of c to (zLayer of o)
        else
          set cue target of c to cue id (my idOfKey(zTarget of o))
          if k is "fade" then
            set duration of c to (zDur of o)
            set do opacity of c to true
            set opacity of c to (zOpacity of o)
            set stop target when done of c to (zStop of o)
          end if
        end if
      end if

      -- Into its group, or the top level of the cue list.
      if (zParent of o) is "" then
        move cue id (uniqueID of c) of parent of c to end of theList
      else
        move cue id (uniqueID of c) of parent of c to end of cue id (my idOfKey(zParent of o))
      end if
    end repeat

    if problems is {} then
      display dialog "QLab cue list \\"" & cueListName & "\\" generated (" & (count of ops) & " cues)." buttons {"OK"} default button 1
    else
      set AppleScript's text item delimiters to return
      display dialog "Generated with " & (count of problems) & " problem(s):" & return & return & (problems as text) buttons {"OK"} default button 1 with icon caution
    end if
  end tell
end tell
`;
