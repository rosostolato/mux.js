import Stream from '../utils/stream.js';
import { TransportPacketStream, TransportParseStream, ElementaryStream, TimestampRolloverStream, CaptionStream, MetadataStream } from '../m2ts/m2ts.js';
import { Adts, h264 as _h264 } from '../codecs/index.js';
import AudioSegmentStream from './audio-segment-stream.js';
import VideoSegmentStream from './video-segment-stream.js';
import { clearDtsInfo } from '../mp4/track-decode-info.js';
import { isLikelyAacData } from '../aac/utils';
import AdtsStream from '../codecs/adts';
import AacStream from '../aac/index';
import { metadataTsToSeconds, videoTsToSeconds } from '../utils/clock';

var createPipeline = function(object) {
  object.prototype = new Stream();
  object.prototype.init.call(object);

  return object;
};

var tsPipeline = function(options) {
  var
    pipeline = {
      type: 'ts',
      tracks: {
        audio: null,
        video: null
      },
      packet: new TransportPacketStream(),
      parse: new TransportParseStream(),
      elementary: new ElementaryStream(),
      timestampRollover: new TimestampRolloverStream(),
      adts: new Adts(),
      h264: new _h264.H264Stream(),
      captionStream: new CaptionStream(),
      metadataStream: new MetadataStream()
  };

  pipeline.headOfPipeline = pipeline.packet;

  // Transport Stream
  pipeline.packet
    .pipe(pipeline.parse)
    .pipe(pipeline.elementary)
    .pipe(pipeline.timestampRollover);

  // H264
  pipeline.timestampRollover
    .pipe(pipeline.h264);

  // Hook up CEA-608/708 caption stream
  pipeline.h264
    .pipe(pipeline.captionStream);

  pipeline.timestampRollover
    .pipe(pipeline.metadataStream);

  // ADTS
  pipeline.timestampRollover
    .pipe(pipeline.adts);

  pipeline.elementary.on('data', function(data) {
    if (data.type !== 'metadata') {
      return;
    }

    for (var i = 0; i < data.tracks.length; i++) {
      if (!pipeline.tracks[data.tracks[i].type]) {
        pipeline.tracks[data.tracks[i].type] = data.tracks[i];
        pipeline.tracks[data.tracks[i].type].timelineStartInfo.baseMediaDecodeTime = options.baseMediaDecodeTime;
      }
    }

    if (pipeline.tracks.video && !pipeline.videoSegmentStream) {
      pipeline.videoSegmentStream = new VideoSegmentStream(pipeline.tracks.video, options);

      pipeline.videoSegmentStream.on('timelineStartInfo', function(timelineStartInfo) {
        if (pipeline.tracks.audio && !options.keepOriginalTimestamps) {
          pipeline.audioSegmentStream.setEarliestDts(timelineStartInfo.dts - options.baseMediaDecodeTime);
        }
      });

      pipeline.videoSegmentStream.on('timingInfo',
                                     pipeline.trigger.bind(pipeline, 'videoTimingInfo'));

      pipeline.videoSegmentStream.on('data', function(data) {
        pipeline.trigger('data', {
          type: 'video',
          data: data
        });
      });

      pipeline.videoSegmentStream.on('done',
                                     pipeline.trigger.bind(pipeline, 'done'));
      pipeline.videoSegmentStream.on('partialdone',
                                     pipeline.trigger.bind(pipeline, 'partialdone'));
      pipeline.videoSegmentStream.on('endedtimeline',
                                     pipeline.trigger.bind(pipeline, 'endedtimeline'));

      pipeline.h264
        .pipe(pipeline.videoSegmentStream);
    }

    if (pipeline.tracks.audio && !pipeline.audioSegmentStream) {
      pipeline.audioSegmentStream = new AudioSegmentStream(pipeline.tracks.audio, options);

      pipeline.audioSegmentStream.on('data', function(data) {
        pipeline.trigger('data', {
          type: 'audio',
          data: data
        });
      });

      pipeline.audioSegmentStream.on('done',
                                     pipeline.trigger.bind(pipeline, 'done'));
      pipeline.audioSegmentStream.on('partialdone',
                                     pipeline.trigger.bind(pipeline, 'partialdone'));
      pipeline.audioSegmentStream.on('endedtimeline',
                                     pipeline.trigger.bind(pipeline, 'endedtimeline'));

      pipeline.audioSegmentStream.on('timingInfo',
                                     pipeline.trigger.bind(pipeline, 'audioTimingInfo'));

      pipeline.adts
        .pipe(pipeline.audioSegmentStream);
    }

    // emit pmt info
    pipeline.trigger('trackinfo', {
      hasAudio: !!pipeline.tracks.audio,
      hasVideo: !!pipeline.tracks.video
    });
  });

  pipeline.captionStream.on('data', function(caption) {
    var timelineStartPts;

    if (pipeline.tracks.video) {
      timelineStartPts = pipeline.tracks.video.timelineStartInfo.pts || 0;
    } else {
      // This will only happen if we encounter caption packets before
      // video data in a segment. This is an unusual/unlikely scenario,
      // so we assume the timeline starts at zero for now.
      timelineStartPts = 0;
    }

    // Translate caption PTS times into second offsets into the
    // video timeline for the segment
    caption.startTime = metadataTsToSeconds(caption.startPts, timelineStartPts, options.keepOriginalTimestamps);
    caption.endTime = metadataTsToSeconds(caption.endPts, timelineStartPts, options.keepOriginalTimestamps);

    pipeline.trigger('caption', caption);
  });

  pipeline = createPipeline(pipeline);

  pipeline.metadataStream.on('data', pipeline.trigger.bind(pipeline, 'id3Frame'));

  return pipeline;
};

