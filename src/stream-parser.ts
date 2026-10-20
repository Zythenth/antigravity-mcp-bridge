import { StringDecoder } from 'node:string_decoder';

export class LineParser {
  private readonly decoder = new StringDecoder('utf8');
  private remainder = '';
  private discarding = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars = 2_000_000,
    private readonly onOverflow?: () => void,
  ) {
    if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) throw new RangeError('Invalid line limit');
  }

  write(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  end(): void {
    this.consume(this.decoder.end());
    if (!this.discarding && this.remainder) this.onLine(this.remainder);
    this.remainder = '';
  }

  private consume(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline === -1 ? text.length : newline;
      if (!this.discarding) {
        if (this.remainder.length + end - offset > this.maxLineChars) {
          this.remainder = '';
          this.discarding = true;
          this.onOverflow?.();
        } else {
          this.remainder += text.slice(offset, end);
        }
      }
      if (newline === -1) return;
      if (!this.discarding) {
        const line = this.remainder.replace(/\r$/, '');
        if (line) this.onLine(line);
      }
      this.remainder = '';
      this.discarding = false;
      offset = newline + 1;
    }
  }
}
