/**
 * Cue triggers: how every active row of the sheet starts.
 *
 *   trigger := skip | go | continue [+<N>s] | follow #<label> [+<N>s]
 *
 * The sheet is the single source of truth: every active row has its own unique id and produces at most one command per
 * program (MultiPlay for sound / lights, QLab for video). A `go` row (the head) plus the non-`go` rows below it, up to
 * the next `go`, form a block. `continue` counts from the head's GO, never from the previous row. `follow` counts from
 * the end of the labeled media of an earlier row of the block.
 *
 * `resolveSchedule` runs once after parsing and annotates every active row, so that the MultiPlay and QLab generators
 * only have to read the result:
 *   cue.trigger    { kind: "go" | "continue" | "follow", offset (seconds, 0 for go), label (follow only) }
 *   cue.head       the head row of the row's block (the row itself for `go`)
 *   cue.block      { head, rows } with all rows of the block, in sheet order
 *   cue.anchor     follow only: { cue, kind: "sound" | "video", label, screen } (the row and media that is followed)
 *   cue.followers  the follow rows that wait for this row's media
 *   cue.scheduler  who delays the row's start: "multiplay" (everything except a follow of video, which QLab schedules)
 *   cue.cue        the row's id (unique)
 */

/**
 * Parses the text of a Trigger cell into `{ kind, offset, label }`. Invalid text (including an empty cell) is reported
 * to `ctx` (which should point at the row) and parsed as `skip`, so the result is always a valid trigger.
 */
function parseTrigger(text, ctx) {
  const raw = String(text ?? "").trim();
  const seconds = "(\\d+(?:\\.\\d+)?)";
  let m;

  if (/^go$/i.test(raw)) {
    return { kind: "go", offset: 0, label: null };
  }
  if (/^skip$/i.test(raw)) {
    return { kind: "skip", offset: 0, label: null };
  }
  if (/^go\s/i.test(raw)) {
    ctx.err(`invalid trigger "${raw}": go has no delay (use continue +Ns to start a row N seconds after the head)`);
    return { kind: "skip", offset: 0, label: null };
  }
  if ((m = raw.match(new RegExp(`^continue(?:\\s*\\+${seconds}s?)?$`, "i")))) {
    return { kind: "continue", offset: Number(m[1] ?? 0), label: null };
  }
  if ((m = raw.match(new RegExp(`^follow\\s+#(\\S+?)(?:\\s+\\+${seconds}s?)?$`, "i")))) {
    return { kind: "follow", offset: Number(m[2] ?? 0), label: m[1] };
  }
  ctx.err(`invalid trigger "${raw}" (expected skip, go, continue [+Ns] or follow #label [+Ns])`);
  return { kind: "skip", offset: 0, label: null };
}

/**
 * Resolves blocks, anchors, schedulers and followers of all active rows (see the file comment) and validates them.
 * Problems are reported to `ctx` with the row they are about.
 */
function resolveSchedule(cues, ctx) {
  // 1. Blocks: a go row plus the non-go rows below it.
  const blocks = [];
  let block = null;
  let reportedNoHead = false;
  for (const cue of cues) {
    cue.followers = [];
    cue.anchor = null;
    cue.scheduler = "multiplay";
    if (cue.trigger.kind === "go") {
      block = { head: cue, rows: [] };
      blocks.push(block);
    } else if (block == null) {
      if (!reportedNoHead) {
        ctx.at(cue).err("the first active row must have the trigger go");
        reportedNoHead = true;
      }
      continue;
    }
    cue.head = block.head;
    cue.block = block;
    block.rows.push(cue);
  }

  // 2. Per block: continue offsets and followers.
  for (const { rows } of blocks) {
    let lastContinue = 0;
    for (const [i, row] of rows.entries()) {
      ctx.at(row);
      if (row.trigger.kind === "continue") {
        ctx.check(row.trigger.offset >= lastContinue,
          `continue +${row.trigger.offset}s starts before the previous continue row of the block (+${lastContinue}s): offsets must not decrease`);
        lastContinue = Math.max(lastContinue, row.trigger.offset);
      } else if (row.trigger.kind === "follow") {
        resolveFollow(rows, i, ctx);
      }
    }
  }
  ctx.at();
  return blocks;
}

