/**
 * Bundles cue assets by organizing referenced Google Drive files into output subfolders.
 * 
 * First clears any existing subfolders in the target Google Drive output directory (`OUTPUT_FOLDER`).
 * Then iterates through all parsed cues and creates Drive shortcuts to referenced track asset files
 * within corresponding track subfolders (e.g. sound, video), ensuring each file is only linked once per track.
 */
function bundleAssets(cues) {
  cues = cues ?? parseCuelist();

  const outputFolder = DriveApp.getFolderById(OUTPUT_FOLDER);
  const subfolders = outputFolder.getFolders();
  while (subfolders.hasNext()) {
    subfolders.next().setTrashed(true);
  }

  const tracks = {};
  for (const cue of cues) {
    for (const track in cue.tracks) {
      const file = cue.tracks[track].file;
      const id = file?.uri?.match(/[-\w]{25,}/)?.[0];
      if (id == null) {
        continue;
      }

      if (tracks[track] == null) {
        tracks[track] = {
          folder: outputFolder.createFolder(track),
          seen: new Set(),
        };
      }
      const folder = tracks[track].folder;
      
      if (!tracks[track].seen.has(id)) {
        tracks[track].seen.add(id);
        folder.createShortcut(id);
      }
    }
  }
}

