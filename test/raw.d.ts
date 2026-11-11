// Vite's `?raw` import: the file as a string (used to read a source file in a test without node types).
declare module "*?raw" {
  const text: string;
  export default text;
}
