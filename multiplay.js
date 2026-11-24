/**
 * What a cue does when it is triggered, i.e. the `Advance` of its MultiPlay cue (`$Action`). A cue can start only one
 * successor, so MultiPlay chains cues: each cue starts the next one in the list.
 */
const MULTIPLAY_ADVANCE = {
  MANUAL: 1,  // wait for the operator's GO
  WITH: 2,    // start the next cue together with this one (after this cue's pre-wait)
  ON_END: 4,  // start the next cue when this one ends (follow-on-end)
};

// Colours (RRGGBB) of the cues in MultiPlay's cue list: the cue the operator starts with GO (the first line of a `go`
// row, the head of a block) stands out from all others, which start by themselves. R and B are equal so that the colours look the same in either byte order.
const MULTIPLAY_GO_APPEARANCE = { $BGColour: "006000", $FontColour: "FFFFFF" };
const MULTIPLAY_AUTO_APPEARANCE = { $BGColour: "202020", $FontColour: "FFFFFF" };

/**
 * Generates a MultiPlay production XML file (`<SHOW_NAME>.mpp`) containing all audio, lighting, and video cues.
 *
 * Constructs MultiPlay cue objects (audio files, telnet commands for lights, OSC messages for video),
 * formats their advance triggers, audio channels, and patch assignments, and saves the output to Drive.
 *
 * Each sheet row becomes one or multiple lines (LX, SX, VX, ...), chained to start together. How a row starts depends on its
 * trigger (see schedule.js):
 * - `go`: the first line is a manual cue the operator triggers. Rows of the same block follow in the same chain.
 * - `continue +N`: its lines are chained after the head's, with a pre-wait so that they start N s after the head's GO.
 *   A pre-wait counts from the start of the previous cue of the chain, so the chain stores the differences between
 *   the offsets of consecutive rows (offsets of a block must not decrease).
 * - `follow #sound +N`: its lines are chained right after the labeled sound, whose advance is follow-on-end, with a
 *   pre-wait of N s. A cue starts one successor only, so the labeled sound has to be the last cue of its chain.
 */
function generateMultiplay(cues) {
  cues = cues ?? parseCuelist();
  if (cues == null) return; // parse errors already reported
  if (cues.length === 0) {
    // Nothing to generate (empty sheet). Bail out so existing output is not overwritten / wiped.
    console.warn("[multiplay] no cues, nothing to do");
    return;
  }

  const ctx = new Context("multiplay");

  // Keeps track of labels assigned to sound cues that may then be referenced by sound control cues (e.g. !stop, !fade-out).
  const soundLabels = new Map();

  // 1. The lines of each row that MultiPlay schedules.
  const rowLines = new Map();
  for (const cue of cues) {
    ctx.at(cue);
    const lines = buildMultiplayLines(cue, soundLabels, ctx);
    ctx.check(lines.length > 0, "cue has no action");
    rowLines.set(cue, lines);
  }

  // 2. The cue list: one chain per block (head and continue rows), followed by the chains of the rows that follow a
  // sound of the block, each right after that sound.
  const list = [];
  const layoutChain = rows => {
    rows = rows.filter(row => rowLines.get(row)?.length > 0);
    let previousOffset = 0;
    for (const [i, row] of rows.entries()) {
      const lines = rowLines.get(row);
      const delay = row.trigger.offset - previousOffset;
      previousOffset = row.trigger.offset;
      lines[0].isFirst = true;
      lines[0].preWait = delay;
      for (const [k, line] of lines.entries()) {
        const isLast = i === rows.length - 1 && k === lines.length - 1;
        line.advance = isLast ? MULTIPLAY_ADVANCE.MANUAL : MULTIPLAY_ADVANCE.WITH;
        list.push(line);
      }
    }

    for (const [i, row] of rows.entries()) {
      const followers = row.followers.filter(f => rowLines.has(f));
      if (followers.length === 0) {
        continue;
      }
      if (i < rows.length - 1) {
        for (const follower of followers) {
          ctx.at(follower).err(`follow #${follower.anchor.label}: the sound is in row ${row.row}, but row ${rows[i + 1].row} starts after it in the same chain. `
            + `MultiPlay can only follow the end of the last cue of a chain: move the row with the sound to the end of the block, or use continue +Ns`);
        }
        continue;
      }
      // The sound is the last line of its row (see buildMultiplayLines), so it is the last cue of the chain.
      rowLines.get(row).at(-1).advance = MULTIPLAY_ADVANCE.ON_END;
      layoutChain([...followers].sort((a, b) => a.trigger.offset - b.trigger.offset));
    }
  };
  for (const cue of cues.filter(c => c.trigger.kind === "go")) {
    layoutChain(cue.block.rows.filter(row => row.trigger.kind !== "follow"));
  }
  ctx.at();

  ctx.report("output not updated");
  if (ctx.hasErrors()) {
    // Do not overwrite the existing file with an incomplete / broken one.
    return;
  }

  // 3. Serialize.
  list.forEach((line, i) => line.uid = i + 1);
  const multiplayCues = list.map(line => {
    const cue = line.row;
    const xml = { ...line.xml };
    const isGo = cue.trigger.kind === "go";
    if (xml.Control && typeof xml.Control.$Target === "object") {
      xml.Control = { ...xml.Control, $Target: xml.Control.$Target.uid };
    }
    if (line.preWait > 0) {
      xml.Wait = { ...xml.Wait, $Pre: Math.round(line.preWait * 1000) };
    }
    return {...xml, ...{
      UID: line.uid,
      // The first line of a row is the primary cue that displays a cue number, page number, description, etc. The other
      // lines are separate cues in MultiPlay that start together with it.
      Q: line.isFirst ? `${isGo ? "" : "[AUTO] "}${cue.cue}\tp${cue.pg || "??"}\t${cue.scene || ""}\t    ${cue.line || ""}` : "",
      ScriptRef: line.isFirst ? cue.description : "",
      Description: line.abbr + (line.descr ? ` - ${line.descr}` : ""),
      Advance: { $Action: line.advance, $Target: 0 },
      Appearance: isGo && line.isFirst ? MULTIPLAY_GO_APPEARANCE : MULTIPLAY_AUTO_APPEARANCE,
    }};
  });

  const cueList = XmlService.createElement("CueList");
  toXml("Cue", multiplayCues).forEach(x => cueList.addContent(x));
  multiplay.getRootElement().addContent(cueList);
  let content = XmlService.getPrettyFormat().format(multiplay);
  getOrCreateFile(`${SHOW_NAME}.mpp`).setContent(content);
}

