/**
 * Cue triggers: how every active row of the sheet starts.
 *
 *   trigger := skip | go | continue [+<N>s] | follow [+<N>s]
 *
 * The sheet is the single source of truth: every active row has its own unique id and produces at most one command per
 * program (MultiPlay for sound / lights, QLab for video). A `go` row (the head) plus the non-`go` rows below it, up to
 * the next `go`, form a block. `follow` counts from the end of the sound in the active row directly above it. A `go` or
 * `follow` row starts a chain: `continue` counts from the start of the chain's head (the nearest `go` or `follow` row
 * above), never from the previous row.
 *
 * `resolveSchedule` runs once after parsing and annotates every active row, so that the MultiPlay and QLab generators
 * only have to read the result:
 *   cue.trigger      { kind: "go" | "continue" | "follow", offset (seconds, 0 for go) }
 *   cue.block        { head, rows } with all rows of the block, in sheet order
 *   cue.chain        { head, rows } with the head (go or follow) and the continue rows after it, in sheet order
 *   cue.chainOffset  seconds after the start of the chain that the row starts: the follow's own delay for the head of a
 *                    follow chain (the chain starts when the sound ends), the head's plus the continue offset otherwise
 *   cue.anchor       follow only: the row directly above, whose sound is followed
 *   cue.follower     the follow row that waits for this row's sound (null if none)
 *   cue.cue          the row's id (unique)
 */

/**
 * Parses the text of a Trigger cell into `{ kind, offset }`. Invalid text (including an empty cell) is reported to
 * `ctx` (which should point at the row) and parsed as `skip`, so the result is always a valid trigger.
 */
function parseTrigger(text, ctx) {
  const raw = String(text ?? "").trim();
  const seconds = "(\\d+(?:\\.\\d+)?)";
  let m;

  if (/^go$/i.test(raw)) {
    return { kind: "go", offset: 0 };
  }
  if (/^skip$/i.test(raw)) {
    return { kind: "skip", offset: 0 };
  }
  if (/^go\s/i.test(raw)) {
    ctx.err(`invalid trigger "${raw}": go has no delay (use continue +Ns to start a row N seconds after the head)`);
    return { kind: "skip", offset: 0 };
  }
  if ((m = raw.match(new RegExp(`^continue(?:\\s*\\+${seconds}s?)?$`, "i")))) {
    return { kind: "continue", offset: Number(m[1] ?? 0) };
  }
  if ((m = raw.match(new RegExp(`^follow(?:\\s*\\+${seconds}s?)?$`, "i")))) {
    return { kind: "follow", offset: Number(m[1] ?? 0) };
  }
  if (/^follow\s*#/i.test(raw)) {
    ctx.err(`invalid trigger "${raw}": follow has no label, it follows the sound in the row directly above (expected follow [+Ns])`);
    return { kind: "skip", offset: 0 };
  }
  ctx.err(`invalid trigger "${raw}" (expected skip, go, continue [+Ns] or follow [+Ns])`);
  return { kind: "skip", offset: 0 };
}

/**
 * Resolves blocks, chains, anchors and followers of all active rows (see the file comment) and validates them.
 * Problems are reported to `ctx` with the row they are about.
 */
function resolveSchedule(cues, ctx) {
  // 1. Blocks: a go row plus the non-go rows below it. Chains: a go or follow row plus the continue rows below it.
  const blocks = [];
  let block = null;
  let chain = null;
  let reportedNoHead = false;
  for (const cue of cues) {
    cue.follower = null;
    cue.anchor = null;
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
    if (cue.trigger.kind !== "continue") {
      chain = { head: cue, rows: [] };
    }
    cue.block = block;
    cue.chain = chain;
    cue.chainOffset = (cue.trigger.kind === "continue" ? chain.head.chainOffset : 0) + cue.trigger.offset;
    block.rows.push(cue);
    chain.rows.push(cue);
  }

  // 2. Per block: continue offsets and followers.
  for (const { rows } of blocks) {
    let lastContinue = 0;
    for (const [i, row] of rows.entries()) {
      ctx.at(row);
      if (row.trigger.kind === "continue") {
        ctx.check(row.trigger.offset >= lastContinue,
          `continue +${row.trigger.offset}s starts before the previous continue row of its chain (+${lastContinue}s): offsets must not decrease`);
        lastContinue = Math.max(lastContinue, row.trigger.offset);
      } else {
        lastContinue = 0;
        if (row.trigger.kind === "follow") {
          resolveFollow(row, rows[i - 1], ctx);
        }
      }
    }
  }
  ctx.at();
  return blocks;
}

/** Links the follow row to the row directly above, and checks that the sound of that row ends on its own. */
function resolveFollow(row, anchor, ctx) {
  row.anchor = anchor;
  anchor.follower = row;

  const sound = anchor.tracks.sound;
  if (!ctx.check(sound?.file != null, `follow: the row directly above (row ${anchor.row}, cue ${anchor.cue}) has no sound to follow, use continue +Ns instead`)) {
    return;
  }
  // A loop without a count never ends.
  for (const line of String(sound.params ?? "").split("\n")) {
    const [name, count] = line.trim().split(/\s+/);
    ctx.check(name !== "$loop" || Number(count) > 0, `follow: the sound in row ${anchor.row} (cue ${anchor.cue}) never ends ($loop), use continue +Ns instead`);
  }
}
