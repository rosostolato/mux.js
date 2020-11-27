/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * A stream-based mp2t to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */

import Stream from '../utils/stream.js';
import { CaptionStream as _CaptionStream, Cea608Stream as _Cea608Stream } from './caption-stream';
import StreamTypes, { H264_STREAM_TYPE, ADTS_STREAM_TYPE, METADATA_STREAM_TYPE, hasOwnProperty } from './stream-types';
import { TimestampRolloverStream } from './timestamp-rollover-stream';

// constants
var
  MP2T_PACKET_LENGTH = 188, // bytes
  SYNC_BYTE = 0x47;

/**
 * Splits an incoming stream of binary data into MPEG-2 Transport
 * Stream packets.
 */
class TransportPacketStream extends Stream {
  constructor() {
    super();
    /** @private */
    this.buffer = new Uint8Array(MP2T_PACKET_LENGTH);
    /** @private */
    this.bytesInBuffer = 0;
  }

  // Deliver new bytes to the stream.
  /**
   * Split a stream of data into M2TS packets
  **/
  push(bytes) {
    var
      startIndex = 0,
      endIndex = MP2T_PACKET_LENGTH,
      everything;

    // If there are bytes remaining from the last segment, prepend them to the
    // bytes that were pushed in
    if (this.bytesInBuffer) {
      everything = new Uint8Array(bytes.byteLength + this.bytesInBuffer);
      everything.set(this.buffer.subarray(0, this.bytesInBuffer));
      everything.set(bytes, this.bytesInBuffer);
      this.bytesInBuffer = 0;
    } else {
      everything = bytes;
    }

    // While we have enough data for a packet
    while (endIndex < everything.byteLength) {
      // Look for a pair of start and end sync bytes in the data..
      if (everything[startIndex] === SYNC_BYTE && everything[endIndex] === SYNC_BYTE) {
        // We found a packet so emit it and jump one whole packet forward in
        // the stream
        this.trigger('data', everything.subarray(startIndex, endIndex));
        startIndex += MP2T_PACKET_LENGTH;
        endIndex += MP2T_PACKET_LENGTH;
        continue;
      }
      // If we get here, we have somehow become de-synchronized and we need to step
      // forward one byte at a time until we find a pair of sync bytes that denote
      // a packet
      startIndex++;
      endIndex++;
    }

    // If there was some data left over at the end of the segment that couldn't
    // possibly be a whole packet, keep it because it might be the start of a packet
    // that continues in the next segment
    if (startIndex < everything.byteLength) {
      this.buffer.set(everything.subarray(startIndex), 0);
      this.bytesInBuffer = everything.byteLength - startIndex;
    }
  }

  /**
   * Passes identified M2TS packets to the TransportParseStream to be parsed
  **/
  flush() {
    // If the buffer contains a whole packet when we are being flushed, emit it
    // and empty the buffer. Otherwise hold onto the data because it may be
    // important for decoding the next segment
    if (this.bytesInBuffer === MP2T_PACKET_LENGTH && this.buffer[0] === SYNC_BYTE) {
      this.trigger('data', this.buffer);
      this.bytesInBuffer = 0;
    }
    this.trigger('done');
  }

  endTimeline() {
    this.flush();
    this.trigger('endedtimeline');
  }

  reset() {
    this.bytesInBuffer = 0;
    this.trigger('reset');
  }
}

/**
 * Accepts an MP2T TransportPacketStream and emits data events with parsed
 * forms of the individual transport stream packets.
 */
class TransportParseStream extends Stream {
  static STREAM_TYPES = {
    h264: 0x1b,
    adts: 0x0f
  };

  constructor() {
    super();
    this.packetsWaitingForPmt = [];
    this.programMapTable = undefined;
  }

  /** @private */
  parsePsi(payload, psi) {
    var offset = 0;

    // PSI packets may be split into multiple sections and those
    // sections may be split into multiple packets. If a PSI
    // section starts in this packet, the payload_unit_start_indicator
    // will be true and the first byte of the payload will indicate
    // the offset from the current position to the start of the
    // section.
    if (psi.payloadUnitStartIndicator) {
      offset += payload[offset] + 1;
    }

    if (psi.type === 'pat') {
      this.parsePat(payload.subarray(offset), psi);
    } else {
      this.parsePmt(payload.subarray(offset), psi);
    }
  }