/**
 * Builds the MultiPlay lines of one row: LX (grandMA cue), SX (sound file and sound control actions) and VX (QLab
 * group), in that order. A sound that other rows follow goes last, so that it can be the last cue of its chain.
 *
 * A line is `{ row, abbr, descr, xml }`: `xml` is the cue's content, the rest (UID, number, advance, pre-wait) is
 * added once the cue list is laid out.
 */
function buildMultiplayLines(cue, soundLabels, ctx) {
  const lines = [];
  const addLine = (abbr, descr, xml) => {
    const line = { row: cue, abbr, descr, xml };
    lines.push(line);
    return line;
  };

  // Lighting cues. The placeholders only apply to the rows the operator triggers.
  const isGo = cue.trigger.kind === "go";
  if (cue.tracks.lights || (isGo && MULTIPLAY_OUTPUT_LX_PLACEHOLDER_CUES)) {
    // Trigger a grandMA2 cue via telnet.
    addLine("LX", cue.tracks.lights ? cue.tracks.lights.description : "<placeholder>", {
      Type: 13,
      Patch: MULTIPLAY_LX_NETWORK_PATCH,
      Messages: {
        $Interval: 10,
        Msg: [{
          $Data: "login administrator admin",
          $Format: 0,
          $AddCR: -1,
          $AddLF: -1,
        },
        {
          $Data: `goto cue ${cue.cue.slice(1)}`,
          $Format: 0,
          $AddCR: -1,
          $AddLF: -1,
        }],
      },
    });
  }

  // Sound cues
  let anchorLine = null;
  if (cue.tracks.sound) {
    // Generates an audio cue iff a sound file is linked in the file column.
    // In addition, generates a control cue for each control action in the params column (see parseParams for details).
    const {label, params, actions} = parseParams(cue.tracks.sound.params, soundLabels, ctx);
    const file = cue.tracks.sound.file;
    const hasFile = file != null;
    const hasLabel = label != null;
    const hasParams = Object.keys(params).length > 0;

    // The file has to be a link (smart chip), as opposed to plain text.
    const hasValidFile = hasFile && ctx.check(file.name != null, `sound file "${file}" is not a link to a file`);

    // The params need an audio cue / file to apply to.
    ctx.check(hasFile || !hasParams, "sound has params, but no file");
    // The label needs an audio cue / file to apply to.
    ctx.check(hasFile || !hasLabel, `sound has label #${label}, but no file`);
    if (!hasFile && !hasParams && !hasLabel && actions.length === 0) {
      ctx.warn("sound has neither file nor actions, and does nothing");
    }

    const duplicateLabel = hasLabel && !ctx.check(!soundLabels.has(label), `duplicate label #${label}`);

    if (hasValidFile) {
      const line = addLine("SX", cue.tracks.sound.description, {...{
        Type: 0,
        File: {
          $Name: `${LOCAL_FOLDER}\\sound\\${file.name}`,
        },
        AudioChannel: MULTIPLAY_SX_AUDIO_PATCH,
      }, ...params});
      if (hasLabel && !duplicateLabel) {
        soundLabels.set(label, line);
      }
      if (cue.followers.length > 0) {
        anchorLine = line;
      }
    }

    for (const action of actions) {
      addLine("SX", cue.tracks.sound.description, action);
    }
  }

  // Video cues
  // A QLab group exists iff the row has video (see generateQlab). Triggers it by the same name / ID via OSC. The target
  // IP / port can be set in the MultiPlay XML template.
  const triggersQlab = hasVideo(cue);
  if (triggersQlab || (isGo && MULTIPLAY_OUTPUT_VX_PLACEHOLDER_CUES)) {
    addLine("VX", triggersQlab ? cue.tracks.video?.description : "<placeholder>", {
      Type: 13,
      Patch: MULTIPLAY_VX_NETWORK_PATCH,
      Messages: [{
        Msg: {
          $Data: `/cue/${cue.cue}/start`,
          $Format: 0,
          $AddCR: -1,
          $AddLF: -1,
        },
      }],
    });
  }

  if (anchorLine != null) {
    lines.splice(lines.indexOf(anchorLine), 1);
    lines.push(anchorLine);
  }
  return lines;
}

