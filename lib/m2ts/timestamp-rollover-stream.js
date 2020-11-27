/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * Accepts program elementary stream (PES) data events and corrects
 * decode and presentation time stamps to account for a rollover
 * of the 33 bit value.
 */
import Stream from '../utils/stream';

var MAX_TS = 8589934592;

var RO_THRESH = 4294967296;

var TYPE_SHARED = 'shared';

var handleRollover = function(value, reference) {
  var direction = 1;

  if (value > reference) {
    // If the current timestamp value is greater than our reference timestamp and we detect a
    // timestamp rollover, this means the roll over is happening in the opposite direction.
    // Example scenario: Enter a long stream/video just after a rollover occurred. The reference
    // point will be set to a small number, e.g. 1. The user then seeks backwards over the
    // rollover point. In loading this segment, the timestamp values will be very large,
    // e.g. 2^33 - 1. Since this comes before the data we loaded previously, we want to adjust
    // the time stamp to be `value - 2^33`.
    direction = -1;
  }

  // Note: A seek forwards or back that is greater than the RO_THRESH (2^32, ~13 hours) will
  // cause an incorrect adjustment.
  while (Math.abs(reference - value) > RO_THRESH) {
    value += (direction * MAX_TS);
  }

  return value;
};

class TimestampRolloverStream extends Stream {
  constructor(type) {
    super();

    // The "shared" type is used in cases where a stream will contain muxed
    // video and audio. We could use `undefined` here, but having a string
    // makes debugging a little clearer.
    this.type_ = type || TYPE_SHARED;
  }

  push(data) {

    // Any "shared" rollover streams will accept _all_ data. Otherwise,
    // streams will only accept data that matches their type.
    if (this.type_ !== TYPE_SHARED && data.type !== this.type_) {
      return;
    }

    if (this.referenceDTS === undefined) {
      this.referenceDTS = data.dts;
    }

    data.dts = handleRollover(data.dts, this.referenceDTS);
    data.pts = handleRollover(data.pts, this.referenceDTS);

    this.lastDTS = data.dts;

    this.trigger('data', data);
  }

  flush() {
    this.referenceDTS = this.lastDTS;
    this.trigger('done');
  }

  endTimeline() {
    this.flush();
    this.trigger('endedtimeline');
  }

  discontinuity() {
    this.referenceDTS = void 0;
    this.lastDTS = void 0;
  }

  reset() {
    this.discontinuity();
    this.trigger('reset');
  }
}

export default {
  TimestampRolloverStream,
  handleRollover
};
