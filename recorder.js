import store from '@/store';
import Resampler from './Resampler';

const AudioContext = global.AudioContext || global.webkitAudioContext;

class Recorder {
  constructor(config) {
    if (!Recorder.isRecordingSupported()) {
      throw new Error('Recording is not supported in this browser');
    }

    if (!config) config = {};

    this.state = 'inactive';
    this.config = Object.assign({
      bufferLength: 4096,
      encoderApplication: 2049,
      encoderFrameSize: 20,
      encoderPath: 'static/mp3_encoder_work.js',
      opusEncoderPath: 'static/opus_encoder.js',
      encoderSampleRate: 48000,
      maxFramesPerPage: 40,
      mediaTrackConstraints: true,
      numberOfChannels: 1,
      monitorGain: 0,
      recordingGain: store.state.app.recorderVolum,
      resampleQuality: 3,
      streamPages: false,
      reuseWorker: false,
      wavBitDepth: 16,
    }, config);

    this.encodedSamplePosition = 0;
    this.encodedCount = 2; // 编码计数器
    // Callback Handlers
    this.onmp3dataavailable = function () {};
    this.onopusdataavailable = function () {};
    this.onpause = function () {};
    this.onresume = function () {};
    this.onstart = function () {};
    this.onstop = function () {};
  }
  /**
   * 编码buffer
   */
  encodeBuffers = function (inputBuffer) {
    if (this.state === 'recording') {
      const buffers = [];
      for (let i = 0; i < inputBuffer.numberOfChannels; i++) {
        buffers[i] = inputBuffer.getChannelData(i);
      }

      this.encoder.postMessage({
        cmd: 'encode',
        buf: inputBuffer.getChannelData(0),
      });

      this.opusEncoder.postMessage({
        cmd: 'encode',
        buf: this.resampler.resample(inputBuffer.getChannelData(0)),
      });
    }
  };

  /**
   * 初始化 AudioContext
   */
  initAudioContext = function (sourceNode) {
    if (sourceNode && sourceNode.context) {
      this.audioContext = sourceNode.context;
      this.closeAudioContext = false;
    } else {
      // if sourceNode undefind, set sourceNode to this.sourceNode
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.closeAudioContext = true;
      } else {
        this.closeAudioContext = false;
      }
    }

