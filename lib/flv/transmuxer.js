/**
 * mux.js
 *
 * Copyright (c) Brightcove
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 */
import Stream from '../utils/stream.js';
import FlvTag, { METADATA_TAG, VIDEO_TAG, AUDIO_TAG } from './flv-tag.js';
import {
  MetadataStream,
  TransportPacketStream,
  TransportParseStream,
  ElementaryStream,
  TimestampRolloverStream,
  CaptionStream
} from '../m2ts/m2ts.js';
import AdtsStream from '../codecs/adts.js';
import { H264Stream } from '../codecs/h264';
import CoalesceStream from './coalesce-stream.js';
import TagList from './tag-list.js';

/**
 * Store information about the start and end of the tracka and the
 * duration for each frame/sample we process in order to calculate
 * the baseMediaDecodeTime
 */
var collectTimelineInfo = function(track, data) {
  if (typeof data.pts === 'number') {
    if (track.timelineStartInfo.pts === undefined) {
      track.timelineStartInfo.pts = data.pts;
    } else {
      track.timelineStartInfo.pts =
        Math.min(track.timelineStartInfo.pts, data.pts);
    }
  }

  if (typeof data.dts === 'number') {
    if (track.timelineStartInfo.dts === undefined) {
      track.timelineStartInfo.dts = data.dts;
    } else {
      track.timelineStartInfo.dts =
        Math.min(track.timelineStartInfo.dts, data.dts);
    }
  }
};

var metaDataTag = function(track, pts) {
  var
    tag = new FlvTag(METADATA_TAG); // :FlvTag

  tag.dts = pts;
  tag.pts = pts;

  tag.writeMetaDataDouble('videocodecid', 7);
  tag.writeMetaDataDouble('width', track.width);
  tag.writeMetaDataDouble('height', track.height);

  return tag;
};

var extraDataTag = function(track, pts) {
  var
    i,
    tag = new FlvTag(VIDEO_TAG, true);

  tag.dts = pts;
  tag.pts = pts;

  tag.writeByte(0x01);// version
  tag.writeByte(track.profileIdc);// profile
  tag.writeByte(track.profileCompatibility);// compatibility
  tag.writeByte(track.levelIdc);// level
  tag.writeByte(0xFC | 0x03); // reserved (6 bits), NULA length size - 1 (2 bits)
  tag.writeByte(0xE0 | 0x01); // reserved (3 bits), num of SPS (5 bits)
  tag.writeShort(track.sps[0].length); // data of SPS
  tag.writeBytes(track.sps[0]); // SPS

  tag.writeByte(track.pps.length); // num of PPS (will there ever be more that 1 PPS?)
  for (i = 0; i < track.pps.length; ++i) {
    tag.writeShort(track.pps[i].length); // 2 bytes for length of PPS
    tag.writeBytes(track.pps[i]); // data of PPS
  }

  return tag;
};

/**
 * Constructs a single-track, media segment from AAC data
 * events. The output of this stream can be fed to flash.
 */
class AudioSegmentStream extends Stream {
  constructor(track) {
    super();
    /** @private */
    this.track = track;
    /** @private */
    this.adtsFrames = [];
    /** @private */
    this.videoKeyFrames = [];
  }

  push(data) {
    collectTimelineInfo(this.track, data);

    if (this.track) {
      this.track.audioobjecttype = data.audioobjecttype;
      this.track.channelcount = data.channelcount;
      this.track.samplerate = data.samplerate;
      this.track.samplingfrequencyindex = data.samplingfrequencyindex;
      this.track.samplesize = data.samplesize;
      this.track.extraData = (this.track.audioobjecttype << 11) |
        (this.track.samplingfrequencyindex << 7) |
        (this.track.channelcount << 3);
    }

    data.pts = Math.round(data.pts / 90);
    data.dts = Math.round(data.dts / 90);

    // buffer audio data until end() is called
    this.adtsFrames.push(data);
  }

  flush() {
    var currentFrame, adtsFrame, lastMetaPts, tags = new TagList();
    // return early if no audio data has been observed
    if (this.adtsFrames.length === 0) {
      this.trigger('done', 'AudioSegmentStream');
      return;
    }

    lastMetaPts = -Infinity;

    while (this.adtsFrames.length) {
      currentFrame = this.adtsFrames.shift();

      // write out a metadata frame at every video key frame
      if (this.videoKeyFrames.length && currentFrame.pts >= this.videoKeyFrames[0]) {
        lastMetaPts = this.videoKeyFrames.shift();
        this.writeMetaDataTags(tags, lastMetaPts);
      }

      // also write out metadata tags every 1 second so that the decoder
      // is re-initialized quickly after seeking into a different
      // audio configuration.
      if (this.track.extraData !== this.oldExtraData || currentFrame.pts - lastMetaPts >= 1000) {
        this.writeMetaDataTags(tags, currentFrame.pts);
        this.oldExtraData = this.track.extraData;
        lastMetaPts = currentFrame.pts;
      }

      adtsFrame = new FlvTag(AUDIO_TAG);
      adtsFrame.pts = currentFrame.pts;
      adtsFrame.dts = currentFrame.dts;

      adtsFrame.writeBytes(currentFrame.data);

      tags.push(adtsFrame.finalize());
    }

    this.videoKeyFrames.length = 0;
    this.oldExtraData = null;
    this.trigger('data', { track: this.track, tags: tags.list });

    this.trigger('done', 'AudioSegmentStream');
  }

