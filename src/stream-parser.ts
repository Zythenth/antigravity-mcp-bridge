import { StringDecoder } from 'node:string_decoder';

export class LineParser {
  private readonly decoder = new StringDecoder('utf8');
  private remainder = '';
  constructor(private readonly onLine: (line: string) => void, private readonly maxLineChars = 2_000_000) {}

  write(chunk: Buffer): void {
    this.remainder += this.decoder.write(chunk);
    this.drain();
    if (this.remainder.length > this.maxLineChars) {
      this.onLine(this.remainder.slice(0, this.maxLineChars));
      this.remainder = '';
    }
  }

  end(): void {
    this.remainder += this.decoder.end();
    this.drain();
    if (this.remainder) this.onLine(this.remainder);
    this.remainder = '';
  }

  private drain(): void {
    let newline: number;
    while ((newline = this.remainder.indexOf('\n')) !== -1) {
      const line = this.remainder.slice(0, newline).replace(/\r$/, '');
      this.remainder = this.remainder.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }
}
