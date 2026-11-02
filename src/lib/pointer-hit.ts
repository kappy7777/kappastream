/** Hit-test indirection for the deferred player-leave check: the real
 * document.elementFromPoint in the app, a mock seam in tests (happy-dom has
 * no layout engine, so its own answer cannot be trusted to pin behavior). */
export function elementAtPoint(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)
}