  writeMetaDataTags(tags, pts) {
    var adtsFrame;

    adtsFrame = new FlvTag(METADATA_TAG);
    // For audio, DTS is always the same as PTS. We want to set the DTS
    // however so we can compare with video DTS to determine approximate
    // packet order
    adtsFrame.pts = pts;
    adtsFrame.dts = pts;

    // AAC is always 10
    adtsFrame.writeMetaDataDouble('audiocodecid', 10);
    adtsFrame.writeMetaDataBoolean('stereo', this.track.channelcount === 2);
    adtsFrame.writeMetaDataDouble('audiosamplerate', this.track.samplerate);
    // Is AAC always 16 bit?
    adtsFrame.writeMetaDataDouble('audiosamplesize', 16);

    tags.push(adtsFrame.finalize());

    adtsFrame = new FlvTag(AUDIO_TAG, true);
    // For audio, DTS is always the same as PTS. We want to set the DTS
    // however so we can compare with video DTS to determine approximate
    // packet order
    adtsFrame.pts = pts;
    adtsFrame.dts = pts;

    adtsFrame.view.setUint16(adtsFrame.position, this.track.extraData);
    adtsFrame.position += 2;
    adtsFrame.length = Math.max(adtsFrame.length, adtsFrame.position);

    tags.push(adtsFrame.finalize());
  }

  onVideoKeyFrame(pts) {
    this.videoKeyFrames.push(pts);
  }
}

/**
 * Store FlvTags for the h264 stream
 * @param track {object} track metadata configuration
 */
class VideoSegmentStream extends Stream {
  constructor(track) {
    super();
    /** @private */
    this.track = track;
    /** @private */
    this.nalUnits = [];
  }

  finishFrame(tags, frame) {
    if (!frame) {
      return;
    }
    // Check if keyframe and the length of tags.
    // This makes sure we write metadata on the first frame of a segment.
    if (this.config && this.track && this.track.newMetadata &&
      (frame.keyFrame || tags.length === 0)) {
      // Push extra data on every IDR frame in case we did a stream change + seek
      var metaTag = metaDataTag(this.config, frame.dts).finalize();
      var extraTag = extraDataTag(this.track, frame.dts).finalize();

      metaTag.metaDataTag = extraTag.metaDataTag = true;

      tags.push(metaTag);
      tags.push(extraTag);
      this.track.newMetadata = false;

      this.trigger('keyframe', frame.dts);
    }

    frame.endNalUnit();
    tags.push(frame.finalize());
    this.h264Frame = null;
  }

  push(data) {
    collectTimelineInfo(this.track, data);

    data.pts = Math.round(data.pts / 90);
    data.dts = Math.round(data.dts / 90);

    // buffer video until flush() is called
    this.nalUnits.push(data);
  }

  flush() {
    var
      currentNal,
      tags = new TagList();

    // Throw away nalUnits at the start of the byte stream until we find
    // the first AUD
    while (this.nalUnits.length) {
      if (this.nalUnits[0].nalUnitType === 'access_unit_delimiter_rbsp') {
        break;
      }
      this.nalUnits.shift();
    }

    // return early if no video data has been observed
    if (this.nalUnits.length === 0) {
      this.trigger('done', 'VideoSegmentStream');
      return;
    }

    while (this.nalUnits.length) {
      currentNal = this.nalUnits.shift();

      // record the track config
      if (currentNal.nalUnitType === 'seq_parameter_set_rbsp') {
        this.track.newMetadata = true;
        this.config = currentNal.config;
        this.track.width = this.config.width;
        this.track.height = this.config.height;
        this.track.sps = [currentNal.data];
        this.track.profileIdc = this.config.profileIdc;
        this.track.levelIdc = this.config.levelIdc;
        this.track.profileCompatibility = this.config.profileCompatibility;
        this.h264Frame.endNalUnit();
      } else if (currentNal.nalUnitType === 'pic_parameter_set_rbsp') {
        this.track.newMetadata = true;
        this.track.pps = [currentNal.data];
        this.h264Frame.endNalUnit();
      } else if (currentNal.nalUnitType === 'access_unit_delimiter_rbsp') {
        if (this.h264Frame) {
          this.finishFrame(tags, this.h264Frame);
        }
        this.h264Frame = new FlvTag(VIDEO_TAG);
        this.h264Frame.pts = currentNal.pts;
        this.h264Frame.dts = currentNal.dts;
      } else {
        if (currentNal.nalUnitType === 'slice_layer_without_partitioning_rbsp_idr') {
          // the current sample is a key frame
          this.h264Frame.keyFrame = true;
        }
        this.h264Frame.endNalUnit();
      }
      this.h264Frame.startNalUnit();
      this.h264Frame.writeBytes(currentNal.data);
    }
    if (this.h264Frame) {
      this.finishFrame(tags, this.h264Frame);
    }

    this.trigger('data', { track: this.track, tags: tags.list });

    // Continue with the flush process now
    this.trigger('done', 'VideoSegmentStream');
  }
}

