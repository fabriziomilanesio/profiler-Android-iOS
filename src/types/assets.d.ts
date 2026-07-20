// Imports de assets con `with { type: 'file' }` (Bun): el default export es la ruta
// al archivo (embebida en binarios compilados). Solo tipos — Bun resuelve en runtime.
declare module '*.html' {
  const path: string
  export default path
}
declare module '*.png' {
  const path: string
  export default path
}
declare module '*.woff2' {
  const path: string
  export default path
}
declare module '*.js' {
  const path: string
  export default path
}
