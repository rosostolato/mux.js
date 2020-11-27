/**
 * Constructs a single-track, ISO BMFF media segment from H264 data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 * @param track {object} track metadata configuration
 * @param options {object} transmuxer options object
 * @param options.alignGopsAtEnd {boolean} If true, start from the end of the
 *        gopsToAlignWith list when attempting to align gop pts
 */
import Stream from '../utils/stream.js';
import { mdat as _mdat, moof as _moof, initSegment } from '../mp4/mp4-generator.js';
import { collectDtsInfo, clearDtsInfo, calculateTrackBaseMediaDecodeTime } from '../mp4/track-decode-info.js';
import {
  groupNalsIntoFrames,
  groupFramesIntoGops,
  extendFirstKeyFrame,
  generateSampleTableForFrame,
  concatenateNalDataForFrame
} from '../mp4/frame-utils';
import { forEach } from '../constants/video-properties.js';

class VideoSegmentStream extends Stream {
  constructor(track, options = {}) {
    super();

    /** @private */
    this.sequenceNumber = 0;
    /** @private */
    this.nalUnits = [];
    /** @private */
    this.frameCache = [];
    /** @private */
    this.segmentStartPts = null;
    /** @private */
    this.segmentEndPts = null;
    /** @private */
    this.ensureNextFrameIsKeyFrame = true;

    /** @private */
    this.track = track;
    /** @private */
    this.options = options;
  }

  push(nalUnit) {
    collectDtsInfo(this.track, nalUnit);
    if (typeof this.track.timelineStartInfo.dts === 'undefined') {
      this.track.timelineStartInfo.dts = nalUnit.dts;
    }

    // record the track config
    if (nalUnit.nalUnitType === 'seq_parameter_set_rbsp' && !this.config) {
      this.config = nalUnit.config;
      this.track.sps = [nalUnit.data];

      forEach(function(prop) {
        this.track[prop] = this.config[prop];
      }, this);
    }

    if (nalUnit.nalUnitType === 'pic_parameter_set_rbsp' &&
      !this.pps) {
      this.pps = nalUnit.data;
      this.track.pps = [nalUnit.data];
    }

    // buffer video until flush() is called
    this.nalUnits.push(nalUnit);
  }

  processNals_(cacheLastFrame) {
    var i;

    this.nalUnits = this.frameCache.concat(this.nalUnits);

    // Throw away nalUnits at the start of the byte stream until
    // we find the first AUD
    while (this.nalUnits.length) {
      if (this.nalUnits[0].nalUnitType === 'access_unit_delimiter_rbsp') {
        break;
      }
      this.nalUnits.shift();
    }

    // Return early if no video data has been observed
    if (this.nalUnits.length === 0) {
      return;
    }

    var frames = groupNalsIntoFrames(this.nalUnits);

    if (!frames.length) {
      return;
    }

    // note that the frame cache may also protect us from cases where we haven't
    // pushed data for the entire first or last frame yet
    this.frameCache = frames[frames.length - 1];

    if (cacheLastFrame) {
      frames.pop();
      frames.duration -= this.frameCache.duration;
      frames.nalCount -= this.frameCache.length;
      frames.byteLength -= this.frameCache.byteLength;
    }

    if (!frames.length) {
      this.nalUnits = [];
      return;
    }

    this.trigger('timelineStartInfo', this.track.timelineStartInfo);

    if (this.ensureNextFrameIsKeyFrame) {
      this.gops = groupFramesIntoGops(frames);

      if (!this.gops[0][0].keyFrame) {
        this.gops = extendFirstKeyFrame(this.gops);

        if (!this.gops[0][0].keyFrame) {
          // we haven't yet gotten a key frame, so reset nal units to wait for more nal
          // units
          this.nalUnits = ([].concat.apply([], frames)).concat(this.frameCache);
          this.frameCache = [];
          return;
        }

        frames = [].concat.apply([], this.gops);
        frames.duration = this.gops.duration;
      }
      this.ensureNextFrameIsKeyFrame = false;
    }

    if (this.segmentStartPts === null) {
      this.segmentStartPts = frames[0].pts;
      this.segmentEndPts = this.segmentStartPts;
    }

    this.segmentEndPts += frames.duration;

    this.trigger('timingInfo', {
      start: this.segmentStartPts,
      end: this.segmentEndPts
    });

    for (i = 0; i < frames.length; i++) {
      var frame = frames[i];

      this.track.samples = generateSampleTableForFrame(frame);

      var mdat = _mdat(concatenateNalDataForFrame(frame));

      clearDtsInfo(this.track);
      collectDtsInfo(this.track, frame);

      this.track.baseMediaDecodeTime = calculateTrackBaseMediaDecodeTime(
        this.track, this.options.keepOriginalTimestamps);

      var moof = _moof(this.sequenceNumber, [this.track]);

      this.sequenceNumber++;

      this.track.initSegment = initSegment([this.track]);

      var boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

      boxes.set(moof);
      boxes.set(mdat, moof.byteLength);

      this.trigger('data', {
        track: this.track,
        boxes: boxes,
        sequence: this.sequenceNumber,
        videoFrameDts: frame.dts,
        videoFramePts: frame.pts
      });
    }

    this.nalUnits = [];
  }

  resetTimingAndConfig_() {
    this.config = undefined;
    this.pps = undefined;
    this.segmentStartPts = null;
    this.segmentEndPts = null;
  }

  partialFlush() {
    this.processNals_(true);
    this.trigger('partialdone', 'VideoSegmentStream');
  }

  flush() {
    this.processNals_(false);
    // reset config and pps because they may differ across segments
    // for instance, when we are rendition switching
    this.resetTimingAndConfig_();
    this.trigger('done', 'VideoSegmentStream');
  }

  endTimeline() {
    this.flush();
    this.trigger('endedtimeline', 'VideoSegmentStream');
  }

  reset() {
    this.resetTimingAndConfig_();
    this.frameCache = [];
    this.nalUnits = [];
    this.ensureNextFrameIsKeyFrame = true;
    this.trigger('reset');
  }
}

export default VideoSegmentStream;
