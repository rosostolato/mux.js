import Stream from '../utils/stream.js';
import { mdat as _mdat, moof as _moof, initSegment } from '../mp4/mp4-generator.js';
import { trimAdtsFramesByEarliestDts, prefixWithSilence, generateSampleTable, concatenateFrameData } from '../mp4/audio-frame-utils';
import { collectDtsInfo, calculateTrackBaseMediaDecodeTime, clearDtsInfo } from '../mp4/track-decode-info.js';
import { ONE_SECOND_IN_TS } from '../utils/clock';
import { forEach } from '../constants/audio-properties.js';

/**
 * Constructs a single-track, ISO BMFF media segment from AAC data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 */
class AudioSegmentStream extends Stream {
  constructor(track, options = {}) {
    super();

    /** @private */
    this.adtsFrames = [];
    /** @private */
    this.sequenceNumber = 0;
    /** @private */
    this.earliestAllowedDts = 0;
    /** @private */
    this.audioAppendStartTs = 0;
    /** @private */
    this.videoBaseMediaDecodeTime = Infinity;
    /** @private */
    this.segmentStartPts = null;
    /** @private */
    this.segmentEndPts = null;

    /** @private */
    this.track = track;
    /** @private */
    this.options = options;
  }

  push(data) {
    collectDtsInfo(this.track, data);

    if (this.track) {
      forEach(function(prop) {
        this.track[prop] = data[prop];
      });
    }

    // buffer audio data until end() is called
    this.adtsFrames.push(data);
  }

  setEarliestDts(earliestDts) {
    this.earliestAllowedDts = earliestDts;
  }

  setVideoBaseMediaDecodeTime(baseMediaDecodeTime) {
    this.videoBaseMediaDecodeTime = baseMediaDecodeTime;
  }

  setAudioAppendStart(timestamp) {
    this.audioAppendStartTs = timestamp;
  }

  processFrames_() {
    var
      frames,
      moof,
      mdat,
      boxes,
      timingInfo;

    // return early if no audio data has been observed
    if (this.adtsFrames.length === 0) {
      return;
    }

    frames = trimAdtsFramesByEarliestDts(
      this.adtsFrames, this.track, this.earliestAllowedDts);
    if (frames.length === 0) {
      // return early if the frames are all after the earliest allowed DTS
      // TODO should we clear the adtsFrames?
      return;
    }

    this.track.baseMediaDecodeTime = calculateTrackBaseMediaDecodeTime(
      this.track, this.options.keepOriginalTimestamps);

    prefixWithSilence(
      this.track, frames, this.audioAppendStartTs, this.videoBaseMediaDecodeTime);

    // we have to build the index from byte locations to
    // samples (that is, adts frames) in the audio data
    this.track.samples = generateSampleTable(frames);

    // concatenate the audio data to constuct the mdat
    mdat = _mdat(concatenateFrameData(frames));

    this.adtsFrames = [];

    moof = _moof(this.sequenceNumber, [this.track]);

    // bump the sequence number for next time
    this.sequenceNumber++;

    this.track.initSegment = initSegment([this.track]);

    // it would be great to allocate this array up front instead of
    // throwing away hundreds of media segment fragments
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

    boxes.set(moof);
    boxes.set(mdat, moof.byteLength);

    clearDtsInfo(this.track);

    if (this.segmentStartPts === null) {
      this.segmentEndPts = this.segmentStartPts = frames[0].pts;
    }

    this.segmentEndPts += frames.length * (ONE_SECOND_IN_TS * 1024 / this.track.samplerate);

    timingInfo = { start: this.segmentStartPts };

    this.trigger('timingInfo', timingInfo);
    this.trigger('data', { track: this.track, boxes: boxes });
  }

  flush() {
    this.processFrames_();
    // trigger final timing info
    this.trigger('timingInfo', {
      start: this.segmentStartPts,
      end: this.segmentEndPts
    });
    this.resetTiming_();
    this.trigger('done', 'AudioSegmentStream');
  }

  partialFlush() {
    this.processFrames_();
    this.trigger('partialdone', 'AudioSegmentStream');
  }

  endTimeline() {
    this.flush();
    this.trigger('endedtimeline', 'AudioSegmentStream');
  }

  resetTiming_() {
    clearDtsInfo(this.track);
    this.segmentStartPts = null;
    this.segmentEndPts = null;
  }

  reset() {
    this.resetTiming_();
    this.adtsFrames = [];
    this.trigger('reset');
  }
}

export default AudioSegmentStream;
