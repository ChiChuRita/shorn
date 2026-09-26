/**
 * Runs `build` with `new Function` refusing, as it does under a Content Security Policy
 * without `unsafe-eval`. Object schemas generate their record encoder and decoder with it,
 * so every one constructed inside falls back to the interpreted path, which a normal run
 * never reaches.
 *
 * Kept out of a `.test.ts` file, as `generate.ts` is, so a suite can import it without
 * re-running the one it came from.
 *
 * Throws if nothing inside tried to generate code. Every caller compares the fallback with
 * something, and a comparison of the generated path with itself passes, so a library change
 * that stopped reaching `new Function` this way, a plain `Function(...)` call, say, would
 * otherwise leave every caller green and testing nothing.
 */
export function buildUnderCsp<T>(build: () => T): T {
  const realFunction = globalThis.Function;
  let refused = 0;
  globalThis.Function = new Proxy(realFunction, {
    construct() {
      refused++;
      throw new EvalError("Refused to evaluate a string as JavaScript");
    },
  }) as FunctionConstructor;
  try {
    const built = build();
    if (refused === 0) {
      throw new Error("Nothing built under buildUnderCsp tried to generate code");
    }
    return built;
  } finally {
    globalThis.Function = realFunction;
  }
}
