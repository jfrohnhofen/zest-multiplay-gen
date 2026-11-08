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

/**
 * Collects warnings and errors for a single phase (e.g. "parse", "multiplay", "assets").
 *
 * Neither `warn` nor `err` throws. Callers record the problem and carry on (or skip the offending item),
 * so that a single run reports everything that is wrong. At the end of the phase, callers check `hasErrors()`
 * to decide whether to write any output and call `report()` to log / summarize the issues.
 *
 * Messages are prefixed with the phase, and the current row / cue (see `at`) when set.
 */
class Context {
  constructor(phase) {
    this.phase = phase;
    this.issues = [];
    this.row = null;
    this.cue = null;
  }

  /** Sets the cue (see `parseCuelist`) whose row and cue id subsequent messages refer to. Call with no arguments to clear. */
  at(cue = null) {
    this.row = cue?.row ?? null;
    this.cue = cue?.cue || null;
    return this;
  }

  warn(msg) {
    this.#add("warning", msg);
  }

  err(msg) {
    this.#add("error", msg);
  }

  /** Records an error if `cond` is falsy. Returns `cond` so callers can write `if (!ctx.check(...)) continue;`. */
  check(cond, msg) {
    if (!cond) {
      this.err(msg);
    }
    return cond;
  }

  hasErrors() {
    return this.issues.some(x => x.severity === "error");
  }

  /** Logs all issues to the console and returns a one-line summary (e.g. "parse: 2 errors, 1 warning"). */
  report() {
    for (const {severity, text} of this.issues) {
      (severity === "error" ? console.error : console.warn)(text);
    }

    const count = severity => this.issues.filter(x => x.severity === severity).length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const summary = this.issues.length === 0
      ? `${this.phase}: ok`
      : `${this.phase}: ${plural(count("error"), "error")}, ${plural(count("warning"), "warning")}`;
    console.log(summary);
    return summary;
  }

  #add(severity, msg) {
    const where = [
      this.row != null ? `row ${this.row}` : null,
      this.cue != null ? `cue ${this.cue}` : null,
    ].filter(x => x != null).join(", ");
    const text = `[${this.phase}] ${where ? `${where}: ` : ""}${msg}`;
    this.issues.push({severity, row: this.row, cue: this.cue, msg, text});
  }
}