  /** @private */
  parsePat(payload, pat) {
    pat.section_number = payload[7]; // eslint-disable-line camelcase
    pat.last_section_number = payload[8]; // eslint-disable-line camelcase


    // skip the PSI header and parse the first PMT entry
    this.pmtPid = (payload[10] & 0x1F) << 8 | payload[11];
    pat.pmtPid = this.pmtPid;
  }

  /**
   * Parse out the relevant fields of a Program Map Table (PMT).
   * @param payload {Uint8Array} the PMT-specific portion of an MP2T
   * packet. The first byte in this array should be the table_id
   * field.
   * @param pmt {object} the object that should be decorated with
   * fields parsed from the PMT.
   * @private
   */
  parsePmt(payload, pmt) {
    var sectionLength, tableEnd, programInfoLength, offset;

    // PMTs can be sent ahead of the time when they should actually
    // take effect. We don't believe this should ever be the case
    // for HLS but we'll ignore "forward" PMT declarations if we see
    // them. Future PMT declarations have the current_next_indicator
    // set to zero.
    if (!(payload[5] & 0x01)) {
      return;
    }

    // overwrite any existing program map table
    this.programMapTable = {
      video: null,
      audio: null,
      'timed-metadata': {}
    };

    // the mapping table ends at the end of the current section
    sectionLength = (payload[1] & 0x0f) << 8 | payload[2];
    tableEnd = 3 + sectionLength - 4;

    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (payload[10] & 0x0f) << 8 | payload[11];

    // advance the offset to the first entry in the mapping table
    offset = 12 + programInfoLength;
    while (offset < tableEnd) {
      var streamType = payload[offset];
      var pid = (payload[offset + 1] & 0x1F) << 8 | payload[offset + 2];

      // only map a single elementary_pid for audio and video stream types
      // TODO: should this be done for metadata too? for now maintain behavior of
      //       multiple metadata streams
      if (streamType === H264_STREAM_TYPE &&
        this.programMapTable.video === null) {
        this.programMapTable.video = pid;
      } else if (streamType === ADTS_STREAM_TYPE &&
        this.programMapTable.audio === null) {
        this.programMapTable.audio = pid;
      } else if (streamType === METADATA_STREAM_TYPE) {
        // map pid to stream type for metadata streams
        this.programMapTable['timed-metadata'][pid] = streamType;
      }

      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((payload[offset + 3] & 0x0F) << 8 | payload[offset + 4]) + 5;
    }

    // record the map on the packet as well
    pmt.programMapTable = this.programMapTable;
  }

  /**
   * Deliver a new MP2T packet to the next stream in the pipeline.
   */
  push(packet) {
    var
      result = {},
      offset = 4;

    result.payloadUnitStartIndicator = !!(packet[1] & 0x40);

    // pid is a 13-bit field starting at the last bit of packet[1]
    result.pid = packet[1] & 0x1f;
    result.pid <<= 8;
    result.pid |= packet[2];

    // if an adaption field is present, its length is specified by the
    // fifth byte of the TS packet header. The adaptation field is
    // used to add stuffing to PES packets that don't fill a complete
    // TS packet, and to specify some forms of timing and control data
    // that we do not currently use.
    if (((packet[3] & 0x30) >>> 4) > 0x01) {
      offset += packet[offset] + 1;
    }

    // parse the rest of the packet based on the type
    if (result.pid === 0) {
      result.type = 'pat';
      this.parsePsi(packet.subarray(offset), result);
      this.trigger('data', result);
    } else if (result.pid === this.pmtPid) {
      result.type = 'pmt';
      this.parsePsi(packet.subarray(offset), result);
      this.trigger('data', result);

      // if there are any packets waiting for a PMT to be found, process them now
      while (this.packetsWaitingForPmt.length) {
        this.processPes_.apply(this, this.packetsWaitingForPmt.shift());
      }
    } else if (this.programMapTable === undefined) {
      // When we have not seen a PMT yet, defer further processing of
      // PES packets until one has been parsed
      this.packetsWaitingForPmt.push([packet, offset, result]);
    } else {
      this.processPes_(packet, offset, result);
    }
  }

