/**
 * Generates an AppleScript (`<SHOW_NAME>.applescript`) that builds the QLab video cue list.
 *
 * Writing a QLab workspace file directly is not feasible (it is an undocumented, nested binary plist with macOS
 * file bookmarks inside). Instead, the generated script is run on the QLab Mac with the show workspace open. It
 * deletes the previously generated cue list (named QLAB_CUE_LIST_NAME) and recreates it from scratch, so it can be
 * re-run whenever the sheet changes.
 *
 * Every sheet row with video content becomes a group cue numbered like the sheet cue (e.g. `4`), which is what
 * MultiPlay triggers via OSC `/cue/4/start`. The group fires all its children at once:
 *   4-1  video / image / camera cue (starts at opacity 0 when it fades in)
 *   4-2  fade cue: opacity 0 -> 1 over the fade duration
 *   4-3  fade cue: fades out and stops whatever was showing on that screen before
 *
 * Rows without a cue number (or `-` / `n/a`, see isAutoCue) become groups `auto-1`, `auto-2`, … that QLab starts by
 * itself: when the previous group ends (auto-follow), or `$delay` seconds after it starts (auto-continue).
 *
 * Each screen (stage) has its own pair of columns, configured in QLAB_SCREENS:
 *   `<screen>\nfile`    file name or Drive smart chip, or `@camera` for a live camera cue
 *   `<screen>\nparams`  one parameter / action per line (see parseVideoParams)
 */
function generateQlab(cues) {
  cues = cues ?? parseCuelist();

  const ops = [];                // flat list of cue-creation operations, consumed by the AppleScript runtime
  const state = {
    labels: new Map(),           // #label -> media index
    media: [],                   // media index -> { name, screen }
    onScreen: {},                // screen track -> array of media indices currently visible
    paused: new Set(),           // media indices that are paused (and still visible)
  };
  for (const screen in QLAB_SCREENS) {
    state.onScreen[screen] = [];
  }
  let autoCount = 0;

  for (const { cue: triggered, autos } of groupAutoCues(cues)) {
    const autosWithVideo = autos.filter(row => hasVideo(row));
    if (!hasVideo(triggered) && autosWithVideo.length === 0) {
      continue;
    }
    const triggeredNumber = String(triggered.cue).trim();
    // The number goes into the OSC address /cue/<number>/start, so no spaces, slashes or wildcard characters.
    assert(/^[A-Za-z0-9_.]+$/.test(triggeredNumber), `cue "${triggered.cue}" has video, but its cue number can't be triggered via OSC (use letters, digits, "." and "_")`);

    // The triggered group (empty when only its auto-cues have video), then one group per auto-cue.
    let previous = null;
    for (const row of [triggered, ...autosWithVideo]) {
      const isAuto = row !== triggered;
      const number = isAuto ? `auto-${++autoCount}` : triggeredNumber;
      const where = isAuto ? `${number} (after cue ${triggeredNumber})` : `cue ${number}`;
      const built = buildVideoCue(row, where, state);
      const { children, endless } = built;
      let delay = built.delay;

      if (isAuto) {
        // Waiting for images, loops or the camera to end would wait forever: start after a default delay instead.
        if (delay == null && previous.endless.length > 0) {
          delay = QLAB_DEFAULT_AUTO_DELAY;
        }
        previous.group.continueMode = delay != null
          ? "continue"   // starts $delay seconds after the previous group starts
          : "follow";    // starts when the previous group ends
      }
      const group = { op: "group", number, name: row.tracks.video?.description || row.description || "", delay: delay ?? 0, continueMode: "" };
      ops.push(group);
      children.forEach((child, i) => ops.push({ ...child, number: `${number}-${i + 1}` }));
      previous = { group, endless };
    }
  }

  const fill = {
    "%%SHOW%%": asString(SHOW_NAME),
    "%%CUE_LIST%%": asString(QLAB_CUE_LIST_NAME),
    "%%MEDIA_FOLDER%%": asString(QLAB_MEDIA_FOLDER),
    "%%MEDIA_COUNT%%": String(state.media.length),
    "%%OPS%%": chunk(ops.map(toAppleScriptRecord), 50)
      .map(part => "set ops to ops & {" + part.join(", ¬\n    ") + "}").join("\n"),
  };
  let content = QLAB_SCRIPT_TEMPLATE;
  for (const [key, value] of Object.entries(fill)) {
    content = content.split(key).join(value);
  }
  getOrCreateFile(`${SHOW_NAME}.applescript`).setContent(content);
  return ops;
}

/**
 * Builds the children of one row's group, and updates what is on each screen.
 * Returns the row's $delay (or null) and the names of new media that never end on their own (images, loops, camera).
 */
