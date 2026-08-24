/**
 * Generates an XML file (`MIDI.xml`) for grandMA2 lighting control containing MIDI Remote mappings.
 * Mapped commands trigger macro lines corresponding to `Goto Cue <cue_number>` for lighting cues.
 *
 * To install the mapping in a grandMA2 show:
 *  1. Store generated file in C:\\ProgramData\\MA Lighting Technologies\\grandma\\...\\importexport.
 *  2. Run 'Import "Midi" At Remote 2' from the grandMA2 console.
 */
function generateGrandMA2Xml(cues) {
  cues = cues ?? parseCuelist();

  const midiCommands = [];
  for (const [idx, cue] of cues.entries()) {
    if (cue.tracks.lights) {
      midiCommands.push({
		    $index: midiCommands.length,
        $channel: Math.trunc(idx / 128) + 1,
        $note: idx % 128,
        $type: "macro_line",
        macro_line: `Goto Cue ${cue.cue}`,
      });
    }
  }

  const midiRemote = XmlService.createElement("MidiRemotes").setAttribute("index", 1);
  toXml("RemoteMidi", midiCommands).forEach(x => midiRemote.addContent(x));
  midiMapping.getRootElement().addContent(midiRemote);
  content = XmlService.getPrettyFormat().format(midiMapping);  
  getOrCreateFile("MIDI.xml").setContent(content);
}

const midiMapping = XmlService.parse(`<?xml version="1.0" encoding="utf-8"?>
<MA xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.malighting.de/grandma2/xml/MA" xsi:schemaLocation="http://schemas.malighting.de/grandma2/xml/MA http://schemas.malighting.de/grandma2/xml/3.9.61/MA.xsd" major_vers="3" minor_vers="9" stream_vers="61">
</MA>`);
