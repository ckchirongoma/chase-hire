// pdf-parse's package index can run a debug self-test when imported directly (older releases),
// so we import the library file. It has the same API as the typed package entry.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse from "pdf-parse";
  export default pdfParse;
}