    return this.audioContext;
  };

  initAudioGraph = function () {
    // First buffer can contain old data. Don't encode it.
    // this.encodeBuffers = function () {
    //   delete this.encodeBuffers;
    // };

    this.scriptProcessorNode = this.audioContext.createScriptProcessor(this.config.bufferLength, this.config.numberOfChannels, this.config.numberOfChannels);
    this.scriptProcessorNode.connect(this.audioContext.destination);
    this.scriptProcessorNode.onaudioprocess = (e) => {
      this.encodeBuffers(e.inputBuffer);
    };

    this.monitorGainNode = this.audioContext.createGain();
    this.setMonitorGain(this.config.monitorGain);
    this.monitorGainNode.connect(this.audioContext.destination);

    this.recordingGainNode = this.audioContext.createGain();
    this.setRecordingGain(this.config.recordingGain);
    this.recordingGainNode.connect(this.scriptProcessorNode);
  };

  initSourceNode = function (sourceNode) {
    if (sourceNode && sourceNode.context) {
      return global.Promise.resolve(sourceNode);
    }

    return global.navigator.mediaDevices.getUserMedia({ audio: this.config.mediaTrackConstraints }).then((stream) => {
      this.stream = stream;
      return this.audioContext.createMediaStreamSource(stream);
    })
      .catch((err) => {
      /* 处理error */
        console.log('recorder error: ');
        console.log(err);
        return global.Promise.reject(err);
      });
  };


  setRecordingGain = function (gain) {
    this.config.recordingGain = gain;

    if (this.recordingGainNode && this.audioContext) {
      this.recordingGainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, 0.01);
    }
  };

  setMonitorGain = function (gain) {
    this.config.monitorGain = gain;

    if (this.monitorGainNode && this.audioContext) {
      this.monitorGainNode.gain.setTargetAtTime(gain, this.audioContext.currentTime, 0.01);
    }
  };

  loadWorker = function () {
    if (!this.encoder) {
      this.encoder = new global.Worker(this.config.encoderPath);
    }
    if (!this.opusEncoder) {
      this.opusEncoder = new global.Worker(this.config.opusEncoderPath);
    }
  };
  /**
   * 初始化子线程
   */
  initWorker = function () {
    // const onPage = (this.config.streamPages ? this.streamPage : this.storePage).bind(this);
    this.recordedPages = [];
    this.totalLength = 0;
    this.loadWorker();

    return new Promise((resolve, reject) => {
      const callback = (e) => {
        switch (e.data.cmd) {
          case 'ready':
            // resolve();
            break;
          case 'process':
            console.log('mp3 buf', e.data.buf && e.data.buf.length);
            // this.encodedSamplePosition = e.data.samplePosition;
            // onPage(e.data.page);
            break;
          case 'end':
            var buffers = e.data.buf; // eslint-disable-line
            console.log('mp3 buf:', e.data.buf && e.data.buf.length);
            this.encoder.removeEventListener('message', callback);
            this.finish(buffers);
            break;
          default:
        }
      };

      const opusCallBack = (e) => {
        switch (e.data.cmd) {
          case 'init':
            console.log('opus encoder inited');
            resolve();
            break;
          case 'process':
            // this.encodedSamplePosition = e['data']['samplePosition'];
            // onPage(e['data']['page']);
            console.log('opus buf', e.data.buf && e.data.buf.length);
            break;
          case 'end': {
            this.opusEncoder.removeEventListener('message', opusCallBack);
            const buffer = e.data.buf;  // eslint-disable-line 
            this.opusFinish(buffer);
            // this.opusToFile(blob);
          }
            break;
          case 'destroy':
            break;
          default:
        }
      };

      this.encoder.addEventListener('message', callback);
      this.opusEncoder.addEventListener('message', opusCallBack);
      this.encoder.postMessage({
        cmd: 'init',
        config: {
          sampleRate: this.audioContext.sampleRate,
          bitRate: 16,
        },
      });

      this.opusEncoder.postMessage({
        cmd: 'init',
        config: {
          sampleRate: this.audioContext.sampleRate,
          bitRate: 16,
        },
      });
    });
  };

  /**
   * 开始录音
   */
  start = function (sourceNode) {
    if (this.state === 'inactive') {
      this.initAudioContext(sourceNode);
      this.initAudioGraph();

      this.encodedSamplePosition = 0;
      this.encodedCount = 2;
      this.lastTimeStamp = new Date().getTime();
      this.resampler = new Resampler(this.audioContext.sampleRate, 16000, 1, this.config.bufferLength);

      return Promise.all([this.initSourceNode(sourceNode), this.initWorker()]).then((results) => {
        // eslint-disable-next-line prefer-destructuring
        this.sourceNode = results[0];
        this.state = 'recording';
        this.onstart();
        this.encoder.postMessage({ cmd: 'getHeaderPages' });
        this.sourceNode.connect(this.monitorGainNode);
        this.sourceNode.connect(this.recordingGainNode);
      });
    }
  };

  /**
   * 暂停录音（暂无debug,不能使用）
   */
  pause = function (flush) {
    if (this.state === 'recording') {
      this.state = 'paused';
      // TODO: DEBUG
      if (flush && this.config.streamPages) {
        const encoder = this.encoder; // eslint-disable-line
        return new Promise((resolve, reject) => {
          const callback = (e) => {
            if (e.data.message === 'flushed') {
              encoder.removeEventListener('message', callback);
              this.onpause();
              resolve();
            }
          };
          encoder.addEventListener('message', callback);
          encoder.postMessage({ command: 'flush' });
        });
      }
      this.onpause();
      return Promise.resolve();
    }
  };
  /**
   * 恢复播放
   */
  resume = function () {
    if (this.state === 'paused') {
      this.state = 'recording';
      this.onresume();
    }
  };
  /**
   * 停止录音，并且编码mp3/opus
   */
  stop = function () {
    if (this.state !== 'inactive') {
      this.duration = parseFloat((new Date().getTime() - this.lastTimeStamp) / 1000.0);
      this.state = 'inactive';
      this.monitorGainNode.disconnect();
      this.scriptProcessorNode.disconnect();
      this.recordingGainNode.disconnect();
      this.sourceNode.disconnect();
      this.clearStream();

      const encoder = this.encoder; // eslint-disable-line
      const opusEncoder = this.opusEncoder; // eslint-disable-line
      return new Promise((resolve) => {
        const callback = (e) => {
          if (e.data.message === 'end') {
            encoder.removeEventListener('message', callback);
            resolve();
          }
        };
        const opusCallBack = (e) => {
          if (e.data.message === 'end') {
            encoder.removeEventListener('message', callback);
            // resolve();
          }
        };
        opusEncoder.addEventListener('message', opusCallBack);
        encoder.addEventListener('message', callback);

        encoder.postMessage({ cmd: 'finish' });
        if (!this.config.reuseWorker) {
          encoder.postMessage({ cmd: 'close' });
        }

        opusEncoder.postMessage({
          cmd: 'finish',
        });
        if (!this.config.reuseWorker) {
          opusEncoder.postMessage({ cmd: 'destroy' });
        }
      });
    }
    return Promise.resolve();
  };

  finish = function (dataBuffer) {
    console.log('duration', this.duration);
    this.onmp3dataavailable(dataBuffer, this.duration);

    if (!this.config.reuseWorker) {
      delete this.encoder;
    }
    this.encodedCount--;
    this.checkFinishStop();
  };

  opusFinish = function (buffer) {
    this.onopusdataavailable(buffer);

    if (!this.config.reuseWorker) {
      delete this.opusEncoder;
    }
    this.encodedCount--;
    this.checkFinishStop();
  }

  checkFinishStop = function () {
    if (this.encodedCount === 0) {
      this.onstop();
    }
  }

  clearStream = function () {
    if (this.stream) {
      if (this.stream.getTracks) {
        this.stream.getTracks().forEach((track) => {
          track.stop();
        });
      } else {
        this.stream.stop();
      }

      delete this.stream;
    }

    if (this.audioContext && this.closeAudioContext) {
      this.audioContext.close();
      delete this.audioContext;
    }
  };

  destroyWorker = function () {
    if (this.state === 'inactive') {
      if (this.encoder) {
        this.encoder.postMessage({ cmd: 'close' });
        delete this.encoder;
      }
    }
  };

  setRecordingVolum(volum) {
    this.setRecordingGain(volum);
    store.dispatch('setRecorderVolum', volum);
  }

  static isRecordingSupported = function () {
    return AudioContext && global.navigator && global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia && global.WebAssembly;
  };
}

export default Recorder;
