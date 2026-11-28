//@ backend dafny

// Path containment: the decision the setup wizard makes before it serves a file,
// proved with LemmaScript and Dafny (`npm run spec:containment`).
// scripts/path_containment.rb makes the same decision for sync before it writes.
//
// The functions only compare strings, which is what makes them provable. Reading
// the file system stays with the callers, outside the proof. The wizard resolves
// a request with node:path and, when the path exists, compares real paths. Sync
// refuses a path that leads through a symbolic link, then compares real paths.
// Both pass the platform's separator.

/**
 * Whether `candidate` is `base` itself or a path inside it.
 *
 * Both paths must be absolute and normalised: one separator between segments,
 * no trailing separator and no `.` or `..` segments, as resolve() and realpath
 * return them. A separator must follow the base, so `/a/bc` is not inside
 * `/a/b`. The file-system root ends with a separator, so a base of `/` contains
 * only itself: a caller that passes the root as the base refuses every other
 * path, which fails closed.
 */
export function childWithin(base: string, candidate: string, sep: string): boolean {
  //@ verify
  //@ contract True exactly when the candidate is the base, or starts with the base followed by the separator; a sibling that only shares a prefix with the base is never inside it, and neither is a path shorter than the base.
  //@ requires sep.length === 1
  //@ ensures \result ==> candidate === base || candidate.startsWith(base + sep)
  //@ ensures candidate === base || candidate.startsWith(base + sep) ==> \result
  //@ ensures candidate.length > base.length && candidate.startsWith(base) && candidate[base.length] !== sep[0] ==> !\result
  //@ ensures candidate.length < base.length ==> !\result
  return candidate === base || candidate.startsWith(base + sep);
}

/**
 * Containment nests: a path inside a folder that is itself inside an outer
 * folder is inside the outer folder. Nothing calls this function. It exists so
 * that Dafny proves its contract, which relates three paths and so cannot be
 * stated on childWithin alone.
 */
function containmentNests(outer: string, middle: string, inner: string, sep: string): boolean {
  //@ verify
  //@ contract A path inside a folder that is itself inside an outer folder is inside the outer folder.
  //@ requires sep.length === 1
  //@ ensures childWithin(outer, middle, sep) && childWithin(middle, inner, sep) ==> childWithin(outer, inner, sep)
  return true;
}
