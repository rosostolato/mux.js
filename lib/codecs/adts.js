/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
import Stream from '../utils/stream.js';
import { ONE_SECOND_IN_TS } from '../utils/clock';

var
  ADTS_SAMPLING_FREQUENCIES = [
    96000,
    88200,
    64000,
    48000,
    44100,
    32000,
    24000,
    22050,
    16000,
    12000,
    11025,
    8000,
    7350
  ];

/*
 * Accepts a ElementaryStream and emits data events with parsed
 * AAC Audio Frames of the individual packets. Input audio in ADTS
 * format is unpacked and re-emitted as AAC frames.
 *
 * @see http://wiki.multimedia.cx/index.php?title=ADTS
 * @see http://wiki.multimedia.cx/?title=Understanding_AAC
 */
class AdtsStream extends Stream {
  constructor(handlePartialSegments) {
    super();
    this.frameNum = 0;
    this.handlePartialSegments = handlePartialSegments;
  }

  push(packet) {
    var
      i = 0,
      frameLength,
      protectionSkipBytes,
      frameEnd,
      oldBuffer,
      sampleCount,
      adtsFrameDuration;

    if (!this.handlePartialSegments) {
      this.frameNum = 0;
    }

    if (packet.type !== 'audio') {
      // ignore non-audio data
      return;
    }

    // Prepend any data in the buffer to the input data so that we can parse
    // aac frames the cross a PES packet boundary
    if (this.buffer) {
      oldBuffer = this.buffer;
      this.buffer = new Uint8Array(oldBuffer.byteLength + packet.data.byteLength);
      this.buffer.set(oldBuffer);
      this.buffer.set(packet.data, oldBuffer.byteLength);
    } else {
      this.buffer = packet.data;
    }

    // unpack any ADTS frames which have been fully received
    // for details on the ADTS header, see http://wiki.multimedia.cx/index.php?title=ADTS
    while (i + 5 < this.buffer.length) {

      // Look for the start of an ADTS header..
      if ((this.buffer[i] !== 0xFF) || (this.buffer[i + 1] & 0xF6) !== 0xF0) {
        // If a valid header was not found,  jump one forward and attempt to
        // find a valid ADTS header starting at the next byte
        i++;
        continue;
      }

      // The protection skip bit tells us if we have 2 bytes of CRC data at the
      // end of the ADTS header
      protectionSkipBytes = (~this.buffer[i + 1] & 0x01) * 2;

      // Frame length is a 13 bit integer starting 16 bits from the
      // end of the sync sequence
      frameLength = ((this.buffer[i + 3] & 0x03) << 11) |
        (this.buffer[i + 4] << 3) |
        ((this.buffer[i + 5] & 0xe0) >> 5);

      sampleCount = ((this.buffer[i + 6] & 0x03) + 1) * 1024;
      adtsFrameDuration = (sampleCount * ONE_SECOND_IN_TS) /
        ADTS_SAMPLING_FREQUENCIES[(this.buffer[i + 2] & 0x3c) >>> 2];

      frameEnd = i + frameLength;

      // If we don't have enough data to actually finish this ADTS frame, return
      // and wait for more data
      if (this.buffer.byteLength < frameEnd) {
        return;
      }

      // Otherwise, deliver the complete AAC frame
      this.trigger('data', {
        pts: packet.pts + (this.frameNum * adtsFrameDuration),
        dts: packet.dts + (this.frameNum * adtsFrameDuration),
        sampleCount: sampleCount,
        audioobjecttype: ((this.buffer[i + 2] >>> 6) & 0x03) + 1,
        channelcount: ((this.buffer[i + 2] & 1) << 2) |
          ((this.buffer[i + 3] & 0xc0) >>> 6),
        samplerate: ADTS_SAMPLING_FREQUENCIES[(this.buffer[i + 2] & 0x3c) >>> 2],
        samplingfrequencyindex: (this.buffer[i + 2] & 0x3c) >>> 2,
        // assume ISO/IEC 14496-12 AudioSampleEntry default of 16
        samplesize: 16,
        data: this.buffer.subarray(i + 7 + protectionSkipBytes, frameEnd)
      });

      this.frameNum++;

      // If the buffer is empty, clear it and return
      if (this.buffer.byteLength === frameEnd) {
        this.buffer = undefined;
        return;
      }

      // Remove the finished frame from the buffer and start the process again
      this.buffer = this.buffer.subarray(frameEnd);
    }
  }

  flush() {
    this.frameNum = 0;
    this.trigger('done');
  }

  reset() {
    this.buffer = void 0;
    this.trigger('reset');
  }

  endTimeline() {
    this.buffer = void 0;
    this.trigger('endedtimeline');
  }
}

export default AdtsStream;