/**
 * Parses line-delimited sound parameter specifications into cue attributes and control actions.
 *
 * Labels uniquely name the current cue and have the format `#<label_name>`. They can be used to target the current cue from control actions.
 *
 * Parameters affect the current cue and start with a '$' prefix:
 * - `$loop [count]`: Loop count setting.
 * - `$fade-in-dur <sec>`: Fade in duration in seconds.
 * - `$fade-out-dur <sec>`: Fade out duration in seconds.
 * - `$volume <dB>`: Volume level in dB.
 * - `$start-pos <sec>`: File start position in seconds.
 * - `$stop-pos <sec>`: File stop position in seconds.
 *
 * Control actions target another cue:
 * - `!stop <target_label>`: Stop control cue targeting labeled cue.
 * - `!pause <target_label>`: Pause control cue targeting labeled cue.
 * - `!resume <target_label>`: Resume control cue targeting labeled cue.
 * - `!fade-out <target_label>`: Fade out control cue targeting labeled cue.
 * - `!inc-volume <target_label> +<dB>dB <fade_sec>`: Relative volume change control cue.
 *
 * Problems are reported to the given context, and the offending line is skipped.
 */
function parseParams(input, labels, ctx) {
  let label = null;
  const actions = [];
  const params = {};

  for (const line of input?.split("\n") || []) {
    const parts = line.split(" ");
    const name = parts[0];
    const args = parts.slice(1);

    // Reports an error if the number of arguments of the current line is not in the range [min, max].
    const checkArgs = (min, max = min) => ctx.check(
      args.length >= min && args.length <= max,
      `${name} expects ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`);

    if (name.startsWith("#")) {
      if (!ctx.check(args.length === 0, `label ${name} must not have arguments`)) continue;
      if (!ctx.check(label == null, `more than one label (#${label} and ${name})`)) continue;
      label = name.slice(1);
      continue;
    }

    switch (name) {
      case "$loop":
        if (!checkArgs(0, 1)) break;
        params.Loops = args[0] || 0;
        break;

      case "$fade-in-dur":
        if (!checkArgs(1)) break;
        params.Fade = params.Fade || {};
        params.Fade.$In = args[0] * 1000;
        break;

      case "$fade-out-dur":
        if (!checkArgs(1)) break;
        params.Fade = params.Fade || {};
        params.Fade.$Out = args[0] * 1000;
        params.Fade.$AtEnd = -1;
        break;

      case "$volume":
        if (!checkArgs(1)) break;
        params["Volume-dB"] = args[0];
        break;

      case "$start-pos":
        if (!checkArgs(1)) break;
        params.File = params.File || {};
        params.File.$StartPos = args[0] * 1000;
        break;

      case "$stop-pos":
        if (!checkArgs(1)) break;
        params.File = params.File || {};
        params.File.$StopPos = args[0] * 1000;
        break;

      case "!stop":
      case "!pause":
      case "!resume":
      case "!fade-out":
        const action = { "!stop": 1,"!pause": 2,"!resume": 3,"!fade-out": 13 }[name];
        assert(action != null);

        if (!checkArgs(1)) break;
        const target = labels.get(args[0]);
        if (!ctx.check(target != null, `${name} refers to unknown label "${args[0]}"`)) break;

        actions.push({
          Type: 5,
          Control: { $Action: action, $Target: target },
        });
        break;

      case "!inc-volume":
        if (!checkArgs(3)) break;
        const volTarget = labels.get(args[0]);
        if (!ctx.check(volTarget != null, `${name} refers to unknown label "${args[0]}"`)) break;
        const change = args[1].match(/\+(\d+)dB/)?.[1];
        if (!ctx.check(change, `${name} expects a volume change like +3dB, got "${args[1]}"`)) break;
        actions.push({
          Type: 5,
          Control: { $Action: 4, $Target: volTarget, $EndValue: change, $FadeTime: args[2] * 1000, $RelativeFade: -1},
        });
        break;

      default:
        ctx.err(`invalid param "${name}"`);
    }
  }

  return {label, params, actions};
}

