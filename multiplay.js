/**
 * Generates a MultiPlay production XML file (`<SHOW_NAME>.mpp`) containing all audio, lighting, and video cues.
 * 
 * Constructs MultiPlay cue objects (audio files, MIDI trigger commands for lights, OSC messages for video),
 * formats their advance triggers, audio channels, and patch assignments, and saves the output to Drive.
 */
function generateMultiplay(cues) {
  cues = cues ?? parseCuelist();

  let nextUid = 1;
  let multiplayCues = [];

  // Keeps track of labels assigned to sound cues that may then be referenced by sound control cues (e.g. !stop, !fade-out).
  const soundLabels = new Map();

  for (const [idx, cue] of cues.entries()) {

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
          Q: isPrimaryCue ? cue.cue : "",
          Description: `${abbr}   ` + (isPrimaryCue ? cue.description : descr || ""),
          ScriptRef: isPrimaryCue ? `p${cue.pg || "??"} - ${cue.scene || ""} - ${cue.line || ""}` : "",
          Advance: { $Action: 1, $Target: 0 },
          Appearance: { $BGColour: "202020", $FontColour: "FFFFFF" },
      }});
    
      isPrimaryCue = false;
    }

    let isPrimaryCue = true;

    // Lighting cues
    if (cue.tracks.lights) {
      // Trigger a grandMA2 cue via MIDI. The channel and MIDI note are derived from the cue index.
      // The MIDI Mapping for grandMA2 is generated using the same mapping.
      // Whenever the order of cues changes, both files should be re-generated.
      addCue("LX", cue.tracks.lights.description, {
        Type: 6,
        Patch: MULTIPLAY_LX_MIDI_PATCH,
        Msg: {
          $Command: 1,
          $Channel: Math.trunc(idx / 128),
          $Data1: idx % 128,
          $Data2: 127,
        }
      });
    }

    // Sound cues
    if (cue.tracks.sound) {
      // Generates an audio cue iff a sound file is linked in the file column.
      // In addition, generates a control cue for each control action in the params column (see parseParams for details).
      const {label, params, actions} = parseParams(cue.tracks.sound.params, soundLabels);
      const hasFile = cue.tracks.sound.file != null;
      const hasLabel = label != null;
      const hasParams = Object.keys(params).length > 0;

      // The params need an audio cue / file to apply to.
      assert(hasFile || !hasParams, `sound cue ${cue.cue} has params, but no file`);
      // The label needs an audio cue / file to apply to.
      assert(hasFile || !hasLabel, `sound cue ${cue.cue} has label, but no file`);

      if (hasLabel) {
        assert(!soundLabels.has(label), `duplicate label #${label}`);
        soundLabels.set(label, nextUid);
      }

      if (hasFile) {
        addCue("SX", cue.tracks.sound.description, {...{
          Type: 0,
          File: {
            $Name: `${LOCAL_FOLDER}\\sound\\${cue.tracks.sound.file.name}`,
          },
          AudioChannel: MULTIPLAY_SX_AUDIO_CHANNEL,
        }, ...params});
      }

      for (const action of actions) {
        addCue("SX", cue.tracks.sound.description, action);
      }
    }

    // Video cues
    if (cue.tracks.video) {
      // Triggers a QLab cue by the same name / ID via OSC. The target IP / port can be set in the MultiPlay XML template.
      addCue("VX", cue.tracks.video.description, {
        Type: 13,
        Patch: MULTIPLAY_VX_OSC_PATCH,
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

    assert(!isPrimaryCue, `cue ${cue.cue} has no action`);
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
 */
function parseParams(input, labels) {
  let label = null;
  const actions = [];
  const params = {};

  for (const line of input?.split("\n") || []) {
    const parts = line.split(" ");
    const name = parts[0];
    const args = parts.slice(1);

    if (name.startsWith("#")) {
      assert(args.length === 0);
      assert(label == null);
      label = name.slice(1);
      continue;
    }

    switch (name) {
      case "$loop":
        assert(args.length <= 1);
        params.Loops = args[0] || 0;
        break;

      case "$fade-in-dur":
        assert(args.length === 1);
        params.Fade = params.Fade || {};
        params.Fade.$In = args[0] * 1000;
        break;

      case "$fade-out-dur":
        assert(args.length === 1);
        params.Fade = params.Fade || {};
        params.Fade.$Out = args[0] * 1000;
        params.Fade.$AtEnd = -1;
        break;

      case "$delay":
        assert(args.length === 1);
        params.Wait = params.Wait || {};
        params.Wait.$Pre = args[0] * 1000;
        break;

      case "$volume":
        assert(args.length === 1);
        params["Volume-dB"] = args[0];
        break;

      case "$start-pos":
        assert(args.length === 1);
        params.File = params.File || {};
        params.File.$StartPos = args[0] * 1000;
        break;

      case "$stop-pos":
        assert(args.length === 1);
        params.File = params.File || {};
        params.File.$StopPos = args[0] * 1000;
        break;

      case "!stop":
      case "!pause":
      case "!resume":
      case "!fade-out":
        const action = { "!stop": 1,"!pause": 2,"!resume": 3,"!fade-out": 13 }[name];
        assert(action != null);
        
        assert(args.length === 1);
        const target = labels.get(args[0]);
        assert(target != null);
        
        actions.push({
          Type: 5,
          Control: { $Action: action, $Target: target },
        });
        break;

      case "!inc-volume":
        assert(args.length === 3);
        const volTarget = labels.get(args[0]);
        assert(volTarget != null);
        const change = args[1].match(/\+(\d+)dB/)?.[1];
        assert(change);
        actions.push({
          Type: 5,
          Control: { $Action: 4, $Target: volTarget, $EndValue: change, $FadeTime: args[2] * 1000, $RelativeFade: -1},
        });
        break;
        break;
      
      default:
        assert(false, `invalid param ${name}`);
    }
  }
  
  return {label, params, actions};
}

/**
 * Base MultiPlay production XML template containing audio, MIDI, network patches.
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
  <MIDI>
    <Patch Name="grandMA2" DeviceName="LoopBe Internal MIDI" Enabled="-1"/>
  </MIDI>
  <Network>
    <Patch Name="QLab" Destination="192.168.0.80" Adapter="{552E5721-8042-4E9E-ADE6-FB41CBDA4E0A}" Port="53000" Encoding="1" Enabled="-1"/>
  </Network>
  <Video/>
</Production>`);