function buildVideoCue(row, where, { labels, media, onScreen, paused }) {
  const children = [];
  const endless = [];
  let delay = null;

  for (const screen of Object.keys(QLAB_SCREENS).filter(s => hasVideo(row, s))) {
    const { stage, label: screenLabel } = QLAB_SCREENS[screen];
    const file = row.tracks[screen].file;
    const fileName = file == null ? null : (file.name ?? file).trim();
    const p = parseVideoParams(row.tracks[screen].params, `${where} / ${screenLabel}`);

    if (p.delay != null) {
      assert(delay == null || delay === p.delay, `${where}: conflicting $delay values across screens`);
      delay = p.delay;
    }
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
          children.push({ op: "pause", name: `${screenLabel}: pause ${media[t].name}`, target: t });
          paused.add(t);
        } else if (isResume) {
          // A start cue resumes a paused cue in QLab.
          children.push({ op: "resume", name: `${screenLabel}: resume ${media[t].name}`, target: t });
          paused.delete(t);
        } else {
          children.push(action.type === "!stop"
            ? { op: "stop", name: `${screenLabel}: stop ${media[t].name}`, target: t }
            : { op: "fade", name: `${screenLabel}: fade out ${media[t].name}`, target: t, duration: action.duration, opacity: 0, stop: true });
          removeFromScreens(onScreen, t);
          paused.delete(t);
        }
      }
    }

    // 2. New media, crossfading out whatever it replaces (unless $keep).
    if (fileName) {
      const isCamera = fileName.toLowerCase() === "@camera";
      const idx = media.length;
      media.push({ name: isCamera ? "live camera" : fileName, screen });
      if (p.label != null) {
        assert(!labels.has(p.label), `${where}: duplicate label #${p.label}`);
        labels.set(p.label, idx);
      }
      if (isCamera || p.loop || IMAGE_EXTENSIONS.test(fileName)) {
        endless.push(media[idx].name);
      }

      const fade = p.fade ?? QLAB_DEFAULT_FADE;
      const replaced = p.keep ? [] : [...onScreen[screen]];
      children.push({
        op: isCamera ? "camera" : "video",
        name: `${screenLabel}: ${media[idx].name}`,
        file: isCamera ? "" : fileName,
        stage,
        media: idx,
        opacity: fade > 0 ? 0 : 1,
        loop: p.loop,
        layer: p.layer,
      });
      if (fade > 0) {
        children.push({ op: "fade", name: `${screenLabel}: fade in ${media[idx].name}`, target: idx, duration: fade, opacity: 1, stop: false });
      }
      for (const t of replaced) {
        children.push({ op: "fade", name: `${screenLabel}: fade out ${media[t].name}`, target: t, duration: fade, opacity: 0, stop: true });
        removeFromScreens(onScreen, t);
        paused.delete(t);
      }
      onScreen[screen].push(idx);
    }
  }
  return { children, delay, endless };
}

// Still images play until stopped in QLab, so a group showing one never ends.
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|tiff?|heic|psd|webp)$/i;

/** True if the row has a file or params in the given video screen column (any screen if omitted). */
function hasVideo(row, screen) {
  const screens = screen == null ? Object.keys(QLAB_SCREENS) : [screen];
  return screens.some(s => row.tracks[s]?.file != null || row.tracks[s]?.params != null);
}

/**
 * Groups the rows into the cues MultiPlay triggers, each with the auto-cue rows that follow it up to the next
 * triggered cue: [{ cue, autos: [...] }].
 */
function groupAutoCues(cues) {
  const groups = [];
  for (const cue of cues) {
    if (!isAutoCue(cue)) {
      groups.push({ cue, autos: [] });
    } else if (groups.length > 0) {
      groups[groups.length - 1].autos.push(cue);
    } else {
      assert(!hasVideo(cue), `row "${cue.description ?? ""}" has video, but no cue number and no earlier cue to follow`);
    }
  }
  return groups;
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
 * - `$delay <sec>`: pre-wait of the whole cue (the same for all screens).
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
  const result = { label: null, fade: null, delay: null, loop: false, keep: false, layer: null, actions: [], hasMediaParams: false };
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
      case "$delay":
        assert(args.length === 1, `${where}: usage $delay <sec>`);
        result.delay = num(args[0], name);
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
    zNum: asString(op.number),
    zName: asString(op.name || ""),
    zFile: asString(op.file || ""),
    zStage: asString(op.stage || ""),
    zMedia: (op.media ?? -1) + 1,      // AppleScript lists are 1-based; 0 = none
    zTarget: (op.target ?? -1) + 1,
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

    set mediaIDs to {}
    repeat %%MEDIA_COUNT%% times
      set end of mediaIDs to ""
    end repeat
    set problems to {}
    set currentGroup to missing value
    set previousChild to missing value

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
      if q number of c is not (zNum of o) then
        set end of problems to "cue number " & (zNum of o) & " is already used elsewhere in the workspace"
      end if

      if k is "group" then
        set pre wait of c to (zPreWait of o)
        -- Starts the next group (an auto-cue) when this one ends, or right after it starts (after the next one's pre-wait).
        if (zContinue of o) is "follow" then set continue mode of c to auto_follow
        if (zContinue of o) is "continue" then set continue mode of c to auto_continue
        move cue id (uniqueID of c) of parent of c to end of theList
        set currentGroup to c
        set previousChild to missing value
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
          set item (zMedia of o) of mediaIDs to (uniqueID of c)
        else
          set cue target of c to cue id (item (zTarget of o) of mediaIDs)
          if k is "fade" then
            set duration of c to (zDur of o)
            set do opacity of c to true
            set opacity of c to (zOpacity of o)
            set stop target when done of c to (zStop of o)
          end if
        end if
        move cue id (uniqueID of c) of parent of c to end of currentGroup
        -- Chain the group's children with auto-continue so they all fire together.
        if previousChild is not missing value then set continue mode of previousChild to auto_continue
        set previousChild to c
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