var aacPipeline = function(options) {
  var
    pipeline = {
    type: 'aac',
    tracks: {
      audio: null
    },
    metadataStream: new MetadataStream(),
    aacStream: new AacStream(),
    audioRollover: new TimestampRolloverStream('audio'),
    timedMetadataRollover: new TimestampRolloverStream('timed-metadata'),
    adtsStream: new AdtsStream(true)
  };

  // set up the parsing pipeline
  pipeline.headOfPipeline = pipeline.aacStream;

  pipeline.aacStream
    .pipe(pipeline.audioRollover)
    .pipe(pipeline.adtsStream);
  pipeline.aacStream
    .pipe(pipeline.timedMetadataRollover)
    .pipe(pipeline.metadataStream);

  pipeline.metadataStream.on('timestamp', function(frame) {
    pipeline.aacStream.setTimestamp(frame.timeStamp);
  });

  pipeline.aacStream.on('data', function(data) {
    if ((data.type !== 'timed-metadata' && data.type !== 'audio') || pipeline.audioSegmentStream) {
      return;
    }

    pipeline.tracks.audio = pipeline.tracks.audio || {
      timelineStartInfo: {
        baseMediaDecodeTime: options.baseMediaDecodeTime
      },
      codec: 'adts',
      type: 'audio'
    };

    // hook up the audio segment stream to the first track with aac data
    pipeline.audioSegmentStream = new AudioSegmentStream(pipeline.tracks.audio, options);

    pipeline.audioSegmentStream.on('data', function(data) {
      pipeline.trigger('data', {
        type: 'audio',
        data: data
      });
    });

    pipeline.audioSegmentStream.on('partialdone',
                                   pipeline.trigger.bind(pipeline, 'partialdone'));
    pipeline.audioSegmentStream.on('done', pipeline.trigger.bind(pipeline, 'done'));
    pipeline.audioSegmentStream.on('endedtimeline',
                                   pipeline.trigger.bind(pipeline, 'endedtimeline'));
    pipeline.audioSegmentStream.on('timingInfo',
                                   pipeline.trigger.bind(pipeline, 'audioTimingInfo'));

    // Set up the final part of the audio pipeline
    pipeline.adtsStream
      .pipe(pipeline.audioSegmentStream);

    pipeline.trigger('trackinfo', {
      hasAudio: !!pipeline.tracks.audio,
      hasVideo: !!pipeline.tracks.video
    });
  });

  // set the pipeline up as a stream before binding to get access to the trigger function
  pipeline = createPipeline(pipeline);

  pipeline.metadataStream.on('data', pipeline.trigger.bind(pipeline, 'id3Frame'));

  return pipeline;
};

