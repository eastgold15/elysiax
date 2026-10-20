/**
 * There's no real way to validate HTML, so this is a best guess.
 *
 * @see https://stackoverflow.com/q/1732348
 * @see https://stackoverflow.com/q/11229831
 */
export function isHtml(this: void, value?: unknown): value is string {
  if (typeof value !== 'string')
    return false

  // TS7（tsc 7.x native）对「类型谓词签名 + 参数再赋值」的窄化有 bug，
  // 用新 const 绕开（见 memory: htmx-tsx-conventions）
  const v = value.trim()
  const length = v.length

  return (
    // Minimum html is 7 characters long: <a></a>
    length >= 7 &&
    // open tag
    v[0] === '<' &&
    // close tag
    v[length - 1] === '>'
  )
}

/**
 * Returns true if the string starts with `<html`, **ignores whitespaces and
 * casing**.
 */
export function isTagHtml(this: void, value: string) {
  return value.trimStart().slice(0, 5).toLowerCase() === '<html'
}