/**
 * Base MultiPlay production XML template containing audio, network patches.
 */
const multiplay = XmlService.parse(`<?xml version="1.0" encoding="UTF-8"?>
<Production>
  <Version>3.0.240.0</Version>
  <MidiControl Device="0" Active="-1"/>
  <Appearance>
    <CueList Name="Arial" Size="10" Colour="FFFFFF" BgColour="000000" CueSelectedBgColour="800080" CueSelectedFontColour="FFFFFF" CueDisabledBgColour="808080" CueDisabledFontColour="FFFFFF" CueColourStyle="2" CueListScrollBars="-1">
    </CueList>
    <HotButtons Name="Arial" Size="12"/>
    <ProgressBar ColourPlaying="008000" ColourPaused="0000FF" ColourWarning="FF0000" ColourInterval="808080" ColourLooping="008000" MaxWhenLooping="-1" ProgressFullHeight="-1"/>
    <NotesHeader Name="Arial" Size="12" BgColour="000000" Colour="FF0000"/>
    <NotesBody Name="Arial" Size="10" Colour="000000" BgColour="FFFBF0"/>
    <Common Name="Arial" Size="10" Colour="FFFFFF" BgColour="000000" SelectedFontColour="FFFFFF" SelectedBgColour="800080"/>
    <SelectedCueWindow Colour="FFFFFF" BgColour="000000"/>
    <Buttons StopwatchFontColour="FFFFFF" StopwatchBgColour="000000" ClockFontColour="FFFFFF" ClockBgColour="000000" StopAllFontColour="FFFF00" StopAllBgColour="000000" FadeAllFontColour="00FFFF" FadeAllBgColour="000000" AdvanceFontColour="FF8000" AdvanceBgColour="000000" CountDownTimerFontColourNormal="FFFFFF" CountDownTimerBgColourNormal="008000" CountDownTimerFontColourWarning="FF0000" CountDownTimerBgColourWarning="000000"/>
    <HideFractionalSeconds>0</HideFractionalSeconds>
  </Appearance>
  <Audio PreviewDeviceName="Default" PreviewDeviceChans="1">
    <Patch Name="WING 1/2" DeviceName="OUT 1-2 (BEHRINGER WING-USB)" DeviceChans="1"/>
    <Patch Name="WING 3/4" DeviceName="OUT 3-4 (BEHRINGER WING-USB)" DeviceChans="1"/>
    <Patch Name="PC" DeviceName="Speakers (Focusrite USB Audio)" DeviceChans="1"/>
  </Audio>
  <MIDI/>
  <Network>
    <Patch Name="grandMA2" Destination="192.168.0.147" Adapter="" Port="30000" Encoding="2" Enabled="-1"/>
    <Patch Name="QLab" Destination="192.168.0.97" Adapter="" Port="53000" Encoding="1" Enabled="-1"/>
  </Network>
  <Video/>
</Production>`);
