import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

class TelemetryStore extends EventEmitter {
  private _tokensSlashed = 0;
  private _latency = 0;
  private _modelId = process.env.LLM_MODEL || 'gemini-2.5-flash';
  private _isProcessing = false;
  private _timerInterval: NodeJS.Timeout | null = null;
  private _startTime = 0;

  get tokensSlashed() { return this._tokensSlashed; }
  get latency() { return this._latency; }
  get modelId() { return this._modelId; }
  get isProcessing() { return this._isProcessing; }

  setTokensSlashed(val: number) {
    this._tokensSlashed = val;
    this.emit('change');
  }

  setModelId(val: string) {
    this._modelId = val;
    this.emit('change');
  }

  startTimer() {
    this._isProcessing = true;
    // We only reset the latency counter if it's not already running
    if (!this._timerInterval) {
      this._startTime = performance.now();
      this._latency = 0;
      this.emit('change');

      this._timerInterval = setInterval(() => {
        this._latency = Math.round(performance.now() - this._startTime);
        this.emit('change');
      }, 50); // High resolution live ticker
    }
  }

  stopTimer() {
    this._isProcessing = false;
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
    this._latency = Math.round(performance.now() - this._startTime);
    this.emit('change');
  }
}

export const telemetryStore = new TelemetryStore();