/** Finds the media row `i` follows, validates the follow, and links the row to its anchor. */
function resolveFollow(rows, i, ctx) {
  const row = rows[i];
  const label = row.trigger.label;
  const prefix = `follow #${label}:`;

  // The label must be defined in an earlier row of the same block (not the follower's own row).
  const defs = [];
  for (let j = 0; j < i; j++) {
    const scan = scanMedia(rows[j]);
    if (scan.sound?.label === label && scan.sound.hasFile) {
      defs.push({ index: j, kind: "sound", media: scan.sound, screen: null });
    }
    for (const video of scan.video) {
      if (video.label === label && video.hasFile) {
        defs.push({ index: j, kind: "video", media: video, screen: video.screen });
      }
    }
  }
  if (defs.length === 0) {
    ctx.err(`${prefix} no media with this label in an earlier row of the same block`);
    return;
  }
  if (defs.length > 1) {
    ctx.err(`${prefix} ambiguous, the label is used ${defs.length} times in the block (rows ${defs.map(d => rows[d.index].row).join(", ")})`);
    return;
  }
  const def = defs[0];
  const anchorRow = rows[def.index];
  row.anchor = { cue: anchorRow, kind: def.kind, label, screen: def.screen };
  row.scheduler = def.kind === "video" ? "qlab" : "multiplay";
  anchorRow.followers.push(row);

  // 2. The labeled media has to end: images, loops and the camera never do.
  ctx.check(!def.media.endless, `${prefix} the ${def.kind} in row ${anchorRow.row} never ends (${def.kind === "sound" ? "$loop" : "image, $loop or @camera"}), use continue +Ns instead`);

  // 3. QLab schedules the followers of video, and MultiPlay (sound, lights) can't wait for it.
  if (def.kind === "video") {
    ctx.check(hasVideo(row), `${prefix} a follower of video has no video`);
    ctx.check(!hasSound(row) && row.tracks.lights == null, `${prefix} a follower of video can only have video (QLab starts it, sound and lights can't wait for it), use continue +Ns instead`);
  }

  // 4. Nothing between the labeled media and the follower may change what is on the follower's screens, or stop,
  // pause or fade the labeled media: the follower is generated for the state of the screens at its own row.
  const followerScreens = scanMedia(row).video.map(v => v.screen);
  for (let k = def.index + 1; k < i; k++) {
    const between = rows[k];
    const scan = scanMedia(between);
    const where = `row ${between.row} (cue ${between.cue})`;
    for (const screen of scan.video.map(v => v.screen).filter(s => followerScreens.includes(s))) {
      ctx.err(`${prefix} ${where} touches the screen "${QLAB_SCREENS[screen].label}" of the follower`);
    }
    if (def.kind === "sound" && scan.sound?.actions.includes(label)) {
      ctx.err(`${prefix} ${where} stops, pauses or fades the labeled sound`);
    }
    if (def.kind === "video") {
      if (scan.video.some(v => v.screen === def.screen)) {
        ctx.err(`${prefix} ${where} touches the screen "${QLAB_SCREENS[def.screen].label}" of the labeled video`);
      } else if (scan.video.some(v => v.targets.includes(label))) {
        ctx.err(`${prefix} ${where} stops, pauses or fades the labeled video`);
      }
    }
  }
}

/**
 * What a row's media defines and touches, for the checks above (cached on the row):
 *   sound: null | { label, hasFile, endless, actions: [target labels of !stop / !pause / !resume / !fade-out] }
 *   video: [{ screen, label, hasFile, endless, targets: [target labels of actions] }]  (screens with content only)
 * Syntax errors are not reported here: the generators report them with the row.
 */
function scanMedia(cue) {
  if (cue.scan) {
    return cue.scan;
  }
  const scan = { sound: null, video: [] };

  const sound = cue.tracks.sound;
  if (sound != null) {
    scan.sound = { label: null, hasFile: sound.file != null, endless: false, actions: [] };
    for (const line of String(sound.params ?? "").split("\n")) {
      const [name, ...args] = line.trim().split(/\s+/);
      if (name.startsWith("#")) {
        scan.sound.label = name.slice(1);
      } else if (name === "$loop") {
        // Without a count the sound loops forever.
        scan.sound.endless = !(Number(args[0]) > 0);
      } else if (["!stop", "!pause", "!resume", "!fade-out"].includes(name) && args[0] != null) {
        scan.sound.actions.push(args[0].replace(/^#/, ""));
      }
    }
  }

  for (const screen of Object.keys(QLAB_SCREENS).filter(s => hasVideo(cue, s))) {
    const track = cue.tracks[screen];
    const fileName = track.file == null ? null : String(track.file.name ?? track.file).trim();
    let params = null;
    try {
      params = parseVideoParams(track.params, "");
    } catch (e) {
      // reported by generateQlab
    }
    scan.video.push({
      screen,
      label: params?.label ?? null,
      hasFile: !!fileName,
      endless: !!fileName && (fileName.toLowerCase() === "@camera" || !!params?.loop || IMAGE_EXTENSIONS.test(fileName)),
      targets: (params?.actions ?? []).map(a => a.target).filter(t => t != null),
    });
  }

  cue.scan = scan;
  return scan;
}
