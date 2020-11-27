/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
import tag from './flv-tag';
import Transmuxer from './transmuxer';
import getFlvHeader from './flv-header';

export default {
  tag,
  Transmuxer,
  getFlvHeader
};
