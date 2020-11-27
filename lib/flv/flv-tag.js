/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * An object that stores the bytes of an FLV tag and methods for
 * querying and manipulating that data.
 * @see http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf
 */

// (type:uint, extraData:Boolean = false) extends ByteArray
class FlvTag {
  constructor(type, extraData) {
    /** @private */
    this.type = type;

    /** @private */
    this.extraData = extraData;

    // Counter if this is a metadata tag, nal start marker if this is a video
    // tag. unused if this is an audio tag
    /** @private */
    this.adHoc = 0;


    // The default size is 16kb but this is not enough to hold iframe
    // data and the resizing algorithm costs a bit so we create a larger
    // starting buffer for video tags
    /** @private */
    this.bufferStartSize = 16384;

    // commonly used metadata properties
    /** @private */
    this.widthBytes = FlvTag.widthBytes || new Uint8Array('width'.length);
    /** @private */
    this.heightBytes = FlvTag.heightBytes || new Uint8Array('height'.length);
    /** @private */
    this.videocodecidBytes = FlvTag.videocodecidBytes || new Uint8Array('videocodecid'.length);

    var i;

    if (!FlvTag.widthBytes) {
      // calculating the bytes of common metadata names ahead of time makes the
      // corresponding writes faster because we don't have to loop over the
      // characters
      // re-test with test/perf.html if you're planning on changing this
      for (i = 0; i < 'width'.length; i++) {
        this.widthBytes[i] = 'width'.charCodeAt(i);
      }
      for (i = 0; i < 'height'.length; i++) {
        this.heightBytes[i] = 'height'.charCodeAt(i);
      }
      for (i = 0; i < 'videocodecid'.length; i++) {
        this.videocodecidBytes[i] = 'videocodecid'.charCodeAt(i);
      }

      FlvTag.widthBytes = this.widthBytes;
      FlvTag.heightBytes = this.heightBytes;
      FlvTag.videocodecidBytes = this.videocodecidBytes;
    }

    this.keyFrame = false; // :Boolean

    switch (this.type) {
      case FlvTag.VIDEO_TAG:
        this.length = 16;
        // Start the buffer at 256k
        this.bufferStartSize *= 6;
        break;
      case FlvTag.AUDIO_TAG:
        this.length = 13;
        this.keyFrame = true;
        break;
      case FlvTag.METADATA_TAG:
        this.length = 29;
        this.keyFrame = true;
        break;
      default:
        throw new Error('Unknown FLV tag type');
    }

    this.bytes = new Uint8Array(this.bufferStartSize);
    this.view = new DataView(this.bytes.buffer);
    this.bytes[0] = this.type;
    this.position = this.length;
    this.keyFrame = this.extraData; // Defaults to false


    // presentation timestamp
    this.pts = 0;
    // decoder timestamp
    this.dts = 0;
  }

  // checks whether the FLV tag has enough capacity to accept the proposed
  // write and re-allocates the internal buffers if necessary
  /** @private */
  prepareWrite(flv, count) {
    var
      bytes,
      minLength = flv.position + count;
    if (minLength < flv.bytes.byteLength) {
      // there's enough capacity so do nothing
      return;
    }

    // allocate a new buffer and copy over the data that will not be modified
    bytes = new Uint8Array(minLength * 2);
    bytes.set(flv.bytes.subarray(0, flv.position), 0);
    flv.bytes = bytes;
    flv.view = new DataView(flv.bytes.buffer);
  }

  // ByteArray#writeBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0)
  writeBytes(bytes, offset, length) {
    var
      start = offset || 0,
      end;
    length = length || bytes.byteLength;
    end = start + length;

    this.prepareWrite(this, length);
    this.bytes.set(bytes.subarray(start, end), this.position);

    this.position += length;
    this.length = Math.max(this.length, this.position);
  }

  // ByteArray#writeByte(value:int):void
  writeByte(byte) {
    this.prepareWrite(this, 1);
    this.bytes[this.position] = byte;
    this.position++;
    this.length = Math.max(this.length, this.position);
  }

