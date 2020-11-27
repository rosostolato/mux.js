/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * A stream-based aac to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */

import Stream from '../utils/stream.js';
import { parseId3TagSize, parseAdtsSize } from './utils';

/**
 * Splits an incoming stream of binary data into ADTS and ID3 Frames.
 */
class AacStream extends Stream {
  constructor() {
    super();
    /** @private */
    this.everything = new Uint8Array();
    /** @private */
    this.timeStamp = 0;
  }

  setTimestamp(timestamp) {
    this.timeStamp = timestamp;
  }

  push(bytes) {
    var
      frameSize = 0,
      byteIndex = 0,
      bytesLeft,
      chunk,
      packet,
      tempLength;

    // If there are bytes remaining from the last segment, prepend them to the
    // bytes that were pushed in
    if (this.everything.length) {
      tempLength = this.everything.length;
      this.everything = new Uint8Array(bytes.byteLength + tempLength);
      this.everything.set(this.everything.subarray(0, tempLength));
      this.everything.set(bytes, tempLength);
    } else {
      this.everything = bytes;
    }

    while (this.everything.length - byteIndex >= 3) {
      if ((this.everything[byteIndex] === 'I'.charCodeAt(0)) &&
        (this.everything[byteIndex + 1] === 'D'.charCodeAt(0)) &&
        (this.everything[byteIndex + 2] === '3'.charCodeAt(0))) {

        // Exit early because we don't have enough to parse
        // the ID3 tag header
        if (this.everything.length - byteIndex < 10) {
          break;
        }

        // check framesize
        frameSize = parseId3TagSize(this.everything, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        // Add to byteIndex to support multiple ID3 tags in sequence
        if (byteIndex + frameSize > this.everything.length) {
          break;
        }
        chunk = {
          type: 'timed-metadata',
          data: this.everything.subarray(byteIndex, byteIndex + frameSize)
        };
        this.trigger('data', chunk);
        byteIndex += frameSize;
        continue;
      } else if (((this.everything[byteIndex] & 0xff) === 0xff) &&
        ((this.everything[byteIndex + 1] & 0xf0) === 0xf0)) {

        // Exit early because we don't have enough to parse
        // the ADTS frame header
        if (this.everything.length - byteIndex < 7) {
          break;
        }

        frameSize = parseAdtsSize(this.everything, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        if (byteIndex + frameSize > this.everything.length) {
          break;
        }

        packet = {
          type: 'audio',
          data: this.everything.subarray(byteIndex, byteIndex + frameSize),
          pts: this.timeStamp,
          dts: this.timeStamp
        };
        this.trigger('data', packet);
        byteIndex += frameSize;
        continue;
      }
      byteIndex++;
    }
    bytesLeft = this.everything.length - byteIndex;

    if (bytesLeft > 0) {
      this.everything = this.everything.subarray(byteIndex);
    } else {
      this.everything = new Uint8Array();
    }
  }

  reset() {
    this.everything = new Uint8Array();
    this.trigger('reset');
  }

  endTimeline() {
    this.everything = new Uint8Array();
    this.trigger('endedtimeline');
  }
}

export default AacStream;
