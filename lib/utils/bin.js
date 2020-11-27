/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
export var toUnsigned = function(value) {
  return value >>> 0;
};

export var toHexString = function(value) {
  return ('00' + value.toString(16)).slice(-2);
};