  // ByteArray#writeShort(value:int):void
  writeShort(short) {
    this.prepareWrite(this, 2);
    this.view.setUint16(this.position, short);
    this.position += 2;
    this.length = Math.max(this.length, this.position);
  }

  // Negative index into array
  // (pos:uint):int
  negIndex(pos) {
    return this.bytes[this.length - pos];
  }

  // The functions below ONLY work when this[0] == VIDEO_TAG.
  // We are not going to check for that because we dont want the overhead
  // (nal:ByteArray = null):int
  nalUnitSize() {
    if (this.adHoc === 0) {
      return 0;
    }

    return this.length - (this.adHoc + 4);
  }

  startNalUnit() {
    // remember position and add 4 bytes
    if (this.adHoc > 0) {
      throw new Error('Attempted to create new NAL wihout closing the old one');
    }

    // reserve 4 bytes for nal unit size
    this.adHoc = this.length;
    this.length += 4;
    this.position = this.length;
  }

  // (nal:ByteArray = null):void
  endNalUnit(nalContainer) {
    var
      nalStart,
      nalLength; // :uint


    // Rewind to the marker and write the size
    if (this.length === this.adHoc + 4) {
      // we started a nal unit, but didnt write one, so roll back the 4 byte size value
      this.length -= 4;
    } else if (this.adHoc > 0) {
      nalStart = this.adHoc + 4;
      nalLength = this.length - nalStart;

      this.position = this.adHoc;
      this.view.setUint32(this.position, nalLength);
      this.position = this.length;

      if (nalContainer) {
        // Add the tag to the NAL unit
        nalContainer.push(this.bytes.subarray(nalStart, nalStart + nalLength));
      }
    }

    this.adHoc = 0;
  }

  /**
   * Write out a 64-bit floating point valued metadata property. This method is
   * called frequently during a typical parse and needs to be fast.
   */
  // (key:String, val:Number):void
  writeMetaDataDouble(key, val) {
    var i;
    this.prepareWrite(this, 2 + key.length + 9);

    // write size of property name
    this.view.setUint16(this.position, key.length);
    this.position += 2;

    // this next part looks terrible but it improves parser throughput by
    // 10kB/s in my testing
    // write property name
    if (key === 'width') {
      this.bytes.set(this.widthBytes, this.position);
      this.position += 5;
    } else if (key === 'height') {
      this.bytes.set(this.heightBytes, this.position);
      this.position += 6;
    } else if (key === 'videocodecid') {
      this.bytes.set(this.videocodecidBytes, this.position);
      this.position += 12;
    } else {
      for (i = 0; i < key.length; i++) {
        this.bytes[this.position] = key.charCodeAt(i);
        this.position++;
      }
    }

    // skip null byte
    this.position++;

    // write property value
    this.view.setFloat64(this.position, val);
    this.position += 8;

    // update flv tag length
    this.length = Math.max(this.length, this.position);
    ++this.adHoc;
  }

  // (key:String, val:Boolean):void
  writeMetaDataBoolean(key, val) {
    var i;
    this.prepareWrite(this, 2);
    this.view.setUint16(this.position, key.length);
    this.position += 2;
    for (i = 0; i < key.length; i++) {
      // if key.charCodeAt(i) >= 255, handle error
      this.prepareWrite(this, 1);
      this.bytes[this.position] = key.charCodeAt(i);
      this.position++;
    }
    this.prepareWrite(this, 2);
    this.view.setUint8(this.position, 0x01);
    this.position++;
    this.view.setUint8(this.position, val ? 0x01 : 0x00);
    this.position++;
    this.length = Math.max(this.length, this.position);
    ++this.adHoc;
  }