/**
 * An object that incrementally transmuxes MPEG2 Trasport Stream
 * chunks into an FLV.
 */
class Transmuxer extends Stream {
  constructor(options) {
    super();
    /** @private */
    this.options = options || {};

    // expose the metadata stream
    /** @private */
    this.metadataStream = new MetadataStream();

    /** @private */
    this.options.metadataStream = this.metadataStream;

    // set up the parsing pipeline
    /** @private */
    this.packetStream = new TransportPacketStream();
    /** @private */
    this.parseStream = new TransportParseStream();
    /** @private */
    this.elementaryStream = new ElementaryStream();
    /** @private */
    this.videoTimestampRolloverStream = new TimestampRolloverStream('video');
    /** @private */
    this.audioTimestampRolloverStream = new TimestampRolloverStream('audio');
    /** @private */
    this.timedMetadataTimestampRolloverStream = new TimestampRolloverStream('timed-metadata');

    /** @private */
    this.adtsStream = new AdtsStream();
    /** @private */
    this.h264Stream = new H264Stream();
    /** @private */
    this.coalesceStream = new CoalesceStream(this.options);

    // disassemble MPEG2-TS packets into elementary streams
    this.packetStream
      .pipe(this.parseStream)
      .pipe(this.elementaryStream);

    // !!THIS ORDER IS IMPORTANT!!
    // demux the streams
    this.elementaryStream
      .pipe(this.videoTimestampRolloverStream)
      .pipe(this.h264Stream);
    this.elementaryStream
      .pipe(this.audioTimestampRolloverStream)
      .pipe(this.adtsStream);

    this.elementaryStream
      .pipe(this.timedMetadataTimestampRolloverStream)
      .pipe(this.metadataStream)
      .pipe(this.coalesceStream);
    // if CEA-708 parsing is available, hook up a caption stream
    this.captionStream = new CaptionStream();
    this.h264Stream.pipe(this.captionStream)
      .pipe(this.coalesceStream);

    // hook up the segment streams once track metadata is delivered
    this.elementaryStream.on('data', function(data) {
      var i, videoTrack, audioTrack;

      if (data.type === 'metadata') {
        i = data.tracks.length;

        // scan the tracks listed in the metadata
        while (i--) {
          if (data.tracks[i].type === 'video') {
            videoTrack = data.tracks[i];
          } else if (data.tracks[i].type === 'audio') {
            audioTrack = data.tracks[i];
          }
        }

        // hook up the video segment stream to the first track with h264 data
        if (videoTrack && !this.videoSegmentStream) {
          this.coalesceStream.numberOfTracks++;
          this.videoSegmentStream = new VideoSegmentStream(videoTrack);

          // Set up the final part of the video pipeline
          this.h264Stream
            .pipe(this.videoSegmentStream)
            .pipe(this.coalesceStream);
        }

        if (audioTrack && !this.audioSegmentStream) {
          // hook up the audio segment stream to the first track with aac data
          this.coalesceStream.numberOfTracks++;
          this.audioSegmentStream = new AudioSegmentStream(audioTrack);

          // Set up the final part of the audio pipeline
          this.adtsStream
            .pipe(this.audioSegmentStream)
            .pipe(this.coalesceStream);

          if (this.videoSegmentStream) {
            this.videoSegmentStream.on('keyframe', this.audioSegmentStream.onVideoKeyFrame);
          }
        }
      }
    });

    // Re-emit any data coming from the coalesce stream to the outside world
    this.coalesceStream.on('data', function(event) {
      this.trigger('data', event);
    });

    // Let the consumer know we have finished flushing the entire pipeline
    this.coalesceStream.on('done', function() {
      this.trigger('done');
    });
  }

  // feed incoming data to the front of the parsing pipeline
  push(data) {
    this.packetStream.push(data);
  }

  // flush any buffered data
  flush() {
    // Start at the top of the pipeline and flush all pending work
    this.packetStream.flush();
  }

  // Caption data has to be reset when seeking outside buffered range
  resetCaptions() {
    this.captionStream.reset();
  }
}

// forward compatibility
export default Transmuxer;
