/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
import codecs from './codecs';
import mp4 from './mp4';
import flv from './flv';
import mp2t from './m2ts';
import partial from './partial';

// include all the tools when the full library is required
import mp4Tools from './tools/mp4-inspector';
import flvTools from './tools/flv-inspector';
import mp2tTools from './tools/ts-inspector';

// include all the tools when the full library is required
const _mp4 = { ...mp4, tools: mp4Tools };
const _flv = { ...flv, tools: flvTools };
const _mp2t = { ...mp2t, tools: mp2tTools };

var muxjs = {
  codecs,
  mp4: _mp4,
  flv: _flv,
  mp2t: _mp2t,
  partial
};

export default muxjs;
