/**
 * Runs `build` with `new Function` refusing, as it does under a Content Security Policy
 * without `unsafe-eval`. Object schemas generate their record encoder and decoder with it,
 * so every one constructed inside falls back to the interpreted path, which a normal run
 * never reaches.
 *
 * Kept out of a `.test.ts` file, as `generate.ts` is, so a suite can import it without
 * re-running the one it came from.
 */
export function buildUnderCsp<T>(build: () => T): T {
  const realFunction = globalThis.Function;
  globalThis.Function = new Proxy(realFunction, {
    construct() {
      throw new EvalError("Refused to evaluate a string as JavaScript");
    },
  }) as FunctionConstructor;
  try {
    return build();
  } finally {
    globalThis.Function = realFunction;
  }
}
