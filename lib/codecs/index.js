/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
import Adts from './adts';
import { H264Stream, NalByteStream } from './h264';

const h264 = {
  H264Stream,
  NalByteStream
};

export default { Adts, h264 };