  processPes_(packet, offset, result) {
    // set the appropriate stream type
    if (result.pid === this.programMapTable.video) {
      result.streamType = H264_STREAM_TYPE;
    } else if (result.pid === this.programMapTable.audio) {
      result.streamType = ADTS_STREAM_TYPE;
    } else {
      // if not video or audio, it is timed-metadata or unknown
      // if unknown, streamType will be undefined
      result.streamType = this.programMapTable['timed-metadata'][result.pid];
    }

    result.type = 'pes';
    result.data = packet.subarray(offset);
    this.trigger('data', result);
  }
}

/**
 * Reconsistutes program elementary stream (PES) packets from parsed
 * transport stream packets. That is, if you pipe an
 * mp2t.TransportParseStream into a mp2t.ElementaryStream, the output
 * events will be events which capture the bytes for individual PES
 * packets plus relevant metadata that has been extracted from the
 * container.
 */
class ElementaryStream {
  constructor() {
    super();

      /**
       * PES packet fragments
       * @private
       */
      this.video = {
        data: [],
        size: 0
      };
      /** @private */
      this.audio = {
        data: [],
        size: 0
      };
      /** @private */
      this.timedMetadata = {
        data: [],
        size: 0
      };
  }

  /** @private */
  parsePes(payload, pes) {
    var ptsDtsFlags;

    // get the packet length, this will be 0 for video
    pes.packetLength = 6 + ((payload[4] << 8) | payload[5]);

    // find out if this packets starts a new keyframe
    pes.dataAlignmentIndicator = (payload[6] & 0x04) !== 0;
    // PES packets may be annotated with a PTS value, or a PTS value
    // and a DTS value. Determine what combination of values is
    // available to work with.
    ptsDtsFlags = payload[7];

    // PTS and DTS are normally stored as a 33-bit number.  Javascript
    // performs all bitwise operations on 32-bit integers but javascript
    // supports a much greater range (52-bits) of integer using standard
    // mathematical operations.
    // We construct a 31-bit value using bitwise operators over the 31
    // most significant bits and then multiply by 4 (equal to a left-shift
    // of 2) before we add the final 2 least significant bits of the
    // timestamp (equal to an OR.)
    if (ptsDtsFlags & 0xC0) {
      // the PTS and DTS are not written out directly. For information
      // on how they are encoded, see
      // http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
      pes.pts = (payload[9] & 0x0E) << 27 |
        (payload[10] & 0xFF) << 20 |
        (payload[11] & 0xFE) << 12 |
        (payload[12] & 0xFF) << 5 |
        (payload[13] & 0xFE) >>> 3;
      pes.pts *= 4; // Left shift by 2
      pes.pts += (payload[13] & 0x06) >>> 1; // OR by the two LSBs
      pes.dts = pes.pts;
      if (ptsDtsFlags & 0x40) {
        pes.dts = (payload[14] & 0x0E) << 27 |
          (payload[15] & 0xFF) << 20 |
          (payload[16] & 0xFE) << 12 |
          (payload[17] & 0xFF) << 5 |
          (payload[18] & 0xFE) >>> 3;
        pes.dts *= 4; // Left shift by 2
        pes.dts += (payload[18] & 0x06) >>> 1; // OR by the two LSBs
      }
    }
    // the data section starts immediately after the PES header.
    // pes_header_data_length specifies the number of header bytes
    // that follow the last byte of the field.
    pes.data = payload.subarray(9 + payload[8]);
  }
  /**
    * Pass completely parsed PES packets to the next stream in the pipeline
    * @private
   **/
  flushStream(stream, type, forceFlush) {
    var
      packetData = new Uint8Array(stream.size),
      event = {
        type: type
      },
      i = 0,
      offset = 0,
      packetFlushable = false,
      fragment;

    // do nothing if there is not enough buffered data for a complete
    // PES header
    if (!stream.data.length || stream.size < 9) {
      return;
    }
    event.trackId = stream.data[0].pid;

    // reassemble the packet
    for (i = 0; i < stream.data.length; i++) {
      fragment = stream.data[i];

      packetData.set(fragment.data, offset);
      offset += fragment.data.byteLength;
    }

    // parse assembled packet's PES header
    this.parsePes(packetData, event);

    // non-video PES packets MUST have a non-zero PES_packet_length
    // check that there is enough stream data to fill the packet
    packetFlushable = type === 'video' || event.packetLength <= stream.size;

    // flush pending packets if the conditions are right
    if (forceFlush || packetFlushable) {
      stream.size = 0;
      stream.data.length = 0;
    }

    // only emit packets that are complete. this is to avoid assembling
    // incomplete PES packets due to poor segmentation
    if (packetFlushable) {
      this.trigger('data', event);
    }
  }

/**
 * Identifies M2TS packet types and parses PES packets using metadata
 * parsed from the PMT
 **/
push(data) {
  ({
    pat: function() {
      // we have to wait for the PMT to arrive as well before we
      // have any meaningful metadata
    },
    pes: function() {
      var stream, streamType;

      switch (data.streamType) {
        case H264_STREAM_TYPE:
          stream = this.video;
          streamType = 'video';
          break;
        case ADTS_STREAM_TYPE:
          stream = this.audio;
          streamType = 'audio';
          break;
        case METADATA_STREAM_TYPE:
          stream = this.timedMetadata;
          streamType = 'timed-metadata';
          break;
        default:
          // ignore unknown stream types
          return;
      }

      // if a new packet is starting, we can flush the completed
      // packet
      if (data.payloadUnitStartIndicator) {
        this.flushStream(stream, streamType, true);
      }

      // buffer this fragment until we are sure we've received the
      // complete payload
      stream.data.push(data);
      stream.size += data.data.byteLength;
    },
    pmt: function() {
      var
        event = {
          type: 'metadata',
          tracks: []
        };

      this.programMapTable = data.programMapTable;

      // translate audio and video streams to tracks
      if (this.programMapTable.video !== null) {
        event.tracks.push({
          timelineStartInfo: {
            baseMediaDecodeTime: 0
          },
          id: +this.programMapTable.video,
          codec: 'avc',
          type: 'video'
        });
      }
      if (this.programMapTable.audio !== null) {
        event.tracks.push({
          timelineStartInfo: {
            baseMediaDecodeTime: 0
          },
          id: +this.programMapTable.audio,
          codec: 'adts',
          type: 'audio'
        });
      }

      this.trigger('data', event);
    }
  })[data.type]();
}

reset() {
  this.video.size = 0;
  this.video.data.length = 0;
  this.audio.size = 0;
  this.audio.data.length = 0;
  this.trigger('reset');
}

/**
 * Flush any remaining input. Video PES packets may be of variable
 * length. Normally, the start of a new video packet can trigger the
 * finalization of the previous packet. That is not possible if no
 * more video is forthcoming, however. In that case, some other
 * mechanism (like the end of the file) has to be employed. When it is
 * clear that no additional data is forthcoming, calling this method
 * will flush the buffered packets.
 */
flushStreams_() {
  // !!THIS ORDER IS IMPORTANT!!
  // video first then audio
  this.flushStream(this.video, 'video');
  this.flushStream(this.audio, 'audio');
  this.flushStream(this.timedMetadata, 'timed-metadata');
}

flush() {
  this.flushStreams_();
  this.trigger('done');
}
}

var m2ts = {
  PAT_PID: 0x0000,
  MP2T_PACKET_LENGTH: MP2T_PACKET_LENGTH,
  TransportPacketStream: TransportPacketStream,
  TransportParseStream: TransportParseStream,
  ElementaryStream: ElementaryStream,
  TimestampRolloverStream: TimestampRolloverStream,
  CaptionStream: _CaptionStream,
  Cea608Stream: _Cea608Stream,
  MetadataStream: require('./metadata-stream')
};

for (var type in StreamTypes) {
  if (hasOwnProperty(type)) {
    m2ts[type] = StreamTypes[type];
  }
}

export default m2ts;
