/**
 * Bundles cue assets by organizing referenced Google Drive files into output subfolders.
 * 
 * First collects the Drive files referenced by all parsed cues, ensuring each file is only linked once per track.
 * Problems (e.g. a file that is not a Drive link) are reported to an "assets" context. If there are any errors, or
 * nothing to bundle, the existing output is left untouched.
 *
 * Otherwise clears any existing subfolders in the target Google Drive output directory (`OUTPUT_FOLDER`) and creates
 * Drive shortcuts to the files within corresponding track subfolders (e.g. sound, video).
 */
function bundleAssets(cues) {
  cues = cues ?? parseCuelist();
  if (cues.length === 0) {
    // Nothing to generate (empty sheet or parse errors). Bail out so existing output is not overwritten / wiped.
    console.warn("[assets] no cues, nothing to do");
    return;
  }

  const ctx = new Context("assets");

  // Collects the ids of the Drive files to link for each track (e.g. sound, video), without touching Drive yet.
  const tracks = new Map();
  for (const cue of cues) {
    ctx.at(cue);
    for (const track in cue.tracks) {
      const file = cue.tracks[track].file;
      if (file == null) {
        continue;
      }

      const id = file.uri?.match(/[-\w]{25,}/)?.[0];
      if (!ctx.check(id != null, `${track} file "${file.name ?? file}" is not a link to a Google Drive file`)) {
        continue;
      }

      if (!tracks.has(track)) {
        tracks.set(track, new Set());
      }
      tracks.get(track).add(id);
    }
  }
  ctx.at();

  if (tracks.size === 0) {
    ctx.warn("no files to bundle, nothing to do");
  }
  ctx.report("output not updated");
  if (ctx.hasErrors() || tracks.size === 0) {
    // Do not wipe the existing output.
    return;
  }

  const outputFolder = DriveApp.getFolderById(OUTPUT_FOLDER);
  const subfolders = outputFolder.getFolders();
  while (subfolders.hasNext()) {
    subfolders.next().setTrashed(true);
  }

  for (const [track, ids] of tracks) {
    const folder = outputFolder.createFolder(track);
    for (const id of ids) {
      folder.createShortcut(id);
    }
  }
}
