const raw = process.env.BRIDGE_TEST_CLOCK_OFFSET_MS;
if (raw !== undefined) {
  const offset = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(offset)) throw Error('Invalid BRIDGE_TEST_CLOCK_OFFSET_MS');
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  };
}
