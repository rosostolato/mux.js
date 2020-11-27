/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */

/**
 * Parser for exponential Golomb codes, a variable-bitwidth number encoding
 * scheme used by h264.
 */
class ExpGolomb {
  constructor(workingData) {
    this.workingData = workingData;

    // the number of bytes left to examine in workingData
    this.workingBytesAvailable = workingData.byteLength;

    // the current word being examined
    this.workingWord = 0;

    // the number of bits left to examine in the current word
    this.workingBitsAvailable = 0; // :uint;

    this.loadWord();
  }

  // ():uint
  length() {
    return (8 * this.workingBytesAvailable);
  }

  // ():uint
  bitsAvailable() {
    return (8 * this.workingBytesAvailable) + this.workingBitsAvailable;
  }

  // ():void
  loadWord() {
    var
      position = this.workingData.byteLength - this.workingBytesAvailable,
      workingBytes = new Uint8Array(4),
      availableBytes = Math.min(4, this.workingBytesAvailable);

    if (availableBytes === 0) {
      throw new Error('no bytes available');
    }

    workingBytes.set(this.workingData.subarray(position,
      position + availableBytes));
    this.workingWord = new DataView(workingBytes.buffer).getUint32(0);

    // track the amount of workingData that has been processed
    this.workingBitsAvailable = availableBytes * 8;
    this.workingBytesAvailable -= availableBytes;
  }

  // (count:int):void
  skipBits(count) {
    var skipBytes; // :int
    if (this.workingBitsAvailable > count) {
      this.workingWord <<= count;
      this.workingBitsAvailable -= count;
    } else {
      count -= this.workingBitsAvailable;
      skipBytes = Math.floor(count / 8);

      count -= (skipBytes * 8);
      this.workingBytesAvailable -= skipBytes;

      this.loadWord();

      this.workingWord <<= count;
      this.workingBitsAvailable -= count;
    }
  }

  // (size:int):uint
  readBits(size) {
    var
      bits = Math.min(this.workingBitsAvailable, size),
      valu = this.workingWord >>> (32 - bits); // :uint

    // if size > 31, handle error
    this.workingBitsAvailable -= bits;
    if (this.workingBitsAvailable > 0) {
      this.workingWord <<= bits;
    } else if (this.workingBytesAvailable > 0) {
      this.loadWord();
    }

    bits = size - bits;
    if (bits > 0) {
      return valu << bits | this.readBits(bits);
    }
    return valu;
  }

  // ():uint
  skipLeadingZeros() {
    var leadingZeroCount; // :uint
    for (leadingZeroCount = 0; leadingZeroCount < this.workingBitsAvailable; ++leadingZeroCount) {
      if ((this.workingWord & (0x80000000 >>> leadingZeroCount)) !== 0) {
        // the first bit of working word is 1
        this.workingWord <<= leadingZeroCount;
        this.workingBitsAvailable -= leadingZeroCount;
        return leadingZeroCount;
      }
    }

    // we exhausted workingWord and still have not found a 1
    this.loadWord();
    return leadingZeroCount + this.skipLeadingZeros();
  }

  // ():void
  skipUnsignedExpGolomb() {
    this.skipBits(1 + this.skipLeadingZeros());
  }

  // ():void
  skipExpGolomb() {
    this.skipBits(1 + this.skipLeadingZeros());
  }

  // ():uint
  readUnsignedExpGolomb() {
    var clz = this.skipLeadingZeros(); // :uint
    return this.readBits(clz + 1) - 1;
  }

  // ():int
  readExpGolomb() {
    var valu = this.readUnsignedExpGolomb(); // :int
    if (0x01 & valu) {
      // the number is odd if the low order bit is set
      return (1 + valu) >>> 1; // add 1 to make it even, and divide by 2
    }
    return -1 * (valu >>> 1); // divide by two then make it negative
  }

  // Some convenience functions
  // :Boolean
  readBoolean() {
    return this.readBits(1) === 1;
  }

  // ():int
  readUnsignedByte() {
    return this.readBits(8);
  }
}

export default ExpGolomb;