var setupPipelineListeners = function(pipeline, transmuxer) {
  pipeline.on('data', transmuxer.trigger.bind(transmuxer, 'data'));
  pipeline.on('done', transmuxer.trigger.bind(transmuxer, 'done'));
  pipeline.on('partialdone', transmuxer.trigger.bind(transmuxer, 'partialdone'));
  pipeline.on('endedtimeline', transmuxer.trigger.bind(transmuxer, 'endedtimeline'));
  pipeline.on('audioTimingInfo', transmuxer.trigger.bind(transmuxer, 'audioTimingInfo'));
  pipeline.on('videoTimingInfo', transmuxer.trigger.bind(transmuxer, 'videoTimingInfo'));
  pipeline.on('trackinfo', transmuxer.trigger.bind(transmuxer, 'trackinfo'));
  pipeline.on('id3Frame', function(event) {
    // add this to every single emitted segment even though it's only needed for the first
    event.dispatchType = pipeline.metadataStream.dispatchType;
    // keep original time, can be adjusted if needed at a higher level
    event.cueTime = videoTsToSeconds(event.pts);

    transmuxer.trigger('id3Frame', event);
  });
  pipeline.on('caption', function(event) {
    transmuxer.trigger('caption', event);
  });
};

class Transmuxer extends Stream {
  constructor(options = {}) {
    super();

    /** @private */
    this.pipeline = null;
    /** @private */
    this.hasFlushed = true;
    /** @private */
    this.options = options;

    this.options.baseMediaDecodeTime = this.options.baseMediaDecodeTime || 0;
  }

  push(bytes) {
    if (this.hasFlushed) {
      var isAac = isLikelyAacData(bytes);

      if (isAac && (!this.pipeline || this.pipeline.type !== 'aac')) {
        this.pipeline = aacPipeline(this.options);
        setupPipelineListeners(this.pipeline, this);
      } else if (!isAac && (!this.pipeline || this.pipeline.type !== 'ts')) {
        this.pipeline = tsPipeline(this.options);
        setupPipelineListeners(this.pipeline, this);
      }
      this.hasFlushed = false;
    }

    this.pipeline.headOfPipeline.push(bytes);
  }

  flush() {
    if (!this.pipeline) {
      return;
    }

    this.hasFlushed = true;
    this.pipeline.headOfPipeline.flush();
  }

  partialFlush() {
    if (!this.pipeline) {
      return;
    }

    this.pipeline.headOfPipeline.partialFlush();
  }

  endTimeline() {
    if (!this.pipeline) {
      return;
    }

    this.pipeline.headOfPipeline.endTimeline();
  }

  reset() {
    if (!this.pipeline) {
      return;
    }

    this.pipeline.headOfPipeline.reset();
  }

  setBaseMediaDecodeTime(baseMediaDecodeTime) {
    if (!this.options.keepOriginalTimestamps) {
      this.options.baseMediaDecodeTime = baseMediaDecodeTime;
    }

    if (!this.pipeline) {
      return;
    }

    if (this.pipeline.tracks.audio) {
      this.pipeline.tracks.audio.timelineStartInfo.dts = undefined;
      this.pipeline.tracks.audio.timelineStartInfo.pts = undefined;
      clearDtsInfo(this.pipeline.tracks.audio);
      if (this.pipeline.audioRollover) {
        this.pipeline.audioRollover.discontinuity();
      }
    }
    if (this.pipeline.tracks.video) {
      if (this.pipeline.videoSegmentStream) {
        this.pipeline.videoSegmentStream.gopCache_ = [];
      }
      this.pipeline.tracks.video.timelineStartInfo.dts = undefined;
      this.pipeline.tracks.video.timelineStartInfo.pts = undefined;
      clearDtsInfo(this.pipeline.tracks.video);
      // pipeline.captionStream.reset();
    }

    if (this.pipeline.timestampRollover) {
      this.pipeline.timestampRollover.discontinuity();

    }
  }

  setRemux(val) {
    this.options.remux = val;

    if (this.pipeline && this.pipeline.coalesceStream) {
      this.pipeline.coalesceStream.setRemux(val);
    }
  }


  setAudioAppendStart(audioAppendStart) {
    if (!this.pipeline || !this.pipeline.tracks.audio || !this.pipeline.audioSegmentStream) {
      return;
    }

    this.pipeline.audioSegmentStream.setAudioAppendStart(audioAppendStart);
  }

  // TODO GOP alignment support
  // Support may be a bit trickier than with full segment appends, as GOPs may be split
  // and processed in a more granular fashion
  alignGopsWith(gopsToAlignWith) {
    return;
  }
}

export default Transmuxer;