  // ():ByteArray
  finalize() {
    var
      dtsDelta,
      len; // :int

    switch (this.bytes[0]) {
      // Video Data
      case FlvTag.VIDEO_TAG:
        // We only support AVC, 1 = key frame (for AVC, a seekable
        // frame), 2 = inter frame (for AVC, a non-seekable frame)
        this.bytes[11] = ((this.keyFrame || this.extraData) ? 0x10 : 0x20) | 0x07;
        this.bytes[12] = this.extraData ? 0x00 : 0x01;

        dtsDelta = this.pts - this.dts;
        this.bytes[13] = (dtsDelta & 0x00FF0000) >>> 16;
        this.bytes[14] = (dtsDelta & 0x0000FF00) >>> 8;
        this.bytes[15] = (dtsDelta & 0x000000FF) >>> 0;
        break;

      case FlvTag.AUDIO_TAG:
        this.bytes[11] = 0xAF; // 44 kHz, 16-bit stereo
        this.bytes[12] = this.extraData ? 0x00 : 0x01;
        break;

      case FlvTag.METADATA_TAG:
        this.position = 11;
        this.view.setUint8(this.position, 0x02); // String type
        this.position++;
        this.view.setUint16(this.position, 0x0A); // 10 Bytes
        this.position += 2;
        // set "onMetaData"
        this.bytes.set([0x6f, 0x6e, 0x4d, 0x65,
          0x74, 0x61, 0x44, 0x61,
          0x74, 0x61], this.position);
        this.position += 10;
        this.bytes[this.position] = 0x08; // Array type
        this.position++;
        this.view.setUint32(this.position, this.adHoc);
        this.position = this.length;
        this.bytes.set([0, 0, 9], this.position);
        this.position += 3; // End Data Tag
        this.length = this.position;
        break;
    }

    len = this.length - 11;

    // write the DataSize field
    this.bytes[1] = (len & 0x00FF0000) >>> 16;
    this.bytes[2] = (len & 0x0000FF00) >>> 8;
    this.bytes[3] = (len & 0x000000FF) >>> 0;
    // write the Timestamp
    this.bytes[4] = (this.dts & 0x00FF0000) >>> 16;
    this.bytes[5] = (this.dts & 0x0000FF00) >>> 8;
    this.bytes[6] = (this.dts & 0x000000FF) >>> 0;
    this.bytes[7] = (this.dts & 0xFF000000) >>> 24;
    // write the StreamID
    this.bytes[8] = 0;
    this.bytes[9] = 0;
    this.bytes[10] = 0;

    // Sometimes we're at the end of the view and have one slot to write a
    // uint32, so, prepareWrite of count 4, since, view is uint8
    this.prepareWrite(this, 4);
    this.view.setUint32(this.length, this.length);
    this.length += 4;
    this.position += 4;

    // trim down the byte buffer to what is actually being used
    this.bytes = this.bytes.subarray(0, this.length);
    this.frameTime = FlvTag.frameTime(this.bytes);
    // if bytes.bytelength isn't equal to this.length, handle error
    return this;
  }

  static AUDIO_TAG = 0x08; // == 8, :uint
  static VIDEO_TAG = 0x09; // == 9, :uint
  static METADATA_TAG = 0x12; // == 18, :uint

  // (tag:ByteArray):Boolean {
  static isAudioFrame(tag) {
    return FlvTag.AUDIO_TAG === tag[0];
  }
  // (tag:ByteArray):Boolean {
  static isVideoFrame(tag) {
    return FlvTag.VIDEO_TAG === tag[0];
  }
  // (tag:ByteArray):Boolean {
  static isMetaData(tag) {
    return FlvTag.METADATA_TAG === tag[0];
  }
  // (tag:ByteArray):Boolean {
  static isKeyFrame(tag) {
    if (FlvTag.isVideoFrame(tag)) {
      return tag[11] === 0x17;
    }

    if (FlvTag.isAudioFrame(tag)) {
      return true;
    }

    if (FlvTag.isMetaData(tag)) {
      return true;
    }

    return false;
  }
  // (tag:ByteArray):uint {
  static frameTime(tag) {
    var pts = tag[4] << 16; // :uint
    pts |= tag[5] << 8;
    pts |= tag[6] << 0;
    pts |= tag[7] << 24;
    return pts;
  }
}

export default FlvTag;
