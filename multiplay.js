/**
 * Generates a MultiPlay production XML file (`<SHOW_NAME>.mpp`) containing all audio, lighting, and video cues.
 * 
 * Constructs MultiPlay cue objects (audio files, telnet commands for lights, OSC messages for video),
 * formats their advance triggers, audio channels, and patch assignments, and saves the output to Drive.
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

  let nextUid = 1;
  let multiplayCues = [];

  // Keeps track of labels assigned to sound cues that may then be referenced by sound control cues (e.g. !stop, !fade-out).
  const soundLabels = new Map();

  for (const cue of cues) {
    ctx.at(cue);

    // Adds a single cue. One input cue (i.e. a single row in the input sheet) may corespond to multiple MultiPlay cues (e.g.
    // when a lighting and sound change are triggered in the same cue). In this case the first cue is the primary cue that displays
    // a cue number, page numer, description, line / word / action etc. All other cues - while displayed as separate cues / lines in
    // MultiPlay - will trigger together with the primary cue.
    function addCue(abbr, descr, params) {
      if (!isPrimaryCue) {
        // Ensures that this cue triggers with the previous cue (see above for details).
        multiplayCues[multiplayCues.length - 1].Advance.$Action = 2;
      }
  
      multiplayCues.push({...params, ...{
          UID: nextUid++,
          Q: isPrimaryCue ? `${cue.cue}\tp${cue.pg || "??"}\t${cue.scene || ""}\t    ${cue.line || ""}` : "",
          ScriptRef: isPrimaryCue ? cue.description : "",
          Description: abbr + (descr ? ` - ${descr}` : ""),
          Advance: { $Action: 1, $Target: 0 },
          Appearance: { $BGColour: "202020", $FontColour: "FFFFFF" },
      }});
    
      isPrimaryCue = false;
    }

    let isPrimaryCue = true;

    // Lighting cues
    if (cue.tracks.lights || MULTIPLAY_OUTPUT_LX_PLACEHOLDER_CUES) {
      // Trigger a grandMA2 cue via telnet.
      addCue("LX", cue.tracks.lights ? cue.tracks.lights.description : "<placeholder>", {
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
            $Data: `goto cue ${cue.cue}`,
            $Format: 0,
            $AddCR: -1,
            $AddLF: -1,
          }],
        },
      });
    }

    // Sound cues
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

      if (hasLabel && ctx.check(!soundLabels.has(label), `duplicate label #${label}`)) {
        soundLabels.set(label, nextUid);
      }

      if (hasValidFile) {
        addCue("SX", cue.tracks.sound.description, {...{
          Type: 0,
          File: {
            $Name: `${LOCAL_FOLDER}\\sound\\${file.name}`,
          },
          AudioChannel: MULTIPLAY_SX_AUDIO_PATCH,
        }, ...params});
      }

      for (const action of actions) {
        addCue("SX", cue.tracks.sound.description, action);
      }
    }

    // Video cues
    if (cue.tracks.video || MULTIPLAY_OUTPUT_VX_PLACEHOLDER_CUES) {
      // Triggers a QLab cue by the same name / ID via OSC. The target IP / port can be set in the MultiPlay XML template.
      addCue("VX", cue.tracks.video ? cue.tracks.video.description : "<placeholder>", {
        Type: 13,
        Patch: MULTIPLAY_VX_NETWORK_PATCH,
        Messages: [{
          Msg: {
            $Data: `/cue/${cue.cue}/start`,
            $Format: 0,
            $AddCR: 0,
            $AddLF: 0,
          },
        }],
      });
    }

    ctx.check(!isPrimaryCue, "cue has no action");
  }
  ctx.at();

  ctx.report("output not updated");
  if (ctx.hasErrors()) {
    // Do not overwrite the existing file with an incomplete / broken one.
    return;
  }

  const cueList = XmlService.createElement("CueList");
  toXml("Cue", multiplayCues).forEach(x => cueList.addContent(x));
  multiplay.getRootElement().addContent(cueList);
  let content = XmlService.getPrettyFormat().format(multiplay);
  getOrCreateFile(`${SHOW_NAME}.mpp`).setContent(content);
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
 * - `$delay <sec>`: Pre-wait delay in seconds.
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

      case "$delay":
        if (!checkArgs(1)) break;
        params.Wait = params.Wait || {};
        params.Wait.$Pre = args[0] * 1000;
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
    <Patch Name="grandMA2" Destination="127.0.0.1" Adapter="Local Host" Port="30000" Encoding="2" Enabled="-1"/>
    <Patch Name="QLab" Destination="192.168.0.80" Adapter="{552E5721-8042-4E9E-ADE6-FB41CBDA4E0A}" Port="53000" Encoding="1" Enabled="-1"/>
  </Network>
  <Video/>
</Production>`);
