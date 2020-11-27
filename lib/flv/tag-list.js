/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
export default class TagList {
  constructor() {
    this.list = [];
  }

  get length() {
    return this.list.length;
  }

  push(tag) {
    this.list.push({
      bytes: tag.bytes,
      dts: tag.dts,
      pts: tag.pts,
      keyFrame: tag.keyFrame,
      metaDataTag: tag.metaDataTag
    });
  }
}
