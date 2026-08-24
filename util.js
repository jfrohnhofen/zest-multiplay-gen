/**
 * Retrieves an existing file by name from the designated Google Drive output folder,
 * or creates a new empty file if it does not already exist.
 */
function getOrCreateFile(name) {
  const folder = DriveApp.getFolderById(OUTPUT_FOLDER);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName() == name) {
      return file;
    }
  }
  return folder.createFile(name, "");
}

/**
 * Recursively converts JavaScript data structures (objects, arrays, primitives, XmlService elements)
 * into Google Apps Script `XmlService.Element` nodes.
 * 
 * Formatting rules:
 * - Arrays result in multiple XML elements sharing the given `name`.
 * - Object properties starting with `$` are added as attributes (stripping the `$`).
 * - Other object properties are recursively converted to child XML elements.
 * - Primitive values are set as textual content of the element.
 */
function toXml(name, val) {
  if (Array.isArray(val)) {
    return val.flatMap(child => toXml(name, child));
  }

  if (val !== null && typeof val === "object") {
    if (val.hasOwnProperty('isRootElement')) {
      return [val];
    }

    const el = XmlService.createElement(name);
    for (const [k, v] of Object.entries(val)) {
      if (k[0] === "$") {
        el.setAttribute(k.slice(1), v);
      } else {
        toXml(k, v).forEach(x => el.addContent(x));
      }
    }
    return [el];
  }

  return [XmlService.createElement(name).setText(val)];
}

/**
 * Asserts that a condition is truthy, throwing an Error with the specified message if not.
 */
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}
